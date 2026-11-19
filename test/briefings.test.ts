import { describe, expect, it } from "vitest";
import { generateBriefing, parseModelList, type BriefingSettings, type CallModel, type CooldownTable } from "../briefings";
import type { ModelRoute } from "../lib/contract";
import type { ModelRunResult } from "../lib/model-run";

const VALID = JSON.stringify({
  about: "给侧边栏加分支视图",
  stages: [{ title: "分支树视图", state: "done", note: "已完成并通过测试" }],
  now: "等你验收",
  waiting: null,
  next: null,
});

const BASE = "http://127.0.0.1:3425";
const PRIMARY = "provider-a/model-a";
const SECONDARY = "provider-b/model-b-free";
const chain: Pick<BriefingSettings, "model" | "gateway"> = { model: "haiku", gateway: { baseUrl: BASE, models: [PRIMARY, SECONDARY] } };
const request = { system: "系统提示词", prompt: "提要" };

type Response = ModelRunResult | Error;
const routeName = (route: ModelRoute) => (route.via === "gateway" ? route.model : `claude:${route.model}`);

/** 按“网关模型 id / claude:<模型>”返回预设结果；同一键可以给一串结果，按调用次序依次取 */
function fakeCallModel(responses: Record<string, Response | Response[]>) {
  const calls: Array<{ hostId: string; route: ModelRoute; timeoutMs: number }> = [];
  const used = new Map<string, number>();
  const callModel: CallModel = async (hostId, input, timeoutMs) => {
    calls.push({ hostId, route: input.route, timeoutMs });
    const name = routeName(input.route);
    const entry = responses[name];
    if (!entry) throw new Error(`unexpected route ${name}`);
    const index = used.get(name) ?? 0;
    used.set(name, index + 1);
    const response = Array.isArray(entry) ? entry[Math.min(index, entry.length - 1)]! : entry;
    if (response instanceof Error) throw response;
    return response;
  };
  return { callModel, calls, names: () => calls.map((call) => routeName(call.route)) };
}

const ok = (text: string, durationMs = 2_500, costUsd: number | null = null): ModelRunResult => ({ status: "ok", text, durationMs, costUsd });
const fail = (message: string, cooldown?: { scope: "model" | "gateway"; ms: number }): ModelRunResult => (cooldown ? { status: "failed", message, cooldown } : { status: "failed", message });
const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe("parseModelList", () => {
  const fallback = ["x/default-1", "y/default-2"];
  it("逗号分隔的有序列表，保持顺序、去空白、去重", () => {
    expect(parseModelList(" a/one , b/two,a/one,, ", fallback)).toEqual(["a/one", "b/two"]);
  });
  it("兼容只写一个模型名、中文逗号与换行", () => {
    expect(parseModelList("a/one", fallback)).toEqual(["a/one"]);
    expect(parseModelList("a/one，b/two\nc/three", fallback)).toEqual(["a/one", "b/two", "c/three"]);
  });
  it("留空用默认链", () => {
    expect(parseModelList("  ", fallback)).toEqual(fallback);
  });
});

