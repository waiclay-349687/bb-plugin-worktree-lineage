import { describe, expect, it } from "vitest";
import {
  type BranchFacts,
  type ReflogEntry,
  parseReflogFile,
  parseWorktreePorcelain,
  parseWorktreePorcelainZ,
  resolveLineage,
  selectRelevant,
} from "../lib/lineage";

const ZERO = "0".repeat(40);
const sha = (c: string) => c.repeat(40);

function entry(oldSha: string, newSha: string, time: number, message: string): ReflogEntry {
  return { oldSha, newSha, time, message };
}

function branch(name: string, tip: string, reflog: ReflogEntry[] = []): BranchFacts {
  return { name, tip, committedAt: 100, reflog };
}

function parents(result: ReturnType<typeof resolveLineage>) {
  return Object.fromEntries(result.map((b) => [b.name, [b.parent, b.parentSource]]));
}

describe("parseWorktreePorcelainZ", () => {
  it("marks first record as main, strips refs/heads/, handles detached/locked, drops prunable", () => {
    const out = [
      "worktree /repo", `HEAD ${sha("a")}`, "branch refs/heads/main", "",
      "worktree /wt/feat", `HEAD ${sha("b")}`, "branch refs/heads/feat/x", "locked", "",
      "worktree /wt/det", `HEAD ${sha("c")}`, "detached", "",
      "worktree /wt/gone", `HEAD ${sha("d")}`, "branch refs/heads/gone", "prunable gitdir file points to non-existent location", "",
    ].join("\0") + "\0";
    expect(parseWorktreePorcelainZ(out)).toEqual([
      { path: "/repo", head: sha("a"), branch: "main", isMain: true, locked: false },
      { path: "/wt/feat", head: sha("b"), branch: "feat/x", isMain: false, locked: true },
      { path: "/wt/det", head: sha("c"), branch: null, isMain: false, locked: false },
    ]);
  });

  it("parses the newline (non -z) format the same way", () => {
    const out = `worktree /repo\nHEAD ${sha("a")}\nbranch refs/heads/main\n\nworktree /wt/det\nHEAD ${sha("c")}\ndetached\n\n`;
    expect(parseWorktreePorcelain(out, "\n").map((w) => [w.path, w.branch, w.isMain])).toEqual([
      ["/repo", "main", true],
      ["/wt/det", null, false],
    ]);
  });
});

describe("parseReflogFile", () => {
  it("parses entries and keeps messages with tabs/spaces", () => {
    const text =
      `${ZERO} ${sha("a")} Jane Doe <j@x.io> 1700000000 +0700\tbranch: Created from main\n` +
      `${sha("a")} ${sha("b")} Jane Doe <j@x.io> 1700000100 -0300\tcommit: fix: a\tb\n` +
      "garbage line\n";
    expect(parseReflogFile(text)).toEqual([
      { oldSha: ZERO, newSha: sha("a"), time: 1700000000, message: "branch: Created from main" },
      { oldSha: sha("a"), newSha: sha("b"), time: 1700000100, message: "commit: fix: a\tb" },
    ]);
  });
});

