/**
 * [INPUT]: 无外部依赖
 * [OUTPUT]: 对外提供 buildConversations（“对话视图”的模型：项目里的对话按“谁派的”嵌套、按最近活动排序）、activityOf（一条对话最近一次真正的活动时间）
 * [POS]: lib 的展示模型层，纯函数; 消费者: components/lineage-list.tsx; 与 lib/view.ts 的边界: view.ts 服务“分支树视图”（分支是主角），本文件服务“对话视图”（对话是主角，完全不看分支）
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */

export interface ConversationLike {
  id: string;
  parentThreadId: string | null;
  createdAt: number;
  updatedAt: number;
  /** 上一次轮到用户的时间（一轮结束、提问、出错）；只是打开看一眼不会改它 */
  latestAttentionAt?: number | null;
}

export interface Conversation<T extends ConversationLike = ConversationLike> {
  thread: T;
  /** 它派出的对话，新派的在上；顺序稳定，不随活动跳动 */
  children: Conversation<T>[];
  /** 这一家（它和它派出的全部对话）最近一次活动 */
  activityAt: number;
}

/**
 * 一条对话最近一次真正的活动时间。
 * 不直接用 updatedAt：只是点开看一眼它也会变，按它排序的话点过的行会跳到最上面。
 * 正在跑的对话才用 updatedAt（那时它反映的是进展）；其余用“上一次轮到用户”的时间。
 */
export function activityOf(thread: ConversationLike, running: boolean): number {
  const attention = thread.latestAttentionAt ?? 0;
  return running ? Math.max(thread.updatedAt, attention) : Math.max(attention, thread.createdAt);
}

/**
 * 把一个项目里的对话排成“对话视图”：
 * - 被派出的对话挂在派它的对话下面（上级不在这个列表里时，它自己就是顶层）
 * - 顶层按一家人里最近的活动排序：下级刚动过，这一家也跟着靠前
 */
export function buildConversations<T extends ConversationLike>(threads: readonly T[], isRunning: (thread: T) => boolean): Conversation<T>[] {
  const nodes = new Map<string, Conversation<T>>(
    threads.map((thread) => [thread.id, { thread, children: [], activityAt: activityOf(thread, isRunning(thread)) }]),
  );
  /** 沿上级一路往上能不能走回自己：数据里万一成环，就把它当顶层 */
  const loops = (node: Conversation<T>): boolean => {
    const seen = new Set<string>([node.thread.id]);
    for (let parentId = node.thread.parentThreadId; parentId; parentId = nodes.get(parentId)?.thread.parentThreadId ?? null) {
      if (seen.has(parentId)) return true;
      if (!nodes.has(parentId)) return false;
      seen.add(parentId);
    }
    return false;
  };
  const roots: Conversation<T>[] = [];
  for (const node of nodes.values()) {
    const parent = node.thread.parentThreadId ? nodes.get(node.thread.parentThreadId) : undefined;
    if (parent && parent !== node && !loops(node)) parent.children.push(node);
    else roots.push(node);
  }
  const settle = (node: Conversation<T>): number => {
    for (const child of node.children) node.activityAt = Math.max(node.activityAt, settle(child));
    node.children.sort((a, b) => b.thread.createdAt - a.thread.createdAt);
    return node.activityAt;
  };
  roots.forEach(settle);
  return roots.sort((a, b) => b.activityAt - a.activityAt || b.thread.createdAt - a.thread.createdAt);
}

/** 一条对话下面一共挂着多少条（含下级的下级） */
export function countDescendants(node: Conversation): number {
  return node.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0);
}
