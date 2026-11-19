/**
 * [INPUT]: 依赖 lib/contract.ts 的 Worktree / ParentSource 数据形状; 无 I/O
 * [OUTPUT]: 对外提供 parseWorktreePorcelain / parseWorktreePorcelainZ（worktree 列表解析）、parseReflogFile（分支 reflog 解析）、resolveLineage（按 recorded > 分支创建记录(命名/提交) > HEAD reflog 的 checkout 记录 判定起点并破环）、selectRelevant（相关分支集合 = worktree 分支 + 默认分支 + 额外分支 + 祖先闭包）
 * [POS]: lib 的血缘推断纯函数层; 消费者: lib/git-scan.ts、test/lineage.test.ts; 与 lib/git-scan.ts 的边界: 本文件只做文本解析与推断，所有 git 调用与文件读取在 git-scan
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import type { ParentSource, Worktree } from "./contract";

// ---------------------------------------------------------------------------
// worktree list --porcelain
// ---------------------------------------------------------------------------

const HEADS_PREFIX = "refs/heads/";

function stripHeads(ref: string): string {
  return ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref;
}

/** 字段分隔符为 fieldSep，记录之间多一个 fieldSep（即空字段）。 */
export function parseWorktreePorcelain(stdout: string, fieldSep: string): Worktree[] {
  const records: string[][] = [];
  let current: string[] = [];
  for (const field of stdout.split(fieldSep)) {
    if (field === "") {
      if (current.length > 0) records.push(current);
      current = [];
    } else {
      current.push(field);
    }
  }
  if (current.length > 0) records.push(current);

  const worktrees: Worktree[] = [];
  records.forEach((fields, index) => {
    let path: string | null = null;
    let head: string | null = null;
    let branch: string | null = null;
    let locked = false;
    let prunable = false;
    for (const field of fields) {
      const space = field.indexOf(" ");
      const key = space === -1 ? field : field.slice(0, space);
      const value = space === -1 ? "" : field.slice(space + 1);
      if (key === "worktree") path = value;
      else if (key === "HEAD") head = value;
      else if (key === "branch") branch = stripHeads(value);
      else if (key === "locked") locked = true;
      else if (key === "prunable") prunable = true;
    }
    // 第一条记录永远是主检出，即使它可被清理也保留，以免 isMain 漂移到别的记录上
    const isMain = index === 0;
    if (path === null || (prunable && !isMain)) return;
    worktrees.push({ path, branch, head, isMain, locked });
  });
  return worktrees;
}

export function parseWorktreePorcelainZ(stdout: string): Worktree[] {
  return parseWorktreePorcelain(stdout, "\0");
}

// ---------------------------------------------------------------------------
// reflog: "<old> <new> <name> <email> <unix> <tz>\t<message>"
// ---------------------------------------------------------------------------

export interface ReflogEntry {
  oldSha: string;
  newSha: string;
  time: number;
  message: string;
}

const REFLOG_LINE = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) .*? (\d+) [+-]\d{4}(?:\t(.*))?$/;