describe("generateBriefing 模型链", () => {
  it("第一个网关模型正常返回：只调它一次，不碰后面的模型和 claude", async () => {
    const { callModel, calls } = fakeCallModel({ [PRIMARY]: ok(VALID) });
    const outcome = await generateBriefing(callModel, "host-1", request, chain);
    expect(outcome).toMatchObject({ status: "ok", via: "gateway", model: PRIMARY, durationMs: 2_500, costUsd: null, steps: [] });
    expect(outcome.status === "ok" && outcome.briefing.about).toBe("给侧边栏加分支视图");
    expect(calls).toEqual([{ hostId: "host-1", route: { via: "gateway", baseUrl: BASE, model: PRIMARY }, timeoutMs: 60_000 }]);
  });

  it("按顺序回退：第一个超时 → 第二个命中", async () => {
    const { callModel, names } = fakeCallModel({ [PRIMARY]: fail("网关超时（45s）"), [SECONDARY]: ok(VALID) });
    const outcome = await generateBriefing(callModel, "host-1", request, chain);
    expect(outcome).toMatchObject({ status: "ok", via: "gateway", model: SECONDARY, steps: [{ model: PRIMARY, kind: "failed", reason: "网关超时（45s）", cooldownMs: null }] });
    expect(names()).toEqual([PRIMARY, SECONDARY]);
  });

  it("网关模型都失败（出错 / RPC 抛错）：兜底到本机 claude", async () => {
    const { callModel, calls } = fakeCallModel({ [PRIMARY]: fail("网关 HTTP 500: boom"), [SECONDARY]: new Error("host call timed out"), "claude:haiku": ok(VALID, 9_000, 0.001) });
    const outcome = await generateBriefing(callModel, "host-1", request, chain);
    expect(outcome).toMatchObject({ status: "ok", via: "claude", model: "haiku", costUsd: 0.001 });
    expect(outcome.steps.map((step) => [step.model, step.kind, step.kind === "failed" && step.reason])).toEqual([
      [PRIMARY, "failed", "网关 HTTP 500: boom"],
      [SECONDARY, "failed", "host call timed out"],
    ]);
    expect(calls.map((call) => [routeName(call.route), call.timeoutMs])).toEqual([
      [PRIMARY, 60_000],
      [SECONDARY, 60_000],
      ["claude:haiku", 150_000],
    ]);
  });

  it("网关返回的文字过不了 parseBriefing：当作失败，试下一级", async () => {
    for (const text of ["好的，以下是速览：分支树视图已完成。", JSON.stringify({ about: "缺字段" }), '{"about": "半截']) {
      const { callModel, names } = fakeCallModel({ [PRIMARY]: ok(text), [SECONDARY]: ok(text), "claude:haiku": ok(VALID) });
      const outcome = await generateBriefing(callModel, "host-1", request, chain);
      expect(outcome).toMatchObject({ status: "ok", via: "claude" });
      expect(outcome.steps.every((step) => step.kind === "failed" && step.reason.startsWith("unparseable model output"))).toBe(true);
      expect(names()).toEqual([PRIMARY, SECONDARY, "claude:haiku"]);
    }
  });

  it("没配置网关：直接走本机 claude，只调一次", async () => {
    const { callModel, calls } = fakeCallModel({ "claude:sonnet": ok(VALID) });
    const outcome = await generateBriefing(callModel, "host-1", request, { model: "sonnet", gateway: null });
    expect(outcome).toMatchObject({ status: "ok", via: "claude", model: "sonnet", steps: [] });
    expect(calls).toEqual([{ hostId: "host-1", route: { via: "claude", model: "sonnet" }, timeoutMs: 150_000 }]);
  });

  it("全部失败才算失败，每一级的原因都保留", async () => {
    const { callModel } = fakeCallModel({ [PRIMARY]: fail("a"), [SECONDARY]: fail("b"), "claude:haiku": fail("这台机器上找不到 claude 命令") });
    const outcome = await generateBriefing(callModel, "host-1", request, chain);
    expect(outcome).toMatchObject({ status: "failed", message: "这台机器上找不到 claude 命令" });
    expect(outcome.steps.map((step) => step.kind === "failed" && step.reason)).toEqual(["a", "b"]);
  });
});

