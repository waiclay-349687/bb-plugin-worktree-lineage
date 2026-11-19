/**
 * [INPUT]: 依赖 lib/contract 的 RepoScan / BranchNode 数据形状
 * [OUTPUT]: 对外提供 buildLineageTree（按代码从哪来）、buildDispatchTree（按谁派的）、collectFolded（把已合回/空闲外部 worktree 从树里摘到项目页脚）、collectAncestry、rollupIndicator
 * [POS]: lib 的纯函数视图层; 消费者: components/lineage-list.tsx; 与 lib/lineage.ts 的边界: 那边算分支血缘，这边把对话挂到血缘树上
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import type { BranchNode, RepoScan } from "./contract";

/** 本模块只读线程的这几个字段，便于脱离 SDK 单测 */
export interface ThreadLike {
  id: string;
  projectId: string | null;
  parentThreadId: string | null;
  createdAt: number;
  updatedAt: number;
  indicator: string;
  environment: { path: string | null; branchName: string | null } | null;
}

export interface ThreadLeaf<T extends ThreadLike = ThreadLike> {
  thread: T;
  /** 同一 worktree 内的子对话（共用 worktree 时才嵌在这里） */
  children: ThreadLeaf<T>[];
  /** 上级对话在别的 worktree 时，记下上级 id，行上标“派自 …” */
  dispatchedBy: string | null;
}

export interface BranchView<T extends ThreadLike = ThreadLike> {
  key: string;
  /** 分支短名；分离 HEAD 的 worktree 为 null */
  branch: string | null;
  worktreePath: string | null;
  isMain: boolean;
  /** worktree 存在但 bb 没登记环境 */
  isExternal: boolean;
  /** 没有 worktree、也没有对话，仅作分叉点存在 */
  isGhost: boolean;
  /** 起点分支（从哪切出来）；默认分支或查不到时为 null */
  parentBranch: string | null;
  merged: boolean;
  mergedInto: string | null;
  ahead: number | null;
  parentSource: BranchNode["parentSource"] | null;
  threads: ThreadLeaf<T>[];
  children: BranchView<T>[];
  /** 子树最近活动时间，用于排序 */
  activityAt: number;
}

export interface LineageTree<T extends ThreadLike = ThreadLike> {
  roots: BranchView<T>[];
  defaultBranch: string | null;
  /** 挂不到任何分支上的对话（例如非 git 目录、扫描失败） */
  loose: ThreadLeaf<T>[];
}

const normalizePath = (p: string) => p.replace(/\/+$/, "");

/** 把一组对话按“同 worktree 内的父子关系”组成森林；跨 worktree 的父子只记 dispatchedBy */
function nestThreads<T extends ThreadLike>(threads: T[]): ThreadLeaf<T>[] {
  const leaves = new Map<string, ThreadLeaf<T>>();
  for (const thread of threads) leaves.set(thread.id, { thread, children: [], dispatchedBy: null });
  const roots: ThreadLeaf<T>[] = [];
  for (const leaf of leaves.values()) {
    const parentId = leaf.thread.parentThreadId;
    const parentLeaf = parentId ? leaves.get(parentId) : undefined;
    if (parentLeaf) {
      parentLeaf.children.push(leaf);
    } else {
      leaf.dispatchedBy = parentId;
      roots.push(leaf);
    }
  }
  const sort = (list: ThreadLeaf<T>[]) => {
    list.sort((a, b) => b.thread.createdAt - a.thread.createdAt);
    for (const item of list) sort(item.children);
  };
  sort(roots);
  return roots;
}

function latestActivity<T extends ThreadLike>(leaves: ThreadLeaf<T>[]): number {
  let at = 0;
  for (const leaf of leaves) at = Math.max(at, leaf.thread.updatedAt, latestActivity(leaf.children));
  return at;
}

/**
 * 按“代码从哪来”建树：分支血缘为主干，对话按所在 worktree 路径挂到分支节点。
 * 定位规则：先按环境路径匹配 worktree（最准），再按分支名匹配，都不中则进 loose。
 */