describe("resolveLineage", () => {
  const main = branch("main", sha("1"), [
    entry(ZERO, sha("1"), 10, "branch: Created from HEAD"),
  ]);

  it("named branch, sha of another tip, HEAD and default branch", () => {
    const feat = branch("feat", sha("3"), [
      entry(ZERO, sha("1"), 20, "branch: Created from main"),
      entry(sha("1"), sha("2"), 30, "commit: a"),
      entry(sha("2"), sha("3"), 50, "commit: b"),
    ]);
    const child = branch("child", sha("4"), [
      entry(ZERO, sha("2"), 40, "branch: Created from 2222222"),
    ]);
    const viaHead = branch("viaHead", sha("5"), [entry(ZERO, sha("1"), 60, "branch: Created from HEAD")]);
    const noLog = branch("noLog", sha("6"));
    const remote = branch("remote", sha("7"), [entry(ZERO, sha("1"), 61, "branch: Created from origin/main")]);
    const r = resolveLineage({
      branches: [main, feat, child, viaHead, noLog, remote],
      defaultBranch: "main",
      recordedBases: {},
    });
    expect(parents(r)).toEqual({
      main: [null, "unknown"],
      feat: ["main", "reflog"],
      child: ["feat", "reflog-commit"],
      viaHead: [null, "unknown"],
      noLog: [null, "unknown"],
      remote: ["main", "reflog"],
    });
    expect(r.find((b) => b.name === "feat")!.createdAt).toBe(20);
    expect(r.find((b) => b.name === "noLog")!.createdAt).toBeNull();
  });

  it("ignores reflog entries newer than the child's creation", () => {
    const late = branch("late", sha("2"), [entry(ZERO, sha("2"), 99, "commit: later")]);
    const early = branch("early", sha("3"), [
      entry(ZERO, sha("1"), 5, "branch: Created from main"),
      entry(sha("1"), sha("2"), 6, "commit: x"),
      entry(sha("2"), sha("3"), 7, "commit: y"),
    ]);
    const child = branch("child", sha("4"), [entry(ZERO, sha("2"), 50, "branch: Created from 2222222")]);
    const r = resolveLineage({ branches: [main, late, early, child], defaultBranch: "main", recordedBases: {} });
    expect(parents(r).child).toEqual(["early", "reflog-commit"]);
  });

  it("siblings cut from the same commit point at the owner, not at each other", () => {
    const x8 = branch("x8", sha("2"), [
      entry(ZERO, sha("1"), 10, "branch: Created from main"),
      entry(sha("1"), sha("2"), 20, "commit: x"),
    ]);
    const d1 = branch("d1", sha("3"), [entry(ZERO, sha("2"), 30, "branch: Created from 2222222")]);
    const d2 = branch("d2", sha("4"), [entry(ZERO, sha("2"), 40, "branch: Created from 2222222")]);
    const r = resolveLineage({ branches: [main, x8, d1, d2], defaultBranch: "main", recordedBases: {} });
    expect(parents(r).d1).toEqual(["x8", "reflog-commit"]);
    expect(parents(r).d2).toEqual(["x8", "reflog-commit"]);
  });

  it("falls back to a branch whose current tip is the commit; tie prefers default branch", () => {
    const other = branch("aaa", sha("1"));
    const child = branch("child", sha("4"), [entry(ZERO, sha("1"), 50, "branch: Created from 1111111")]);
    const mainNoLog = branch("main", sha("1"));
    const r = resolveLineage({ branches: [other, mainNoLog, child], defaultBranch: "main", recordedBases: {} });
    expect(parents(r).child).toEqual(["main", "reflog-commit"]);
  });

  it("recordedBases override reflog, normalising origin/x, refs/heads/x and default", () => {
    const feat = branch("feat", sha("2"), [entry(ZERO, sha("1"), 20, "branch: Created from main")]);
    const a = branch("a", sha("3"), [entry(ZERO, sha("2"), 30, "branch: Created from feat")]);
    const b = branch("b", sha("4"), [entry(ZERO, sha("2"), 31, "branch: Created from feat")]);
    const c = branch("c", sha("5"), [entry(ZERO, sha("2"), 32, "branch: Created from feat")]);
    const d = branch("d", sha("6"), [entry(ZERO, sha("2"), 33, "branch: Created from feat")]);
    const r = resolveLineage({
      branches: [main, feat, a, b, c, d],
      defaultBranch: "main",
      recordedBases: {
        main: "feat",
        a: "origin/main",
        b: "default",
        c: "refs/remotes/origin/feat",
        d: "origin/does-not-exist",
      },
    });
    expect(parents(r)).toMatchObject({
      main: [null, "unknown"],
      a: ["main", "recorded"],
      b: ["main", "recorded"],
      c: ["feat", "recorded"],
      d: ["feat", "reflog"],
    });
  });

  it("breaks cycles by dropping the weakest edge, then the most recently created", () => {
    const p = branch("p", sha("2"), [entry(ZERO, sha("1"), 10, "branch: Created from q")]);
    const q = branch("q", sha("3"), [entry(ZERO, sha("1"), 20, "branch: Created from p")]);
    const weak = resolveLineage({ branches: [p, q], defaultBranch: null, recordedBases: { p: "q" } });
    expect(parents(weak)).toEqual({ p: ["q", "recorded"], q: [null, "unknown"] });

    const tie = resolveLineage({ branches: [p, q], defaultBranch: null, recordedBases: {} });
    expect(parents(tie)).toEqual({ p: ["q", "reflog"], q: [null, "unknown"] });

    const self = resolveLineage({ branches: [p], defaultBranch: null, recordedBases: { p: "p" } });
    expect(parents(self).p).toEqual([null, "unknown"]);
  });
});

