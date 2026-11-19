/**
 * [INPUT]: 依赖全局 fetch 向 OpenAI 兼容网关（如本机 Magpie）发一次 /v1/chat/completions; 依赖 node:child_process 的 spawn 一次性调用本机的 Claude Code CLI（`claude -p`），依赖 node:fs / node:os 建一个空的临时目录作为工作目录; 依赖 lib/contract 的 ModelRoute
 * [OUTPUT]: 对外提供 runModel(input): 按 route 走网关（runGateway）或本机 claude，返回 hostContract.writeBriefing 的输出（ok / failed，failed 可带冷却建议），永不抛出; runGateway / chatCompletionsUrl / parseRetryAfter / rateLimitCooldownMs 与超时、冷却常量（网关单独可测）
 * [POS]: lib 的 host 侧 I/O 层; 消费者: host.ts; 与 lib/briefing.ts 的边界: 这里只负责“把一段提示词交给模型、拿回文字”，提示词和结果怎么解析都在 briefing; 与 briefings.ts 的边界: 一次只走一条通道，只“建议”冷却多久（429 按 Retry-After、连不上给短冷却），记住冷却、按模型链回退到 claude 都由服务端决定
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ModelRoute } from "./contract";

/** 失败时建议调用方暂停多久：model = 只停这个模型（429），gateway = 整个网关都连不上 */
export type Cooldown = { scope: "model" | "gateway"; ms: number };

export type ModelRunResult =
  | { status: "ok"; text: string; costUsd: number | null; durationMs: number }
  | { status: "failed"; message: string; cooldown?: Cooldown };

const RUN_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 4 * 1024 * 1024;
/** 网关一问一答的上限：实测免费 DeepSeek 2–5s，超过这么久多半是网关卡住了，及时回退到 claude */
export const GATEWAY_TIMEOUT_MS = 45_000;

/** 429 没带 Retry-After 时冷却 15 分钟；带了也最多 2 小时（免费额度常给一小时） */
export const RATE_LIMIT_DEFAULT_COOLDOWN_MS = 15 * 60_000;
export const RATE_LIMIT_MAX_COOLDOWN_MS = 2 * 60 * 60_000;
/** 网关整个连不上（没启动、端口不对）：短冷却，网关起来后很快恢复 */
export const UNREACHABLE_COOLDOWN_MS = 60_000;

const failed = (message: string, cooldown?: Cooldown): ModelRunResult => (cooldown ? { status: "failed", message, cooldown } : { status: "failed", message });