describe("generateBriefing 冷却", () => {
  it("429 带回的冷却写进冷却表：之后冷却期内跳过该模型、不再请求，过期后恢复尝试", async () => {
    const time = clock();
    const cooldowns: CooldownTable = new Map();
    const hour = 3_595_000;
    const { callModel, names } = fakeCallModel({
      [PRIMARY]: [fail("网关 HTTP 429: Free usage limit reached", { scope: "model", ms: hour }), ok(VALID)],
      [SECONDARY]: ok(VALID),
    });

    const first = await generateBriefing(callModel, "host-1", request, chain, cooldowns, time.now);
    expect(first).toMatchObject({ status: "ok", model: SECONDARY, steps: [{ model: PRIMARY, kind: "failed", cooldownMs: hour }] });

    time.advance(10 * 60_000);
    const second = await generateBriefing(callModel, "host-1", request, chain, cooldowns, time.now);
    expect(second).toMatchObject({ status: "ok", model: SECONDARY, steps: [{ model: PRIMARY, kind: "cooling", until: 1_000_000 + hour }] });

    time.advance(hour);
    const third = await generateBriefing(callModel, "host-1", request, chain, cooldowns, time.now);
    expect(third).toMatchObject({ status: "ok", via: "gateway", model: PRIMARY, steps: [] });
    // 第二次没有请求第一个模型
    expect(names()).toEqual([PRIMARY, SECONDARY, SECONDARY, PRIMARY]);
    expect(cooldowns.size).toBe(0);
  });

  it("冷却只针对报 429 的那个模型，链上其他模型照常尝试", async () => {
    const time = clock();
    const cooldowns: CooldownTable = new Map();
    const { callModel, names } = fakeCallModel({ [PRIMARY]: ok(VALID), [SECONDARY]: fail("网关 HTTP 429: limit", { scope: "model", ms: 60_000 }) });
    await generateBriefing(callModel, "host-1", request, { model: "haiku", gateway: { baseUrl: BASE, models: [SECONDARY, PRIMARY] } }, cooldowns, time.now);
    await generateBriefing(callModel, "host-1", request, chain, cooldowns, time.now);
    expect(names()).toEqual([SECONDARY, PRIMARY, PRIMARY]);
  });

  it("网关整体连不上：网关级短冷却，同一轮后面的模型直接跳过，冷却期内只走 claude，过期后恢复", async () => {
    const time = clock();
    const cooldowns: CooldownTable = new Map();
    const { callModel, names } = fakeCallModel({
      [PRIMARY]: [fail("网关连不上: ECONNREFUSED", { scope: "gateway", ms: 60_000 }), ok(VALID)],
      [SECONDARY]: ok(VALID),
      "claude:haiku": ok(VALID),
    });

    const first = await generateBriefing(callModel, "host-1", request, chain, cooldowns, time.now);
    expect(first).toMatchObject({
      status: "ok",
      via: "claude",
      steps: [
        { model: PRIMARY, kind: "failed", cooldownMs: 60_000 },
        { model: SECONDARY, kind: "cooling", until: 1_060_000 },
      ],
    });

    time.advance(30_000);
    const second = await generateBriefing(callModel, "host-1", request, chain, cooldowns, time.now);
    expect(second).toMatchObject({ via: "claude", steps: [{ kind: "cooling" }, { kind: "cooling" }] });

    time.advance(31_000);
    const third = await generateBriefing(callModel, "host-1", request, chain, cooldowns, time.now);
    expect(third).toMatchObject({ via: "gateway", model: PRIMARY, steps: [] });
    expect(names()).toEqual([PRIMARY, "claude:haiku", "claude:haiku", PRIMARY]);
  });

  it("冷却按机器区分：一台机器上的网关冷却不影响另一台", async () => {
    const time = clock();
    const cooldowns: CooldownTable = new Map();
    const { callModel, calls } = fakeCallModel({
      [PRIMARY]: [fail("网关连不上: ECONNREFUSED", { scope: "gateway", ms: 60_000 }), ok(VALID)],
      "claude:haiku": ok(VALID),
    });
    await generateBriefing(callModel, "host-1", request, chain, cooldowns, time.now);
    const other = await generateBriefing(callModel, "host-2", request, chain, cooldowns, time.now);
    expect(other).toMatchObject({ via: "gateway", model: PRIMARY });
    expect(calls.map((call) => `${call.hostId}:${routeName(call.route)}`)).toEqual(["host-1:" + PRIMARY, "host-1:claude:haiku", "host-2:" + PRIMARY]);
  });
});
