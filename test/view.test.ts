import { describe, expect, it } from "vitest";
import type { BranchNode, RepoScan } from "../lib/contract";
import { buildLineageTree, type ThreadLike } from "../lib/tree";
import { buildProjectView, pathLabels, relativeTime, rollupTone, rowColor, rowTone, toneOf, worktreeCleanupCommand, type ViewNode } from "../lib/view";

const branch = (name: string, parent: string | null, extra: Partial<BranchNode> = {}): BranchNode => ({
  name,
  tip: `${name}-tip`,
  createdAt: null,
  committedAt: 100,
  parent,
  parentSource: parent ? "recorded" : "unknown",
  mergedIntoParent: false,
  aheadOfParent: parent ? 1 : null,
  worktreePath: `/wt/${name}`,
  ...extra,
});
const thread = (id: string, path: string, parent: string | null = null): ThreadLike => ({
  id,
  projectId: "p",
  parentThreadId: parent,
  createdAt: 1,
  updatedAt: 1,
  indicator: "none",
  environment: { path, branchName: null },
});
const wt = (name: string, isMain = false) => ({ path: `/wt/${name}`, branch: name, head: "h", isMain, locked: false });

// main(★, 无对话) → feat(指挥官) → { integ(无对话) → c1 ; x8(幽灵) → { d4(外部无对话) → a1 ; d1 } } ; old(已合回) ; ext(外部空闲)
const scan: RepoScan = {
  sourcePath: "/wt/main",
  commonDir: "/wt/main/.git",
  defaultBranch: "main",
  scannedAt: 0,
  worktrees: ["main", "feat", "integ", "c1", "d4", "a1", "d1", "old", "ext"].map((n) => wt(n, n === "main")),
  branches: [
    branch("main", null),
    branch("feat", "main"),
    branch("integ", "feat"),
    branch("c1", "integ"),
    branch("x8", "feat", { worktreePath: null }),
    branch("d4", "x8"),
    branch("bb/a1-thr_abc123", "d4", { worktreePath: "/wt/a1" }),
    branch("d1", "x8"),
    branch("old", "main", { mergedIntoParent: true }),
    branch("ext", "main"),
  ],
};
scan.worktrees.find((w) => w.path === "/wt/a1")!.branch = "bb/a1-thr_abc123";

const threads = [
  thread("cmd", "/wt/feat"),
  thread("c1t", "/wt/c1", "cmd"),
  thread("a1t", "/wt/a1", "cmd"),
  thread("d1t", "/wt/d1", "cmd"),
  thread("oldt", "/wt/old", "cmd"),
];
const registered = ["feat", "integ", "c1", "a1", "d1", "old"].map((n) => ({ path: `/wt/${n}` }));
const view = buildProjectView(buildLineageTree(threads, scan, registered));

const find = (nodes: ViewNode[], branchName: string): ViewNode | undefined => {
  for (const n of nodes) {
    if (n.node.branch === branchName) return n;
    const hit = find(n.children, branchName);
    if (hit) return hit;
  }
  return undefined;
};

describe("buildProjectView", () => {
  it("没有对话且只有一个后继的分支并入后继的路径", () => {
    // main 无对话、只剩 feat 一条线 → 并入 feat 的 via
    expect(view.roots).toHaveLength(1);
    const feat = view.roots[0]!;
    expect(feat.kind).toBe("card");
    expect(feat.node.branch).toBe("feat");
    // 根上的默认分支不写进路径
    expect(feat.via).toEqual([]);
    // integ 无对话、只有 c1 → 并入 c1
    const c1 = find(view.roots, "c1")!;
    expect(c1.via.map((b) => b.branch)).toEqual(["integ"]);
    // d4 是外部无对话 worktree，只有 a1 → 并入 a1
    const a1 = find(view.roots, "bb/a1-thr_abc123")!;
    expect(a1.via.map((b) => b.branch)).toEqual(["d4"]);
  });

  it("没有对话但分出多条线的分支画成分叉点", () => {
    const x8 = find(view.roots, "x8")!;
    expect(x8.kind).toBe("fork");
    expect(x8.children.map((c) => c.node.branch).sort()).toEqual(["bb/a1-thr_abc123", "d1"]);
  });

  it("已合回与空闲 worktree 收进页脚，不留在树里", () => {
    expect(view.merged.map((b) => b.branch)).toEqual(["old"]);
    expect(view.merged[0]!.threads.map((l) => l.thread.id)).toEqual(["oldt"]);
    expect(view.idle.map((b) => b.branch)).toEqual(["ext"]);
    expect(find(view.roots, "old")).toBeUndefined();
    expect(find(view.roots, "ext")).toBeUndefined();
  });

  it("每个未合回的对话都能在树里找到", () => {
    const seen: string[] = [];
    const walk = (nodes: ViewNode[]) => {
      for (const n of nodes) {
        seen.push(...n.node.threads.map((l) => l.thread.id));
        walk(n.children);
      }
    };
    walk(view.roots);
    expect(seen.sort()).toEqual(["a1t", "c1t", "cmd", "d1t"]);
  });

  it("bb 登记的空闲 worktree（无对话、无后继）也进页脚", () => {
    const v = buildProjectView(buildLineageTree([thread("cmd", "/wt/feat")], scan, registered));
    expect(v.idle.map((b) => b.branch)).toEqual(expect.arrayContaining(["ext", "d1", "c1"]));
  });
});

