/**
 * [INPUT]: 依赖 lib/tree 的 BranchView / LineageTree / collectFolded / branchLabel
 * [OUTPUT]: 对外提供 buildProjectView（血缘树 → 卡片/分叉点视图模型）、pathLabels、toneOf / rollupTone / rowTone / rowColor（状态色调）
 * [POS]: lib 的展示模型层，纯函数; 消费者: components/lineage-list.tsx; 与 lib/tree.ts 的边界: tree 决定“谁挂在谁下面”，本文件决定“画成什么”（卡片 / 分叉点标签 / 并入路径 / 收进页脚）
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import { branchLabel, collectFolded, type BranchView, type LineageTree, type ThreadLeaf, type ThreadLike } from "./tree";

/**
 * 视图节点只有两种：
 * - card: 有对话的 worktree，一张卡片
 * - fork: 没有对话、但下面分出 ≥2 条线的分支，只画一行小标签
 * 没有对话且只有一个后继的分支不单独占行，并入后继的 via（像 VS Code 把单子目录压成 a/b/c）。
 */
export interface ViewNode<T extends ThreadLike = ThreadLike> {
  kind: "card" | "fork";
  key: string;
  /** 被压进来的上游分支，从远到近 */
  via: BranchView<T>[];
  node: BranchView<T>;
  children: ViewNode<T>[];
}

export interface ProjectView<T extends ThreadLike = ThreadLike> {
  roots: ViewNode<T>[];
  /** 已合回上游的分支（可能还带着对话），收进项目页脚 */
  merged: BranchView<T>[];
  /** 没有对话的 worktree（外部的或 bb 的），收进项目页脚，可在那里开新对话 */
  idle: BranchView<T>[];
  /** 挂不到任何分支的对话 */
  loose: ThreadLeaf<T>[];
}

export function buildProjectView<T extends ThreadLike>(tree: LineageTree<T>): ProjectView<T> {
  const folded = collectFolded(tree.roots);
  const idle = [...folded.idleExternal];

  const convert = (node: BranchView<T>, via: BranchView<T>[]): ViewNode<T>[] => {
    if (node.threads.length > 0) {
      return [{ kind: "card", key: node.key, via, node, children: node.children.flatMap((c) => convert(c, [])) }];
    }
    // 没有对话：先看后代里还剩什么要画
    const children = node.children.flatMap((c) => convert(c, []));
    if (children.length === 0) {
      if (node.worktreePath !== null) idle.push(node);
      return [];
    }
    if (children.length === 1) {
      const only = children[0]!;
      return [{ ...only, via: [...via, node, ...only.via] }];
    }
    return [{ kind: "fork", key: node.key, via, node, children }];
  };

  return {
    // 根上的默认分支不占路径：所有分支本来就源自它，写出来只是噪音
    roots: folded.roots
      .flatMap((root) => convert(root, []))
      .map((root) => (root.via.length > 0 && root.via[0]!.branch === tree.defaultBranch ? { ...root, via: root.via.slice(1) } : root)),
    merged: folded.merged,
    idle,
    loose: tree.loose,
  };
}

/** 路径上每一段的显示名（去掉 thr 后缀与前缀），相邻重名只留一个：bb/c1-thr_x › mobile/c1 → ["c1"] */
export function pathLabels(via: readonly BranchView[], node: BranchView): string[] {
  const names: string[] = [];
  for (const step of [...via, node]) {
    const name = step.branch === null ? "分离 HEAD" : branchLabel(step.branch).leaf;
    if (names[names.length - 1] !== name) names.push(name);
  }
  return names;
}

/** 状态色调：界面只认这四种，颜色由主题变量决定 */
export type Tone = "error" | "attention" | "running" | "done";

const TONE_BY_INDICATOR: Record<string, Tone> = {
  "unread-error": "error",
  "waiting-for-input": "attention",
  runtime: "running",
  workflow: "running",
  "background-agent": "running",
  "background-command": "running",
  goal: "running",
  "working-draft": "running",
  "unread-success": "done",
};
const TONE_RANK: Tone[] = ["error", "attention", "running", "done"];

export function toneOf(indicator: string): Tone | null {
  return TONE_BY_INDICATOR[indicator] ?? null;
}

/** 一行对话的颜色：四种状态色，加上“输入框里有没发出去的内容” */
export type RowTone = Tone | "draft";

/**
 * 一行对话该用哪种颜色。颜色本身就是含义，所以只能有一个，按“多需要你”排先后：
 * 出错 > 等你回复 > 有草稿 > 运行中 > 已完成未读。
 * 草稿排在运行中之前：它在跑不需要你做什么，而写了一半的话是你自己欠着的。
 */
export function rowTone(indicator: string, hasDraft: boolean): RowTone | null {
  const tone = toneOf(indicator);
  if (tone === "error" || tone === "attention") return tone;
  return hasDraft ? "draft" : tone;
}

/**
 * 整行的底色，三种含义（运行中不给整行上色，它有流光描边）：
 * - draft:   黄。球在你手里，而且是你自己欠着的：输入框里写了一半没发
 * - waiting: 蓝。它停下来等你：问了你问题，或者出错了。两者要你做的事一样（过去看、回应），所以同色；谁是谁由行尾的标记区分
 * - done:    绿。它做完了，你还没看
 */
export type RowColor = "draft" | "waiting" | "done";

export function rowColor(tone: RowTone | null): RowColor | null {
  if (tone === "draft") return "draft";
  if (tone === "error" || tone === "attention") return "waiting";
  if (tone === "done") return "done";
  return null;
}

/** 一组对话里最需要注意的色调：出错 > 等你 > 运行中 > 已完成未读 */
export function rollupTone(indicators: Iterable<string>): Tone | null {
  let best = TONE_RANK.length;
  for (const indicator of indicators) {
    const tone = toneOf(indicator);
    if (tone !== null) best = Math.min(best, TONE_RANK.indexOf(tone));
  }
  return TONE_RANK[best] ?? null;
}

export function countViewThreads(nodes: readonly ViewNode[]): number {
  let total = 0;
  const countLeaves = (leaves: readonly ThreadLeaf[]): number =>
    leaves.reduce((sum, leaf) => sum + 1 + countLeaves(leaf.children), 0);
  for (const node of nodes) total += countLeaves(node.node.threads) + countViewThreads(node.children);
  return total;
}

/** 相对时间，尽量短：刚刚 / 5m / 3h / 2d / 3w */
export function relativeTime(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 14 ? `${days}d` : `${Math.floor(days / 7)}w`;
}
