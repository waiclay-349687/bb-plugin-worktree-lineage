import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { chatCompletionsUrl, parseRetryAfter, rateLimitCooldownMs, runGateway } from "../lib/model-run";

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

let server: Server | null = null;

/** 在随机端口起一个假网关，返回它的根地址 */
async function fakeGateway(handler: Handler): Promise<string> {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => handler(req, body, res));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
};
const completion = (content: unknown) => ({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content, reasoning_content: "思考过程" } }] });

afterEach(async () => {
  const current = server;
  server = null;
  if (current) {
    current.closeAllConnections();
    await new Promise<void>((resolve) => current.close(() => resolve()));
  }
});

const MODEL = "provider/some-model";

describe("chatCompletionsUrl", () => {
  it("根地址、尾斜杠、已带 /v1 都指向同一个接口", () => {
    expect(chatCompletionsUrl("http://127.0.0.1:3425")).toBe("http://127.0.0.1:3425/v1/chat/completions");
    expect(chatCompletionsUrl("http://127.0.0.1:3425/")).toBe("http://127.0.0.1:3425/v1/chat/completions");
    expect(chatCompletionsUrl(" http://127.0.0.1:3425/v1/ ")).toBe("http://127.0.0.1:3425/v1/chat/completions");
  });
});

describe("runGateway", () => {
  it("按 OpenAI 兼容格式发请求，取 message.content 作为正文", async () => {
    let seen: { url?: string; method?: string; body?: Record<string, unknown> } = {};
    const base = await fakeGateway((req, body, res) => {
      seen = { url: req.url, method: req.method, body: JSON.parse(body) };
      json(res, 200, completion('{"about":"x"}'));
    });
    const result = await runGateway({ via: "gateway", baseUrl: base, model: MODEL }, "系统提示词", "提要");
    expect(result).toMatchObject({ status: "ok", text: '{"about":"x"}', costUsd: null });
    expect(seen.url).toBe("/v1/chat/completions");
    expect(seen.method).toBe("POST");
    expect(seen.body).toMatchObject({
      model: MODEL,
      stream: false,
      reasoning_effort: "low",
      messages: [
        { role: "system", content: "系统提示词" },
        { role: "user", content: "提要" },
      ],
    });
  });

  it("正文里夹着的 <think> 块会被去掉", async () => {
    const base = await fakeGateway((_req, _body, res) => json(res, 200, completion('<think>先想想 {不是答案}</think>\n{"about":"x"}')));
    const result = await runGateway({ via: "gateway", baseUrl: base, model: MODEL }, "s", "p");
    expect(result).toMatchObject({ status: "ok", text: '{"about":"x"}' });
  });

  it("429（如免费额度用完）返回 failed，带上网关的错误信息和按 Retry-After 算的模型级冷却", async () => {
    const base = await fakeGateway((_req, _body, res) => json(res, 429, { error: { message: "Free usage limit reached", type: "rate_limit_error" } }, { "retry-after": "3595" }));
    const result = await runGateway({ via: "gateway", baseUrl: base, model: MODEL }, "s", "p");
    expect(result).toEqual({ status: "failed", message: "网关 HTTP 429: Free usage limit reached", cooldown: { scope: "model", ms: 3_595_000 } });
  });

  it("429 没带 Retry-After：默认冷却 15 分钟", async () => {
    const base = await fakeGateway((_req, _body, res) => json(res, 429, { error: { message: "slow down" } }));
    const result = await runGateway({ via: "gateway", baseUrl: base, model: MODEL }, "s", "p");
    expect(result).toMatchObject({ status: "failed", cooldown: { scope: "model", ms: 15 * 60_000 } });
  });

  it("其他非 2xx 返回 failed，不建议冷却", async () => {
    const base = await fakeGateway((_req, _body, res) => json(res, 404, { error: { message: "magpie knows no model" } }));
    const result = await runGateway({ via: "gateway", baseUrl: base, model: MODEL }, "s", "p");
    expect(result).toEqual({ status: "failed", message: "网关 HTTP 404: magpie knows no model" });
  });

  it("2xx 但没有正文返回 failed", async () => {
    const base = await fakeGateway((_req, _body, res) => json(res, 200, completion(null)));
    expect(await runGateway({ via: "gateway", baseUrl: base, model: MODEL }, "s", "p")).toEqual({ status: "failed", message: "网关没有返回正文" });
  });

  it("2xx 但响应不是 JSON 返回 failed", async () => {
    const base = await fakeGateway((_req, _body, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>oops</html>");
    });
    const result = await runGateway({ via: "gateway", baseUrl: base, model: MODEL }, "s", "p");
    expect(result).toMatchObject({ status: "failed" });
    expect(result.status === "failed" && result.message).toContain("不是 JSON");
  });

  it("网关一直不回应时按超时返回 failed，不会挂住", async () => {
    const base = await fakeGateway(() => undefined);
    const started = Date.now();
    const result = await runGateway({ via: "gateway", baseUrl: base, model: MODEL }, "s", "p", 150);
    expect(result).toEqual({ status: "failed", message: "网关超时（0s）" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("连不上（端口没人监听）返回 failed，原因是 ECONNREFUSED，附网关级 60 秒短冷却", async () => {
    const base = await fakeGateway(() => undefined);
    const current = server!;
    server = null;
    await new Promise<void>((resolve) => current.close(() => resolve()));
    const result = await runGateway({ via: "gateway", baseUrl: base, model: MODEL }, "s", "p");
    expect(result).toEqual({ status: "failed", message: "网关连不上: ECONNREFUSED", cooldown: { scope: "gateway", ms: 60_000 } });
  });
});

describe("Retry-After", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  it("秒数写法", () => {
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
  });
  it("HTTP 日期写法；已过去的日期按 0 算", () => {
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:30:00 GMT", now)).toBe(30 * 60_000);
    expect(parseRetryAfter("Wed, 31 Dec 2025 23:00:00 GMT", now)).toBe(0);
  });
  it("缺失或写错返回 null", () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("", now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter("-5", now)).toBeNull();
  });
  it("冷却时长：缺省 15 分钟，最多 2 小时", () => {
    expect(rateLimitCooldownMs(null, now)).toBe(15 * 60_000);
    expect(rateLimitCooldownMs("garbage", now)).toBe(15 * 60_000);
    expect(rateLimitCooldownMs("3595", now)).toBe(3_595_000);
    expect(rateLimitCooldownMs("86400", now)).toBe(2 * 60 * 60_000);
  });
});
