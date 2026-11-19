/**
 * [INPUT]: 依赖 node:child_process 的 execFile 调用 git CLI（只读命令）、node:fs 读取 <commonDir>/logs/refs/heads 下的分支 reflog 与各 worktree 的 HEAD reflog、lib/lineage.ts 的解析与血缘推断
 * [OUTPUT]: 对外提供 scanRepository(input): hostContract.scanLineage 的输出（ok / not-git / failed），永不抛出
 * [POS]: lib 的 host 侧 I/O 层; 消费者: host.ts、test/git-scan.test.ts; 与 lib/lineage.ts 的边界: 本文件只采集事实（git 输出、reflog 文本）并计算合并/领先状态，起点判定全部交给 lineage
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import { execFile } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BranchNode, RepoScan, ScanInput, Worktree } from "./contract";
import {
  type BranchFacts,
  type ReflogEntry,
  type ResolvedBranch,
  parseReflogFile,
  parseWorktreePorcelain,
  parseWorktreePorcelainZ,
  resolveLineage,
  selectRelevant,
} from "./lineage";

export type ScanResult =
  | { status: "ok"; scan: RepoScan }
  | { status: "not-git"; message: string }
  | { status: "failed"; message: string };

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const COMPARE_CONCURRENCY = 6;

class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (${exitCode ?? "no exit code"}): ${stderr.trim()}`);
  }
}

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        encoding: "utf8",
        maxBuffer: GIT_MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
        env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (error === null) return resolvePromise(stdout);
        const code = typeof error.code === "number" ? error.code : null;
        if (code === null && typeof error.code === "string") return reject(error);
        reject(new GitError(args, code, stderr));
      },
    );
  });
}

/** 退出码 0/1 是答案，其余是故障。 */
async function gitPredicate(cwd: string, args: readonly string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) return false;
    throw error;
  }
}

async function resolveCommonDir(sourcePath: string): Promise<string | null> {
  try {
    const out = (await git(sourcePath, ["rev-parse", "--git-common-dir"])).trim();
    return await realpath(resolve(sourcePath, out));
  } catch (error) {
    // 128 = 不是仓库或路径不存在；其余错误（git 不存在、超时）向上报 failed
    if (error instanceof GitError && error.exitCode === 128) return null;
    throw error;
  }
}

async function listWorktrees(sourcePath: string): Promise<Worktree[]> {
  try {
    return parseWorktreePorcelainZ(await git(sourcePath, ["worktree", "list", "--porcelain", "-z"]));
  } catch (error) {
    // git < 2.36 不认 -z
    if (!(error instanceof GitError)) throw error;
    return parseWorktreePorcelain(await git(sourcePath, ["worktree", "list", "--porcelain"]), "\n");
  }
}

interface LocalBranch {
  name: string;
  tip: string;
  committedAt: number | null;
}

async function listBranches(sourcePath: string): Promise<LocalBranch[]> {
  const out = await git(sourcePath, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(committerdate:unix)",
    "refs/heads",
  ]);
  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [ref = "", tip = "", date = ""] = line.split("\0");
      const committedAt = Number.parseInt(date, 10);
      return {
        name: ref.replace(/^refs\/heads\//, ""),
        tip,
        committedAt: Number.isFinite(committedAt) ? committedAt : null,
      };
    });
}

async function detectDefaultBranch(
  sourcePath: string,
  local: ReadonlySet<string>,
): Promise<string | null> {
  try {
    const ref = (await git(sourcePath, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])).trim();
    const name = ref.replace(/^refs\/remotes\/origin\//, "");
    if (local.has(name)) return name;
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
  }
  return ["main", "master"].find((name) => local.has(name)) ?? null;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function readReflogAt(path: string): Promise<ReflogEntry[]> {
  try {
    return parseReflogFile(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function readReflog(commonDir: string, branch: string): Promise<ReflogEntry[]> {
  return readReflogAt(join(commonDir, "logs", "refs", "heads", ...branch.split("/")));
}

/** 主检出在 <commonDir>/logs/HEAD，linked worktree 在 <commonDir>/worktrees/<id>/logs/HEAD */
async function readHeadReflogs(commonDir: string): Promise<ReflogEntry[]> {
  let ids: string[] = [];
  try {
    ids = await readdir(join(commonDir, "worktrees"));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const paths = [
    join(commonDir, "logs", "HEAD"),
    ...ids.map((id) => join(commonDir, "worktrees", id, "logs", "HEAD")),
  ];
  return (await Promise.all(paths.map(readReflogAt))).flat();
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function compareWithParent(
  sourcePath: string,
  branch: ResolvedBranch,
  tipOf: ReadonlyMap<string, string>,
): Promise<Pick<BranchNode, "mergedIntoParent" | "aheadOfParent">> {
  const parentTip = branch.parent === null ? undefined : tipOf.get(branch.parent);
  if (parentTip === undefined) return { mergedIntoParent: false, aheadOfParent: null };
  const [isAncestor, count] = await Promise.all([
    gitPredicate(sourcePath, ["merge-base", "--is-ancestor", branch.tip, parentTip]),
    // parentTip..tip = 从 tip 可达、从 parent 不可达的提交，即领先数
    git(sourcePath, ["rev-list", "--count", `${parentTip}..${branch.tip}`]),
  ]);
  return {
    mergedIntoParent: isAncestor && branch.tip !== parentTip,
    aheadOfParent: Number.parseInt(count.trim(), 10),
  };
}

async function scan(input: ScanInput): Promise<ScanResult> {
  const { sourcePath } = input;
  const commonDir = await resolveCommonDir(sourcePath);
  if (commonDir === null) return { status: "not-git", message: `${sourcePath} 不是 git 仓库` };

  const [worktrees, localBranches] = await Promise.all([
    listWorktrees(sourcePath),
    listBranches(sourcePath),
  ]);
  const local = new Set(localBranches.map((b) => b.name));
  const defaultBranch = await detectDefaultBranch(sourcePath, local);
  const [facts, headReflog] = await Promise.all([
    Promise.all(
      localBranches.map(async (b): Promise<BranchFacts> => ({ ...b, reflog: await readReflog(commonDir, b.name) })),
    ),
    readHeadReflogs(commonDir),
  ]);

  const resolved = resolveLineage({
    branches: facts,
    defaultBranch,
    recordedBases: input.recordedBases,
    headReflog,
  });
  const relevant = selectRelevant(resolved, worktrees, defaultBranch, input.extraBranches ?? []);
  const selected = resolved.filter((b) => relevant.has(b.name));
  const tipOf = new Map(resolved.map((b) => [b.name, b.tip]));
  const worktreeOf = new Map(
    worktrees.filter((w) => w.branch !== null).map((w) => [w.branch!, w.path]),
  );

  const comparisons = await mapLimit(selected, COMPARE_CONCURRENCY, (b) =>
    compareWithParent(sourcePath, b, tipOf),
  );
  const branches: BranchNode[] = selected.map((b, i) => ({
    ...b,
    ...comparisons[i]!,
    worktreePath: worktreeOf.get(b.name) ?? null,
  }));

  return {
    status: "ok",
    scan: { sourcePath, commonDir, defaultBranch, worktrees, branches, scannedAt: Date.now() },
  };
}

export async function scanRepository(input: ScanInput): Promise<ScanResult> {
  try {
    return await scan(input);
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}