export function buildLineageTree<T extends ThreadLike>(
  threads: T[],
  scan: RepoScan,
  environments: readonly { path: string; base?: string | null }[],
): LineageTree<T> {
  // 项目源目录是 bb 自己的项目检出，即便没有环境记录也不算“外部”
  const registered = new Set([...environments.map((e) => normalizePath(e.path)), normalizePath(scan.sourcePath)]);
  /** 分离 HEAD 的 worktree 没有分支可连，用 bb 记录的起点把它挂回树上 */
  const baseByPath = new Map(
    environments.flatMap((e) => (e.base ? [[normalizePath(e.path), normalizeRef(e.base, scan.defaultBranch)] as const] : [])),
  );
  const byBranch = new Map(scan.branches.map((b) => [b.name, b]));
  const nodeKeyByPath = new Map<string, string>();
  const nodes = new Map<string, BranchView<T>>();

  const makeNode = (key: string, init: Partial<BranchView<T>>): BranchView<T> => {
    const node: BranchView<T> = {
      key,
      branch: null,
      worktreePath: null,
      isMain: false,
      isExternal: false,
      isGhost: false,
      parentBranch: null,
      merged: false,
      mergedInto: null,
      ahead: null,
      parentSource: null,
      threads: [],
      children: [],
      activityAt: 0,
      ...init,
    };
    nodes.set(key, node);
    return node;
  };

  for (const branch of scan.branches) {
    makeNode(`b:${branch.name}`, {
      branch: branch.name,
      worktreePath: branch.worktreePath,
      parentBranch: branch.parent,
      merged: branch.mergedIntoParent,
      mergedInto: branch.mergedIntoParent ? branch.parent : null,
      ahead: branch.aheadOfParent,
      parentSource: branch.parentSource,
      activityAt: (branch.committedAt ?? 0) * 1000,
    });
  }
  for (const worktree of scan.worktrees) {
    const path = normalizePath(worktree.path);
    const key = worktree.branch && byBranch.has(worktree.branch) ? `b:${worktree.branch}` : `w:${path}`;
    const node = nodes.get(key) ?? makeNode(key, { branch: worktree.branch, worktreePath: worktree.path });
    node.worktreePath = worktree.path;
    node.isMain = worktree.isMain;
    node.isExternal = !registered.has(path);
    nodeKeyByPath.set(path, key);
  }

  // 对话定位
  const placeOf = new Map<string, string>();
  const loose: T[] = [];
  for (const thread of threads) {
    const env = thread.environment;
    const byPath = env?.path ? nodeKeyByPath.get(normalizePath(env.path)) : undefined;
    const byName = env?.branchName && nodes.has(`b:${env.branchName}`) ? `b:${env.branchName}` : undefined;
    const key = byPath ?? byName;
    if (key) placeOf.set(thread.id, key);
    else loose.push(thread);
  }
  const grouped = new Map<string, T[]>();
  for (const thread of threads) {
    const key = placeOf.get(thread.id);
    if (!key) continue;
    const list = grouped.get(key) ?? [];
    list.push(thread);
    grouped.set(key, list);
  }
  for (const [key, list] of grouped) {
    const node = nodes.get(key)!;
    node.threads = nestThreads(list);
    node.activityAt = Math.max(node.activityAt, latestActivity(node.threads));
  }

  // 连边：分支节点按 parent 挂；分离 HEAD 的 worktree 节点按 bb 记录的起点挂，查不到挂在根
  const roots: BranchView<T>[] = [];
  for (const node of nodes.values()) {
    const parentName = node.branch
      ? byBranch.get(node.branch)?.parent ?? null
      : node.worktreePath
        ? baseByPath.get(normalizePath(node.worktreePath)) ?? null
        : null;
    const parent = parentName ? nodes.get(`b:${parentName}`) : undefined;
    if (!node.branch) node.parentBranch = parentName;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  // 自底向上：活动时间冒泡、标记幽灵节点、剪掉既无对话也无后代的无 worktree 节点
  const finish = (node: BranchView<T>): boolean => {
    node.children = node.children.filter(finish);
    for (const child of node.children) node.activityAt = Math.max(node.activityAt, child.activityAt);
    node.isGhost = node.worktreePath === null && node.threads.length === 0;
    const keep = node.worktreePath !== null || node.threads.length > 0 || node.children.length > 0;
    node.children.sort(compareNodes);
    return keep;
  };
  const kept = roots.filter(finish).sort(compareNodes);
  // 默认分支排第一，其余按活动
  if (scan.defaultBranch) {
    const i = kept.findIndex((n) => n.branch === scan.defaultBranch);
    if (i > 0) kept.unshift(...kept.splice(i, 1));
  }
  return { roots: kept, defaultBranch: scan.defaultBranch, loose: nestThreads(loose) };
}

/** "origin/x"、"refs/heads/x" → "x"；"default" → 默认分支 */
function normalizeRef(ref: string, defaultBranch: string | null): string | null {
  if (ref === "default") return defaultBranch;
  return ref.replace(/^refs\/heads\//, "").replace(/^(refs\/remotes\/)?origin\//, "");
}

/** 未合回的在前、已合回的沉底；同组按最近活动 */
function compareNodes(a: BranchView, b: BranchView): number {
  if (a.merged !== b.merged) return a.merged ? 1 : -1;
  return b.activityAt - a.activityAt;
}

/** 按“谁派的”建树（备用视图，也是扫描失败时的兜底） */
export function buildDispatchTree<T extends ThreadLike>(threads: T[]): ThreadLeaf<T>[] {
  const leaves = new Map<string, ThreadLeaf<T>>();
  for (const thread of threads) leaves.set(thread.id, { thread, children: [], dispatchedBy: null });
  const roots: ThreadLeaf<T>[] = [];
  for (const leaf of leaves.values()) {
    const parent = leaf.thread.parentThreadId ? leaves.get(leaf.thread.parentThreadId) : undefined;
    if (parent) parent.children.push(leaf);
    else roots.push(leaf);
  }
  const sort = (list: ThreadLeaf<T>[]) => {
    list.sort((a, b) => b.thread.updatedAt - a.thread.updatedAt);
    for (const item of list) sort(item.children);
  };
  sort(roots);
  return roots;
}

/** 某对话的全部祖先 id（用于“点指挥官 → 高亮它派出的对话”） */
export function collectAncestry(threadId: string, parentOf: ReadonlyMap<string, string | null>): Set<string> {
  const seen = new Set<string>();
  let current = parentOf.get(threadId) ?? null;
  while (current && !seen.has(current)) {
    seen.add(current);
    current = parentOf.get(current) ?? null;
  }
  return seen;
}

/** 折叠时代表整棵子树的状态：失败 > 等你 > 运行中 > 未读完成 */
const INDICATOR_PRIORITY = ["unread-error", "waiting-for-input", "runtime", "workflow", "background-agent", "background-command", "goal", "plan-mode", "unread-success"];

export function rollupIndicator(indicators: Iterable<string>): string | null {
  let best: string | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const indicator of indicators) {
    const rank = INDICATOR_PRIORITY.indexOf(indicator);
    if (rank !== -1 && rank < bestRank) {
      best = indicator;
      bestRank = rank;
    }
  }
  return best;
}

export function* walkThreads<T extends ThreadLike>(leaves: ThreadLeaf<T>[]): Generator<T> {
  for (const leaf of leaves) {
    yield leaf.thread;
    yield* walkThreads(leaf.children);
  }
}

export function* walkBranchThreads<T extends ThreadLike>(node: BranchView<T>): Generator<T> {
  yield* walkThreads(node.threads);
  for (const child of node.children) yield* walkBranchThreads(child);
}

/**
 * 渲染分组：把一个节点的子分支分成三类，减少行数。
 * - active:       正常显示的子分支
 * - merged:       已合回上游、且子树里没有未合回内容的，折叠成一行“已合回 · N”
 * - idleExternal: 外部 worktree、无对话、无后代的，折叠成一行“外部 worktree · N”
 */
export function groupChildren<T extends ThreadLike>(children: BranchView<T>[]): {
  active: BranchView<T>[];
  merged: BranchView<T>[];
  idleExternal: BranchView<T>[];
} {
  const active: BranchView<T>[] = [];
  const merged: BranchView<T>[] = [];
  const idleExternal: BranchView<T>[] = [];
  for (const child of children) {
    const idle = child.threads.length === 0 && child.children.length === 0;
    if (isCollapsedByDefault(child)) merged.push(child);
    else if (child.isExternal && idle) idleExternal.push(child);
    else active.push(child);
  }
  return { active, merged, idleExternal };
}

export interface FoldedTree<T extends ThreadLike = ThreadLike> {
  /** 摘掉折叠项之后剩下的树（新节点，不改入参） */
  roots: BranchView<T>[];
  /** 已合回且子树里没有未合回内容的分支，拍平成一维；各自的对话保留在 threads 上 */
  merged: BranchView<T>[];
  /** 没有对话、没有后代的外部 worktree */
  idleExternal: BranchView<T>[];
}

/**
 * 整棵树只出一份折叠清单：逐层用 groupChildren 的规则分类，把 merged / idleExternal 摘出来拍平，
 * 供界面在项目底部用一行“已合回 N · 外部 N”收纳，而不是每层重复一行。
 * 摘完后变空的节点跟着处理：幽灵分叉点直接丢弃；其余按同一规则重新分类（外部的进 idleExternal、已合回的进 merged）。
 * 纯函数：返回新节点，入参的 children 不被改动。
 */
export function collectFolded<T extends ThreadLike>(roots: BranchView<T>[]): FoldedTree<T> {
  const merged: BranchView<T>[] = [];
  const idleExternal: BranchView<T>[] = [];
  // 已合回的子树整棵都是已合回的：先序拍平，幽灵节点没有可看的内容，不进清单
  const flatten = (node: BranchView<T>) => {
    if (!node.isGhost) merged.push({ ...node, children: [] });
    node.children.forEach(flatten);
  };
  const prune = (nodes: BranchView<T>[]): BranchView<T>[] => {
    const groups = groupChildren(nodes);
    groups.merged.forEach(flatten);
    idleExternal.push(...groups.idleExternal);
    const kept: BranchView<T>[] = [];
    for (const node of groups.active) {
      const next: BranchView<T> = { ...node, children: prune(node.children) };
      const emptied = node.children.length > 0 && next.children.length === 0;
      if (!emptied) {
        kept.push(next);
        continue;
      }
      if (next.threads.length === 0 && next.worktreePath === null) continue;
      const regroup = groupChildren([next]);
      merged.push(...regroup.merged);
      idleExternal.push(...regroup.idleExternal);
      kept.push(...regroup.active);
    }
    return kept;
  };
  return { roots: prune(roots), merged, idleExternal };
}

/**
 * 分支头默认是否折叠：只有“自己已合回、且子树里没有未合回分支”才折叠。
 * 已合回的分叉点（如 mobile/x8）下面常挂着还在进行的分支，折叠它会把正在干活的对话藏起来。
 */
export function isCollapsedByDefault(node: BranchView): boolean {
  return node.merged && !hasUnmergedDescendant(node);
}

function hasUnmergedDescendant(node: BranchView): boolean {
  return node.children.some((c) => !c.merged || hasUnmergedDescendant(c));
}

/** 只有一个对话、没有子分支的节点：分支并入对话行，渲染成两行卡片（标题 / 分支） */
export function isSingleThreadLeaf(node: BranchView): boolean {
  return node.children.length === 0 && node.threads.length === 1 && node.threads[0]!.children.length === 0;
}

/** 分支显示名：去掉 bb 的 "-thr_xxxx" 后缀，拆成弱化的前缀与醒目的末段 */
export function branchLabel(branch: string): { prefix: string; leaf: string } {
  const clean = branch.replace(/-thr_[a-z0-9]+$/i, "");
  const i = clean.lastIndexOf("/");
  return i === -1 ? { prefix: "", leaf: clean } : { prefix: clean.slice(0, i + 1), leaf: clean.slice(i + 1) };
}