export function parseReflogFile(text: string): ReflogEntry[] {
  const entries: ReflogEntry[] = [];
  for (const line of text.split("\n")) {
    const match = REFLOG_LINE.exec(line);
    if (match === null) continue;
    entries.push({
      oldSha: match[1]!,
      newSha: match[2]!,
      time: Number(match[3]),
      message: match[4] ?? "",
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// resolveLineage
// ---------------------------------------------------------------------------

export interface BranchFacts {
  name: string;
  tip: string;
  committedAt: number | null;
  /** 文件顺序（最旧在前）；无 reflog 时为空数组 */
  reflog: ReflogEntry[];
}

export interface LineageFacts {
  branches: BranchFacts[];
  defaultBranch: string | null;
  /** bb 记录的起点：分支短名 → 起点 ref */
  recordedBases: Record<string, string>;
  /** 所有 worktree 的 HEAD reflog 合并（顺序无关）；用于解析 "Created from HEAD" */
  headReflog?: ReflogEntry[];
}

export interface ResolvedBranch {
  name: string;
  tip: string;
  createdAt: number | null;
  committedAt: number | null;
  parent: string | null;
  parentSource: ParentSource;
}

const CREATED_FROM = /^branch: Created from (.+)$/;
const CHECKOUT = /^checkout: moving from (\S+) to (\S+)$/;
/** checkout -b 的 HEAD 记录与分支创建记录写于同一命令，时间差只会是秒级 */
const HEAD_MATCH_WINDOW_SECONDS = 5;
const SHA_LIKE = /^[0-9a-f]{7,40}$/i;
const SOURCE_STRENGTH: Record<ParentSource, number> = {
  unknown: 0,
  "reflog-commit": 1,
  reflog: 2,
  recorded: 3,
};

/** 把 ref 归一为本地分支短名；无法对应到本地分支时返回 null。 */
function normalizeRef(
  ref: string,
  defaultBranch: string | null,
  local: ReadonlySet<string>,
): string | null {
  const trimmed = ref.trim();
  if (trimmed === "default") return defaultBranch;
  const candidates = [trimmed];
  for (const prefix of ["refs/heads/", "refs/remotes/origin/", "origin/"]) {
    if (trimmed.startsWith(prefix)) candidates.push(trimmed.slice(prefix.length));
  }
  // 本地分支名优先于去前缀结果：本地真的存在 "origin/x" 分支时按原样认
  return candidates.find((name) => local.has(name)) ?? null;
}

function creationEntry(branch: BranchFacts): string | null {
  const first = branch.reflog[0];
  if (first === undefined) return null;
  const match = CREATED_FROM.exec(first.message);
  return match === null ? null : match[1]!.trim();
}

/** 同分数时：默认分支优先，再按名字。 */
function compareNames(a: string, b: string, defaultBranch: string | null): number {
  if (a === defaultBranch) return -1;
  if (b === defaultBranch) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 创建记录只写了提交时，反查“当时哪个分支指向这个提交”。
 * 证据强度：别的分支 reflog 里移动到该提交的记录（非创建记录优先，其次越晚越好）
 * > 当前 tip 恰好是该提交。分支自身的“Created from”记录只说明它也从这个提交出发，
 * 是兄弟而非上游，所以排在普通记录之后，避免同一提交派生的兄弟分支互相认亲。
 */
function findBranchAtCommit(
  child: BranchFacts,
  sha: string,
  createdAt: number | null,
  facts: LineageFacts,
): string | null {
  const prefix = sha.toLowerCase();
  type Hit = { name: string; isCreation: boolean; time: number };
  let best: Hit | null = null;
  for (const other of facts.branches) {
    if (other.name === child.name) continue;
    for (const [index, entry] of other.reflog.entries()) {
      if (!entry.newSha.startsWith(prefix)) continue;
      if (createdAt !== null && entry.time > createdAt) continue;
      const hit: Hit = {
        name: other.name,
        isCreation: index === 0 && CREATED_FROM.test(entry.message),
        time: entry.time,
      };
      if (best === null || better(hit, best, facts.defaultBranch)) best = hit;
    }
  }
  if (best !== null) return best.name;

  const tipMatches = facts.branches
    .filter((other) => other.name !== child.name && other.tip.toLowerCase().startsWith(prefix))
    .filter((other) => {
      const otherCreated = other.reflog[0]?.time ?? null;
      return createdAt === null || otherCreated === null || otherCreated <= createdAt;
    })
    .map((other) => other.name)
    .sort((a, b) => compareNames(a, b, facts.defaultBranch));
  return tipMatches[0] ?? null;
}

function better(
  a: { name: string; isCreation: boolean; time: number },
  b: { name: string; isCreation: boolean; time: number },
  defaultBranch: string | null,
): boolean {
  if (a.isCreation !== b.isCreation) return !a.isCreation;
  if (a.time !== b.time) return a.time > b.time;
  return compareNames(a.name, b.name, defaultBranch) < 0;
}

function resolveOne(
  branch: BranchFacts,
  createdAt: number | null,
  facts: LineageFacts,
  local: ReadonlySet<string>,
): { parent: string | null; parentSource: ParentSource } {
  const none = { parent: null, parentSource: "unknown" as const };
  if (branch.name === facts.defaultBranch) return none;

  const recorded = facts.recordedBases[branch.name];
  if (recorded !== undefined) {
    const parent = normalizeRef(recorded, facts.defaultBranch, local);
    if (parent !== null && parent !== branch.name) return { parent, parentSource: "recorded" };
    // 记录的起点对不上本地分支（例如只存在于远端）时，退回 reflog 证据
  }

  const from = creationEntry(branch);
  if (from === null) return none;
  if (from === "HEAD") return resolveFromHead(branch, createdAt, facts, local) ?? none;

  const resolved = resolveRef(from, branch, createdAt, facts, local);
  if (resolved === null) return none;
  return { parent: resolved.parent, parentSource: resolved.kind === "named" ? "reflog" : "reflog-commit" };
}

/** 把一个 ref（分支名或提交）解析为父分支；命名优先，提交走反查。 */
function resolveRef(
  ref: string,
  branch: BranchFacts,
  createdAt: number | null,
  facts: LineageFacts,
  local: ReadonlySet<string>,
): { parent: string; kind: "named" | "commit" } | null {
  const named = normalizeRef(ref, facts.defaultBranch, local);
  if (named !== null) return named === branch.name ? null : { parent: named, kind: "named" };
  if (!SHA_LIKE.test(ref)) return null;
  const parent = findBranchAtCommit(branch, ref, createdAt, facts);
  return parent === null ? null : { parent, kind: "commit" };
}

/**
 * "Created from HEAD"（checkout -b / switch -c）时，HEAD reflog 里同一时刻会有
 * "checkout: moving from <A> to <branch>"，A 就是当时检出的分支（或提交）。
 * 优先取与创建时间相差在窗口内且最接近的记录，否则取最早的一条。
 */
function resolveFromHead(
  branch: BranchFacts,
  createdAt: number | null,
  facts: LineageFacts,
  local: ReadonlySet<string>,
): { parent: string; parentSource: ParentSource } | null {
  const moves = (facts.headReflog ?? [])
    .map((entry) => ({ entry, match: CHECKOUT.exec(entry.message) }))
    .filter(({ match }) => match !== null && match[2] === branch.name)
    .map(({ entry, match }) => ({ time: entry.time, from: match![1]! }));
  if (moves.length === 0) return null;

  const distance = (time: number) => (createdAt === null ? Number.POSITIVE_INFINITY : Math.abs(time - createdAt));
  const near = moves
    .filter((m) => distance(m.time) <= HEAD_MATCH_WINDOW_SECONDS)
    .sort((a, b) => distance(a.time) - distance(b.time));
  const chosen = near[0] ?? [...moves].sort((a, b) => a.time - b.time)[0]!;
  const resolved = resolveRef(chosen.from, branch, createdAt, facts, local);
  return resolved === null ? null : { parent: resolved.parent, parentSource: "reflog" };
}

/** 反复找环、每个环删掉最弱的一条边，直到父指针构成森林。 */
function breakCycles(byName: Map<string, ResolvedBranch>): void {
  for (const start of byName.values()) {
    const path: ResolvedBranch[] = [];
    const onPath = new Set<string>();
    let node: ResolvedBranch | undefined = start;
    while (node !== undefined && node.parent !== null) {
      if (onPath.has(node.name)) {
        const cycle = path.slice(path.findIndex((n) => n.name === node!.name));
        const weakest = cycle.reduce((w, n) => (weaker(n, w) ? n : w));
        weakest.parent = null;
        weakest.parentSource = "unknown";
        break;
      }
      onPath.add(node.name);
      path.push(node);
      node = byName.get(node.parent);
    }
  }
}

/** a 的入边是否比 b 的更该被删：来源更弱；同强度时创建更晚（无创建时间视为最晚）。 */
function weaker(a: ResolvedBranch, b: ResolvedBranch): boolean {
  const sa = SOURCE_STRENGTH[a.parentSource];
  const sb = SOURCE_STRENGTH[b.parentSource];
  if (sa !== sb) return sa < sb;
  const ta = a.createdAt ?? Number.POSITIVE_INFINITY;
  const tb = b.createdAt ?? Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta > tb;
  return a.name > b.name;
}

export function resolveLineage(facts: LineageFacts): ResolvedBranch[] {
  const local = new Set(facts.branches.map((b) => b.name));
  const resolved = facts.branches.map((branch): ResolvedBranch => {
    const createdAt = branch.reflog[0]?.time ?? null;
    return {
      name: branch.name,
      tip: branch.tip,
      createdAt,
      committedAt: branch.committedAt,
      ...resolveOne(branch, createdAt, facts, local),
    };
  });
  breakCycles(new Map(resolved.map((b) => [b.name, b])));
  return resolved;
}

// ---------------------------------------------------------------------------
// selectRelevant
// ---------------------------------------------------------------------------

export function selectRelevant(
  branches: ReadonlyArray<{ name: string; parent: string | null }>,
  worktrees: ReadonlyArray<Worktree>,
  defaultBranch: string | null,
  extraBranches: ReadonlyArray<string>,
): Set<string> {
  const parentOf = new Map(branches.map((b) => [b.name, b.parent]));
  const seeds = [
    ...worktrees.map((w) => w.branch),
    defaultBranch,
    ...extraBranches,
  ].filter((name): name is string => name !== null && parentOf.has(name));

  const relevant = new Set<string>();
  for (const seed of seeds) {
    let name: string | null | undefined = seed;
    while (name != null && parentOf.has(name) && !relevant.has(name)) {
      relevant.add(name);
      name = parentOf.get(name);
    }
  }
  return relevant;
}
