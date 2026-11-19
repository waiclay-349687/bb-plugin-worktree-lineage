import { describe, expect, it } from "vitest";
import type { BranchNode, RepoScan } from "../lib/contract";
import { branchLabel, buildDispatchTree, buildLineageTree, collectAncestry, collectFolded, groupChildren, isCollapsedByDefault, isSingleThreadLeaf, rollupIndicator, type ThreadLike } from "../lib/tree";

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

const thread = (id: string, path: string | null, parent: string | null = null, at = 1): ThreadLike => ({
  id,
  projectId: "p",
  parentThreadId: parent,
  createdAt: at,
  updatedAt: at,
  indicator: "none",
  environment: path ? { path, branchName: null } : null,
});

// reader 的缩影：指挥官在 feat 上；integ 从 feat 切出；d1 从无 worktree 的 x8 切出
const scan: RepoScan = {
  sourcePath: "/wt/main",
  commonDir: "/wt/main/.git",
  defaultBranch: "main",
  scannedAt: 0,
  worktrees: [
    { path: "/wt/main", branch: "main", head: "a", isMain: true, locked: false },
    { path: "/wt/feat", branch: "feat", head: "b", isMain: false, locked: false },
    { path: "/wt/integ", branch: "integ", head: "c", isMain: false, locked: false },
    { path: "/wt/d1", branch: "d1", head: "d", isMain: false, locked: false },
    { path: "/wt/review", branch: null, head: "e", isMain: false, locked: false },
  ],
  branches: [
    branch("main", null),
    branch("feat", "main"),
    branch("integ", "feat"),
    branch("x8", "main", { worktreePath: null }),
    branch("d1", "x8", { mergedIntoParent: true }),
    branch("stale", "main", { worktreePath: null }),
  ].map((b) => (b.name === "main" ? { ...b, worktreePath: "/wt/main" } : b.name === "feat" ? { ...b, worktreePath: "/wt/feat" } : b)),
};

describe("buildLineageTree", () => {
  const threads = [
    thread("cmd", "/wt/feat"),
    thread("c1", "/wt/integ", "cmd", 2),
    thread("d1t", "/wt/d1", "cmd", 3),
    thread("helper", "/wt/integ", "c1", 4),
    thread("v1", "/wt/review", "cmd", 5),
    thread("lost", "/elsewhere"),
  ];
  const tree = buildLineageTree(threads, scan, [{ path: "/wt/feat" }, { path: "/wt/integ" }, { path: "/wt/d1/" }]);
  const find = (name: string) => {
    const stack = [...tree.roots];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.branch === name) return n;
      stack.push(...n.children);
    }
    throw new Error(`no ${name}`);
  };

  it("按分支血缘连边，默认分支在最前", () => {
    expect(tree.roots[0]!.branch).toBe("main");
    expect(find("feat").children.map((c) => c.branch)).toEqual(["integ"]);
    expect(find("x8").children.map((c) => c.branch)).toEqual(["d1"]);
  });

  it("对话挂到所在 worktree，跨 worktree 的上级记为 dispatchedBy", () => {
    const integ = find("integ");
    expect(integ.threads.map((l) => l.thread.id)).toEqual(["c1"]);
    expect(integ.threads[0]!.dispatchedBy).toBe("cmd");
    // 同 worktree 的子对话嵌套在上级下面
    expect(integ.threads[0]!.children.map((l) => l.thread.id)).toEqual(["helper"]);
  });

  it("无 worktree 的分叉点保留为幽灵节点，无后代的无关分支被剪掉", () => {
    expect(find("x8").isGhost).toBe(true);
    expect(() => find("stale")).toThrow();
  });

  it("分离 HEAD 的 worktree 按 bb 记录的起点挂回树上", () => {
    const withBase = buildLineageTree(threads, scan, [{ path: "/wt/review", base: "origin/integ" }]);
    const integ = withBase.roots[0]!.children.find((c) => c.branch === "feat")!.children.find((c) => c.branch === "integ")!;
    expect(integ.children.map((c) => c.worktreePath)).toEqual(["/wt/review"]);
  });

  it("分离 HEAD 的 worktree 作为根节点，挂得住对话", () => {
    const detached = tree.roots.find((n) => n.worktreePath === "/wt/review");
    expect(detached?.branch).toBeNull();
    expect(detached?.threads.map((l) => l.thread.id)).toEqual(["v1"]);
  });

  it("标记外部 worktree 与已合回", () => {
    expect(find("main").isExternal).toBe(false); // 项目源目录
    expect(find("feat").isExternal).toBe(false);
    expect(find("d1").isExternal).toBe(false); // 尾部斜杠也能匹配
    expect(find("d1").merged).toBe(true);
    expect(find("d1").mergedInto).toBe("x8");
  });

  it("挂不上的对话进 loose", () => {
    expect(tree.loose.map((l) => l.thread.id)).toEqual(["lost"]);
  });
});

