import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BranchNode, RepoScan } from "../lib/contract";
import { hostContract } from "../lib/contract";
import { scanRepository } from "../lib/git-scan";

let root: string;
let repo: string;
let clock = 1_700_000_000;

/** 每条命令推进一秒，让 reflog 时间严格递增、结果可复现 */
function git(cwd: string, ...args: string[]): string {
  clock += 1;
  const date = `${clock} +0000`;
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  }).trim();
}

function commit(cwd: string, message: string) {
  git(cwd, "commit", "--allow-empty", "-q", "-m", message);
}

let scan: RepoScan;
const node = (name: string): BranchNode | undefined => scan.branches.find((b) => b.name === name);

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "wl-scan-")));
  repo = join(root, "repo");
  git(root, "init", "-q", "-b", "main", repo);
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "commit.gpgsign", "false");
  commit(repo, "c0");

  // feat ← main（命名分支）
  git(repo, "branch", "feat", "main");
  git(repo, "switch", "-q", "feat");
  commit(repo, "f1");
  commit(repo, "f2");
  // fromSha ← feat（按提交反查），挂在 worktree 上；feat 自己没有 worktree = 幽灵祖先
  const featTip = git(repo, "rev-parse", "--short=9", "feat");
  git(repo, "branch", "fromSha", featTip);
  git(repo, "worktree", "add", "-q", join(root, "wt-fromSha"), "fromSha");
  commit(join(root, "wt-fromSha"), "s1");
  // linked worktree 里 checkout -b：只能靠该 worktree 的 HEAD reflog 找回 fromSha
  const wt = join(root, "wt-fromSha");
  git(wt, "checkout", "-q", "-b", "headChild");
  commit(wt, "hc1");
  git(wt, "checkout", "-q", "fromSha");
  // viaHead: 主检出里 checkout -b → "Created from HEAD"，由主检出 HEAD reflog 解析为 feat
  git(repo, "checkout", "-q", "-b", "viaHead");
  commit(repo, "h1");
  // recorded: 记录覆盖 reflog
  git(repo, "branch", "recOrigin", "feat");
  git(repo, "branch", "recDefault", "feat");
  // merged: 合回 main（--no-ff 让 tip 不同）
  git(repo, "switch", "-q", "main");
  git(repo, "branch", "merged", "main");
  git(repo, "switch", "-q", "merged");
  commit(repo, "m1");
  git(repo, "switch", "-q", "main");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge merged", "merged");
  // 无关分支：没有 worktree、不是任何相关分支的祖先
  git(repo, "branch", "unrelated", "main");
  // detached worktree
  git(repo, "worktree", "add", "-q", "--detach", join(root, "wt-detached"), "main");

  const result = await scanRepository({
    sourcePath: repo,
    recordedBases: { recOrigin: "origin/main", recDefault: "default" },
    extraBranches: ["viaHead", "headChild", "recOrigin", "recDefault", "merged", "nope"],
  });
  if (result.status !== "ok") throw new Error(JSON.stringify(result));
  scan = result.scan;
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("scanRepository", () => {
  it("returns output that satisfies the host contract", () => {
    const parsed = hostContract.scanLineage.output.safeParse({ status: "ok", scan });
    expect(parsed.success).toBe(true);
    expect(scan.commonDir).toBe(join(repo, ".git"));
    expect(scan.defaultBranch).toBe("main");
  });

  it("resolves parents by source", () => {
    const table = Object.fromEntries(scan.branches.map((b) => [b.name, [b.parent, b.parentSource]]));
    expect(table).toEqual({
      main: [null, "unknown"],
      feat: ["main", "reflog"],
      fromSha: ["feat", "reflog-commit"],
      viaHead: ["feat", "reflog"],
      headChild: ["fromSha", "reflog"],
      recOrigin: ["main", "recorded"],
      recDefault: ["main", "recorded"],
      merged: ["main", "reflog"],
    });
  });

  it("computes mergedIntoParent and aheadOfParent", () => {
    expect(node("merged")).toMatchObject({ mergedIntoParent: true, aheadOfParent: 0 });
    expect(node("feat")).toMatchObject({ mergedIntoParent: false, aheadOfParent: 2 });
    expect(node("fromSha")).toMatchObject({ mergedIntoParent: false, aheadOfParent: 1 });
    expect(node("recOrigin")).toMatchObject({ mergedIntoParent: false, aheadOfParent: 2 });
    expect(node("main")).toMatchObject({ mergedIntoParent: false, aheadOfParent: null });
    expect(node("viaHead")).toMatchObject({ mergedIntoParent: false, aheadOfParent: 1 });
    expect(node("headChild")).toMatchObject({ mergedIntoParent: false, aheadOfParent: 1 });
  });

  it("reports worktrees on branches and detached", () => {
    const [first, ...linked] = scan.worktrees.map((w) => [w.path, w.branch, w.isMain]);
    expect(first).toEqual([repo, "main", true]);
    expect(linked).toEqual(
      expect.arrayContaining([
        [join(root, "wt-fromSha"), "fromSha", false],
        [join(root, "wt-detached"), null, false],
      ]),
    );
    expect(linked).toHaveLength(2);
    expect(node("fromSha")!.worktreePath).toBe(join(root, "wt-fromSha"));
    expect(node("main")!.worktreePath).toBe(repo);
    expect(node("feat")!.worktreePath).toBeNull();
  });

  it("excludes unrelated branches but keeps ghost ancestors", () => {
    expect(node("unrelated")).toBeUndefined();
    expect(node("feat")).toBeDefined();
    expect(node("nope")).toBeUndefined();
  });

  it("scans from a linked worktree with the same commonDir", async () => {
    const result = await scanRepository({ sourcePath: join(root, "wt-fromSha"), recordedBases: {}, extraBranches: [] });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.scan.commonDir).toBe(scan.commonDir);
  });

  it("answers not-git for a plain directory and never throws", async () => {
    const plain = mkdtempSync(join(tmpdir(), "wl-plain-"));
    try {
      expect((await scanRepository({ sourcePath: plain, recordedBases: {}, extraBranches: [] })).status).toBe("not-git");
      expect((await scanRepository({ sourcePath: join(plain, "missing"), recordedBases: {}, extraBranches: [] })).status).toBe("not-git");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