describe("pathLabels / tone", () => {
  it("去掉前缀与 thr 后缀，相邻重名合并", () => {
    const a1 = find(view.roots, "bb/a1-thr_abc123")!;
    expect(pathLabels(a1.via, a1.node)).toEqual(["d4", "a1"]);
    const fake = { ...a1.node, branch: "mobile/a1" };
    expect(pathLabels([a1.node], fake)).toEqual(["a1"]);
  });

  it("色调按紧急程度汇总", () => {
    expect(toneOf("runtime")).toBe("running");
    expect(toneOf("none")).toBeNull();
    expect(rollupTone(["unread-success", "runtime"])).toBe("running");
    expect(rollupTone(["runtime", "waiting-for-input"])).toBe("attention");
    expect(rollupTone(["waiting-for-input", "unread-error"])).toBe("error");
    expect(rollupTone(["none"])).toBeNull();
  });

  it("相对时间", () => {
    const now = 10 * 24 * 3600_000;
    expect(relativeTime(now - 20_000, now)).toBe("刚刚");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m");
    expect(relativeTime(now - 3 * 3600_000, now)).toBe("3h");
    expect(relativeTime(now - 2 * 24 * 3600_000, now)).toBe("2d");
    expect(relativeTime(now - 21 * 24 * 3600_000, now)).toBe("3w");
  });
});

describe("rowTone", () => {
  it("没有草稿时就是状态本身的颜色", () => {
    expect(rowTone("runtime", false)).toBe("running");
    expect(rowTone("unread-success", false)).toBe("done");
    expect(rowTone("none", false)).toBeNull();
  });

  it("空闲、运行中、完成未读的对话有草稿时，都用草稿色", () => {
    expect(rowTone("none", true)).toBe("draft");
    expect(rowTone("runtime", true)).toBe("draft");
    expect(rowTone("unread-success", true)).toBe("draft");
  });

  it("出错和等你回复排在草稿之前", () => {
    expect(rowTone("unread-error", true)).toBe("error");
    expect(rowTone("waiting-for-input", true)).toBe("attention");
  });

  it("整行底色三种：草稿黄，等你回复和出错同为蓝，完成未读绿；运行中和空闲不上色", () => {
    expect(rowColor("draft")).toBe("draft");
    expect([rowColor("attention"), rowColor("error")]).toEqual(["waiting", "waiting"]);
    expect(rowColor("done")).toBe("done");
    expect([rowColor("running"), rowColor(null)]).toEqual([null, null]);
  });
});

describe("worktreeCleanupCommand", () => {
  it("空闲 worktree 生成不带 --force 的安全移除命令，并用 -C 指向仓库主检出", () => {
    expect(worktreeCleanupCommand({ repoPath: "/tmp/repo", worktreePath: "/tmp/wt/feat-a", branch: "feat-a", merged: false })).toBe(
      "git -C /tmp/repo worktree remove /tmp/wt/feat-a",
    );
  });

  it("已合回分支额外附带小写 -d 安全删分支，含空格或引号的路径用单引号转义", () => {
    expect(worktreeCleanupCommand({ repoPath: "/tmp/my repo", worktreePath: "/tmp/it's wt/feat-a", branch: "feat/a", merged: true })).toBe(
      "git -C '/tmp/my repo' worktree remove '/tmp/it'\\''s wt/feat-a' && git -C '/tmp/my repo' branch -d feat/a",
    );
  });

  it("拿不到仓库路径时省略 -C；从不出现 --force 或大写 -D", () => {
    const command = worktreeCleanupCommand({ repoPath: null, worktreePath: "/tmp/wt/x", branch: "x", merged: true });
    expect(command).toBe("git worktree remove /tmp/wt/x && git branch -d x");
    expect(command).not.toMatch(/--force|-D\b|-f\b/);
  });
});