describe("resolveLineage: Created from HEAD via HEAD reflog", () => {
  const main = branch("main", sha("1"), [entry(ZERO, sha("1"), 10, "branch: Created from HEAD")]);
  const feat = branch("feat", sha("2"), [
    entry(ZERO, sha("1"), 20, "branch: Created from main"),
    entry(sha("1"), sha("2"), 30, "commit: a"),
  ]);
  const child = branch("child", sha("3"), [entry(ZERO, sha("2"), 100, "branch: Created from HEAD")]);
  const resolve = (headReflog: ReflogEntry[], recordedBases: Record<string, string> = {}) =>
    parents(resolveLineage({ branches: [main, feat, child], defaultBranch: "main", recordedBases, headReflog })).child;

  it("takes the checkout entry closest to the creation time", () => {
    expect(
      resolve([
        entry(sha("1"), sha("2"), 50, "checkout: moving from main to child"),
        entry(sha("2"), sha("2"), 101, "checkout: moving from feat to child"),
        entry(sha("2"), sha("1"), 102, "checkout: moving from child to main"),
      ]),
    ).toEqual(["feat", "reflog"]);
  });

  it("falls back to the earliest checkout into the branch", () => {
    expect(
      resolve([
        entry(sha("1"), sha("2"), 300, "checkout: moving from feat to child"),
        entry(sha("1"), sha("2"), 200, "checkout: moving from main to child"),
      ]),
    ).toEqual(["main", "reflog"]);
  });

  it("resolves a detached sha like reflog-commit, but labels it reflog", () => {
    expect(resolve([entry(sha("2"), sha("2"), 100, `checkout: moving from ${sha("2")} to child`)])).toEqual([
      "feat",
      "reflog",
    ]);
  });

  it("stays unknown without evidence and loses to recorded", () => {
    expect(resolve([])).toEqual([null, "unknown"]);
    expect(resolve([entry(sha("1"), sha("2"), 100, "checkout: moving from child to child")])).toEqual([null, "unknown"]);
    expect(resolve([entry(sha("1"), sha("2"), 100, "checkout: moving from feat to child")], { child: "main" })).toEqual([
      "main",
      "recorded",
    ]);
  });
});

describe("selectRelevant", () => {
  it("includes worktree branches, default, extras and ghost ancestors only", () => {
    const branches = [
      { name: "main", parent: null },
      { name: "feat", parent: "main" },
      { name: "child", parent: "feat" },
      { name: "unrelated", parent: "main" },
      { name: "extra", parent: null },
    ];
    const worktrees = [
      { path: "/r", branch: "main", head: null, isMain: true, locked: false },
      { path: "/w", branch: "child", head: null, isMain: false, locked: false },
      { path: "/d", branch: null, head: null, isMain: false, locked: false },
    ];
    expect([...selectRelevant(branches, worktrees, "main", ["extra", "missing"])].sort()).toEqual([
      "child", "extra", "feat", "main",
    ]);
  });
});
