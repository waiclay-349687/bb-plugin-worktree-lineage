/**
 * [INPUT]: 依赖 lib/conversations 的 Conversation / activityOf、lib/view 的 rowColor / rowTone
 * [OUTPUT]: 对外提供 SETTLED_STORAGE_KEY / SETTLED_CHANGED_EVENT / parseSettledMap（本机 Settle 记录的存储约定） 、settledToPrune（列表加载完才清理过期记录）、isThreadSettled / isConversationSettled / splitSettledConversations（Settle 软收起判定与智能唤醒）、needsUserAttention、orderByVisual（按屏幕上的实际行序重排待办）、nextAttentionId（循环定位下一个需要处理的对话）
 * [POS]: lib 的本地软收起与快捷跳转纯逻辑; 消费者: components/lineage-list.tsx、components/settings-section.tsx（显示数量、全部移回）; 与 bb 归档的边界: 软收起只存插件本地状态，绝不触发 bb 归档，也不触碰磁盘工作区或环境
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import { activityOf, type Conversation, type ConversationLike } from "./conversations";
import { rowColor, rowTone } from "./view";

/** 本机浏览器里存 Settle 记录的键（threadId → 收起时间）；只在本机，不进 bb */
export const SETTLED_STORAGE_KEY = "worktree-lineage.settled";
/** 同一页面里有人改了 Settle 记录（例如设置页“全部移回”）时派发，列表据此重读 */
export const SETTLED_CHANGED_EVENT = "worktree-lineage:settled-changed";

/** 解析本地存储里的 Settle 记录：坏数据、非数字的时间一律丢掉，永不抛出 */
export function parseSettledMap(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const clean: Record<string, number> = {};
    for (const [id, at] of Object.entries(parsed)) if (typeof at === "number" && Number.isFinite(at)) clean[id] = at;
    return clean;
  } catch {
    return {};
  }
}

export interface SettleCheckable extends ConversationLike {
  indicator: string;
  isPinned?: boolean;
}

/**
 * 一条对话当前是否应留在 Settled 架子里：
 * - 未标记过、或已置顶：否
 * - 正在运行、等你回复、出错、或输入框有草稿：立即自动唤醒回主列表，避免漏掉待办
 * - 标记之后又出现了新的真实活动（activityOf > settledAt）：自动唤醒回主列表
 * - 仅打开看一眼（只改 updatedAt 不改 latestAttentionAt）不会唤醒
 */
export function isThreadSettled(
  thread: SettleCheckable,
  settledAt: number | undefined,
  hasDraft: boolean,
): boolean {
  if (settledAt === undefined || thread.isPinned) return false;
  const tone = rowTone(thread.indicator, hasDraft);
  if (tone === "running" || tone === "attention" || tone === "error" || tone === "draft") return false;
  return activityOf(thread, false) <= settledAt;
}

/**
 * 哪些 Settle 记录该清掉：对话已归档 / 删除（列表里找不到），或者已经被新活动唤醒。
 * 列表还没加载完（listReady 为 false）时一条都不清：加载中的列表只是一部分，按“找不到”去清会把真实的记录删掉
 * （实测：手机上刷新后 300ms 内列表还是空的，记录就被清空了）。
 */
export function settledToPrune(
  settled: Readonly<Record<string, number>>,
  lookup: (id: string) => SettleCheckable | undefined,
  draftIds: ReadonlySet<string>,
  listReady: boolean,
): string[] {
  if (!listReady) return [];
  return Object.entries(settled)
    .filter(([id, at]) => {
      const thread = lookup(id);
      return !thread || !isThreadSettled(thread, at, draftIds.has(id));
    })
    .map(([id]) => id);
}

/** 一家人（父对话及其派出的所有子对话）是否全部处于可软收起状态 */
export function isConversationSettled<T extends SettleCheckable>(
  item: Conversation<T>,
  settledMap: Readonly<Record<string, number>>,
  draftIds: ReadonlySet<string>,
): boolean {
  const rootSettledAt = settledMap[item.thread.id];
  if (!isThreadSettled(item.thread, rootSettledAt, draftIds.has(item.thread.id))) return false;
  // 子对话只要有任意一条活跃/有草稿/有晚于父完结时间的新活动，整家自动唤醒
  const checkChild = (child: Conversation<T>): boolean => {
    const childAt = settledMap[child.thread.id] ?? rootSettledAt;
    if (!isThreadSettled(child.thread, childAt, draftIds.has(child.thread.id))) return false;
    return child.children.every(checkChild);
  };
  return item.children.every(checkChild);
}

/** 将对话视图的顶层对话拆成“活跃”与 Settled 两组，保留各自原有排序 */
export function splitSettledConversations<T extends SettleCheckable>(
  items: readonly Conversation<T>[],
  settledMap: Readonly<Record<string, number>>,
  draftIds: ReadonlySet<string>,
): { active: Conversation<T>[]; settled: Conversation<T>[] } {
  const active: Conversation<T>[] = [];
  const settled: Conversation<T>[] = [];
  for (const item of items) {
    if (isConversationSettled(item, settledMap, draftIds)) settled.push(item);
    else active.push(item);
  }
  return { active, settled };
}

/** 一条对话是否属于“需要你”的待办（黄草稿 / 蓝等你或出错 / 绿完成未读） */
export function needsUserAttention(indicator: string, hasDraft: boolean): boolean {
  return rowColor(rowTone(indicator, hasDraft)) !== null;
}

/**
 * 待办按屏幕上的实际行序排：domOrder 是侧边栏里已渲染行的 threadId（文档顺序，可重复，如置顶与项目里各一行），
 * 先按它排；没渲染出来的（收起的分组里）按 fallback 原顺序接在后面。两种视图的嵌套与排序规则都不必在这里重算。
 */
export function orderByVisual(fallback: readonly string[], domOrder: readonly (string | null)[]): string[] {
  const wanted = new Set(fallback);
  const seen = new Set<string>();
  for (const id of domOrder) if (id && wanted.has(id)) seen.add(id);
  return [...seen, ...fallback.filter((id) => !seen.has(id))];
}

/**
 * 在按侧边栏视觉顺序排列的待办对话列表里循环跳到下一条 / 上一条。
 * - 当前对话不在待办列表中时：前进取第一条，后退取最后一条
 * - 只有 1 条待办且就是当前对话时，仍返回该条（便于滚动定位）
 */
export function nextAttentionId(
  orderedAttentionIds: readonly string[],
  activeThreadId: string | null,
  direction: 1 | -1 = 1,
): string | null {
  if (orderedAttentionIds.length === 0) return null;
  const idx = activeThreadId ? orderedAttentionIds.indexOf(activeThreadId) : -1;
  if (idx === -1) {
    return direction === 1 ? orderedAttentionIds[0]! : orderedAttentionIds[orderedAttentionIds.length - 1]!;
  }
  const next = (idx + direction + orderedAttentionIds.length) % orderedAttentionIds.length;
  return orderedAttentionIds[next]!;
}