describe("渲染辅助", () => {
  it("groupChildren 折叠已合回与空闲外部 worktree", () => {
    const tree = buildLineageTree([thread("t", "/wt/feat")], scan, [{ path: "/wt/feat" }]);
    const main = tree.roots[0]!;
    const g = groupChildren(main.children);
    expect(g.active.map((n) => n.branch)).toContain("feat");
    // x8 自身未合回、子树里 d1 已合回 → x8 仍是 active；d1 在 x8 的分组里归入 merged
    expect(groupChildren(main.children.find((n) => n.branch === "x8")!.children).merged.map((n) => n.branch)).toEqual(["d1"]);
  });

  it("已合回但下面还有未合回分支的节点不默认折叠", () => {
    const s2: RepoScan = { ...scan, branches: scan.branches.map((b) => (b.name === "x8" ? { ...b, mergedIntoParent: true } : b.name === "d1" ? { ...b, mergedIntoParent: false } : b)) };
    const tree = buildLineageTree([thread("w", "/wt/d1")], s2, []);
    const x8 = tree.roots[0]!.children.find((n) => n.branch === "x8")!;
    expect(x8.merged).toBe(true);
    expect(isCollapsedByDefault(x8)).toBe(false);
    expect(groupChildren(tree.roots[0]!.children).merged.map((n) => n.branch)).not.toContain("x8");
  });

  it("项目源目录不算外部", () => {
    const tree = buildLineageTree([], scan, []);
    expect(tree.roots[0]!.isExternal).toBe(false);
  });

  it("branchLabel 去掉 thr 后缀并拆出末段", () => {
    expect(branchLabel("bb/d4-thr_abcdefghij")).toEqual({ prefix: "bb/", leaf: "d4" });
    expect(branchLabel("main")).toEqual({ prefix: "", leaf: "main" });
  });

  it("isSingleThreadLeaf", () => {
    const tree = buildLineageTree([thread("only", "/wt/integ")], scan, []);
    const integ = tree.roots[0]!.children.find((n) => n.branch === "feat")!.children[0]!;
    expect(isSingleThreadLeaf(integ)).toBe(true);
  });
});

describe("辅助函数", () => {
  it("buildDispatchTree 按父子嵌套", () => {
    const roots = buildDispatchTree([thread("a", null), thread("b", null, "a"), thread("c", null, "b")]);
    expect(roots.map((r) => r.thread.id)).toEqual(["a"]);
    expect(roots[0]!.children[0]!.children[0]!.thread.id).toBe("c");
  });

  it("collectAncestry 能防环", () => {
    const parentOf = new Map<string, string | null>([["a", "b"], ["b", "a"]]);
    expect([...collectAncestry("a", parentOf)].sort()).toEqual(["a", "b"]);
  });

  it("rollupIndicator 取最紧急的状态", () => {
    expect(rollupIndicator(["none", "unread-success", "waiting-for-input"])).toBe("waiting-for-input");
    expect(rollupIndicator(["none"])).toBeNull();
  });
});

describe("collectFolded", () => {
  // main ─ feat(对话) ─ integ(外部空闲)
  //      ├ x8(幽灵) ─ d1(已合回, 有对话) ─ d2(已合回)
  //      ├ gone(幽灵) ─ ext(外部空闲)
  //      └ old(已合回) ─ live(未合回, 有对话)
  const s: RepoScan = {
    ...scan,
    worktrees: [
      ...scan.worktrees.filter((w) => w.branch !== null),
      { path: "/wt/d2", branch: "d2", head: "f", isMain: false, locked: false },
      { path: "/wt/ext", branch: "ext", head: "g", isMain: false, locked: false },
      { path: "/wt/old", branch: "old", head: "h", isMain: false, locked: false },
      { path: "/wt/live", branch: "live", head: "i", isMain: false, locked: false },
    ],
    branches: [
      ...scan.branches,
      branch("d2", "d1", { mergedIntoParent: true }),
      branch("gone", "main", { worktreePath: null }),
      branch("ext", "gone"),
      branch("old", "main", { mergedIntoParent: true }),
      branch("live", "old"),
    ],
  };
  const threads = [thread("cmd", "/wt/feat"), thread("d1t", "/wt/d1", "cmd", 2), thread("lv", "/wt/live", null, 3)];
  const envs = [{ path: "/wt/feat" }, { path: "/wt/d1" }, { path: "/wt/d2" }, { path: "/wt/old" }, { path: "/wt/live" }];
  const build = () => buildLineageTree(threads, s, envs);
  const names = (nodes: { branch: string | null }[]) => nodes.map((n) => n.branch);
  const countThreads = (nodes: ReturnType<typeof build>["roots"]): number =>
    nodes.reduce((n, node) => n + node.threads.length + countThreads(node.children), 0);

  it("整棵树只出一份清单：已合回先序拍平并保留对话，空闲外部 worktree 单列", () => {
    const folded = collectFolded(build().roots);
    expect(names(folded.merged)).toEqual(["d1", "d2"]);
    expect(folded.merged[0]!.threads.map((l) => l.thread.id)).toEqual(["d1t"]);
    expect(folded.merged.every((n) => n.children.length === 0)).toBe(true);
    expect(names(folded.idleExternal).sort()).toEqual(["ext", "integ"]);
  });

  it("摘空的幽灵分叉点被丢弃，已合回但下面有未合回分支的节点留在树里", () => {
    const folded = collectFolded(build().roots);
    const main = folded.roots[0]!;
    expect(names(main.children).sort()).toEqual(["feat", "old"]);
    expect(names(main.children.find((n) => n.branch === "old")!.children)).toEqual(["live"]);
  });

  it("对话一个不丢、兄弟顺序不变、不改入参", () => {
    const tree = build();
    const before = JSON.stringify(tree.roots);
    const folded = collectFolded(tree.roots);
    expect(JSON.stringify(tree.roots)).toBe(before);
    expect(countThreads(folded.roots) + countThreads(folded.merged)).toBe(threads.length);
    const kept = new Set(names(folded.roots[0]!.children));
    expect(names(folded.roots[0]!.children)).toEqual(names(tree.roots[0]!.children).filter((b) => kept.has(b)));
  });
});