/** Retry-After 两种写法：秒数，或 HTTP 日期；解析不了返回 null。结果不为负 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  const text = value?.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  // HTTP 日期一定带星期 / 月份的英文名；没有字母的（如 "-5"）Date.parse 也会当成年份，不能信
  if (!/[a-z]/i.test(text)) return null;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export function rateLimitCooldownMs(retryAfter: string | null, now: number = Date.now()): number {
  return Math.min(parseRetryAfter(retryAfter, now) ?? RATE_LIMIT_DEFAULT_COOLDOWN_MS, RATE_LIMIT_MAX_COOLDOWN_MS);
}
const brief = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 300);

/** 接受 "http://host:port"、带尾斜杠或已带 /v1 的写法 */
export function chatCompletionsUrl(baseUrl: string): string {
  const root = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${root}/v1/chat/completions`;
}

/** OpenAI 兼容错误体里的 error.message；不是 JSON 就截一段原文 */
function gatewayError(body: string): string {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    if (typeof message === "string") return brief(message);
  } catch {
    // 不是 JSON
  }
  return brief(body);
}

/**
 * 纯 HTTP 调网关，不启动任何进程。连不上、超时、非 2xx、没有文字都返回 failed，由调用方决定回退；
 * 429 附带按 Retry-After 算出的模型级冷却，连不上附带网关级短冷却；超时与其他错误不建议冷却。
 * reasoning_effort 用模型列出的最低档 low（网关接受该参数，实测对耗时影响不明显）；
 * 思考过程由网关放在 reasoning_content 里，正文若仍夹着 <think> 块也一并去掉，免得干扰 JSON 解析。
 */
export async function runGateway(
  route: Extract<ModelRoute, { via: "gateway" }>,
  system: string,
  prompt: string,
  timeoutMs: number = GATEWAY_TIMEOUT_MS,
): Promise<ModelRunResult> {
  const started = Date.now();
  try {
    const response = await fetch(chatCompletionsUrl(route.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: route.model,
        stream: false,
        reasoning_effort: "low",
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    if (response.status === 429) {
      const cooldown: Cooldown = { scope: "model", ms: rateLimitCooldownMs(response.headers.get("retry-after")) };
      return failed(`网关 HTTP 429: ${gatewayError(body)}`, cooldown);
    }
    if (!response.ok) return failed(`网关 HTTP ${response.status}: ${gatewayError(body)}`);
    let content: unknown;
    try {
      content = (JSON.parse(body) as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
    } catch {
      return failed(`网关返回的不是 JSON: ${brief(body)}`);
    }
    const text = typeof content === "string" ? content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() : "";
    if (text === "") return failed("网关没有返回正文");
    return { status: "ok", text, costUsd: null, durationMs: Date.now() - started };
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return failed(`网关超时（${Math.round(timeoutMs / 1000)}s）`);
    }
    // fetch 的网络错误把真正原因（ECONNREFUSED 等）放在 cause 里
    const cause = error instanceof Error ? (error.cause as { code?: string; message?: string } | undefined) : undefined;
    const detail = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
    return failed(`网关连不上: ${detail}`, { scope: "gateway", ms: UNREACHABLE_COOLDOWN_MS });
  }
}

/** bb daemon 的 PATH 不一定带用户级目录，所以把 claude 常见的安装位置也找一遍 */
async function findClaude(): Promise<string | null> {
  const home = homedir();
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    join(home, ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    const candidate = join(dir, "claude");
    try {
      await access(candidate);
      return candidate;
    } catch {
      // 这个目录里没有，继续找
    }
  }
  return null;
}

/**
 * 这次调用必须“干净”：
 * - --setting-sources "" + disableAllHooks：不加载用户的设置与钩子（用户的钩子会唤起别的工具）
 * - --no-session-persistence：不往会话历史里留记录
 * - --tools "" + --strict-mcp-config：不给任何工具，只是一问一答
 * - --system-prompt：整段替换默认系统提示词；工作目录是空的临时目录，不会读到任何 CLAUDE.md
 */
function claudeArgs(model: string, system: string): string[] {
  return [
    "-p",
    "--model",
    model,
    "--effort",
    "low",
    "--setting-sources",
    "",
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
    "--no-session-persistence",
    "--strict-mcp-config",
    "--tools",
    "",
    "--system-prompt",
    system,
    "--output-format",
    "json",
  ];
}

function run(bin: string, args: string[], cwd: string, stdin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}

export function runModel(input: { system: string; prompt: string; route: ModelRoute }): Promise<ModelRunResult> {
  return input.route.via === "gateway"
    ? runGateway(input.route, input.system, input.prompt)
    : runClaude({ system: input.system, prompt: input.prompt, model: input.route.model });
}

async function runClaude(input: { system: string; prompt: string; model: string }): Promise<ModelRunResult> {
  const started = Date.now();
  let cwd: string | null = null;
  try {
    const bin = await findClaude();
    if (!bin) return { status: "failed", message: "这台机器上找不到 claude 命令" };
    cwd = await mkdtemp(join(tmpdir(), "wl-briefing-"));
    const { code, stdout, stderr } = await run(bin, claudeArgs(input.model, input.system), cwd, input.prompt);
    if (code !== 0) return { status: "failed", message: `claude 退出码 ${code ?? "无（超时被终止）"}: ${(stderr || stdout).trim().slice(0, 300)}` };
    const parsed = JSON.parse(stdout) as { result?: unknown; is_error?: unknown; total_cost_usd?: unknown };
    if (parsed.is_error === true || typeof parsed.result !== "string") {
      return { status: "failed", message: `claude 返回了错误: ${String(parsed.result).slice(0, 300)}` };
    }
    return {
      status: "ok",
      text: parsed.result,
      costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}
