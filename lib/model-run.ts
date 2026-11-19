/**
 * [INPUT]: 依赖 node:child_process 的 spawn 一次性调用本机的 Claude Code CLI（`claude -p`），依赖 node:fs / node:os 建一个空的临时目录作为工作目录
 * [OUTPUT]: 对外提供 runModel(input): hostContract.writeBriefing 的输出（ok / failed），永不抛出
 * [POS]: lib 的 host 侧 I/O 层; 消费者: host.ts; 与 lib/briefing.ts 的边界: 这里只负责“把一段提示词交给本机的小模型、拿回文字”，提示词和结果怎么解析都在 briefing
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export type ModelRunResult =
  | { status: "ok"; text: string; costUsd: number | null; durationMs: number }
  | { status: "failed"; message: string };

const RUN_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 4 * 1024 * 1024;

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

export async function runModel(input: { system: string; prompt: string; model: string }): Promise<ModelRunResult> {
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
