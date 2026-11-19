/**
 * [INPUT]: 无外部依赖
 * [OUTPUT]: 对外提供 reconcilePresence / finishEntering / finishExiting（列表条目的进入、驻留、退场状态机，区分“真正消失”与“跨区迁移”）、computeFlipDeltas（支持嵌套父子抵消的 FLIP 位移计算）、flipDuration（按位移距离缩放时长）、parseTranslateOffset（读取进行中动画的当前偏移，支持打断续接）
 * [POS]: lib 的动效纯逻辑层; 消费者: components/motion.tsx; 与 components/motion.tsx 的边界: 这里只算状态转移与位移数值，不碰 React 与 DOM
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */

export type MotionPhase = "entering" | "present" | "exiting";

export interface PresenceEntry<T> {
  key: string;
  item: T;
  phase: MotionPhase;
}

export interface ReconcileOptions {
  /** 是否给新出现的条目播“高度撑开”动画（首屏、切换视图、搜索时关闭） */
  animateEnter: boolean;
  /** 是否保留消失的条目播“高度收起退场”动画（切换视图、搜索时关闭） */
  animateExit: boolean;
  /** 返回 true 表示该条目只是搬去了侧边栏其他分区（置顶/取消置顶/换父级），应立刻卸载交由全局 FLIP 滑移，不留残影 */
  isRelocated?: (key: string) => boolean;
  /** 返回 true 表示该条目在整张侧边栏里都是全新的，值得撑开入场；若只是从别区搬来则返回 false */
  isNewGlobal?: (key: string) => boolean;
}

/**
 * 把上一帧渲染列表（可能含正在退场的条目）与最新数据合并：
 * - 新条目：按 animateEnter + isNewGlobal 标为 entering 或直接 present
 * - 仍在列表中的条目（含刚取消归档的退场中条目）：更新数据；原为 entering 的保持 entering 直到动画结束
 * - 从当前列表消失的条目：若已搬去别处（isRelocated）则立刻移除交由 FLIP；否则原位保留为 exiting，播完收起再卸载
 */
export function reconcilePresence<T>(
  prev: readonly PresenceEntry<T>[],
  next: readonly T[],
  getKey: (item: T) => string,
  options: ReconcileOptions,
): PresenceEntry<T>[] {
  const prevByKey = new Map(prev.map((entry) => [entry.key, entry]));
  const nextKeys = new Set<string>();

  const result: PresenceEntry<T>[] = next.map((item) => {
    const key = getKey(item);
    nextKeys.add(key);
    const existing = prevByKey.get(key);
    if (existing) {
      return { key, item, phase: existing.phase === "entering" ? "entering" : "present" };
    }
    const shouldEnter = options.animateEnter && (options.isNewGlobal ? options.isNewGlobal(key) : true);
    return { key, item, phase: shouldEnter ? "entering" : "present" };
  });

  if (!options.animateExit) return result;

  // 把需要退场的条目按原本的相对位置插回：紧跟在它前面最近一个仍存活（或刚插回）的兄弟后面
  let anchorIndex = -1;
  for (const entry of prev) {
    if (nextKeys.has(entry.key)) {
      const idx = result.findIndex((item) => item.key === entry.key);
      if (idx !== -1) anchorIndex = idx;
      continue;
    }
    if (entry.phase !== "exiting" && options.isRelocated?.(entry.key)) continue;
    const exiting: PresenceEntry<T> = entry.phase === "exiting" ? entry : { ...entry, phase: "exiting" };
    const insertAt = anchorIndex + 1;
    result.splice(insertAt, 0, exiting);
    anchorIndex = insertAt;
  }

  return result;
}

/** 入场动画结束：把指定键从 entering 转为 present；无变化时原样返回，避免多余重渲染 */
export function finishEntering<T>(entries: readonly PresenceEntry<T>[], keys: ReadonlySet<string>): PresenceEntry<T>[] {
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.phase === "entering" && keys.has(entry.key)) {
      changed = true;
      return { ...entry, phase: "present" as const };
    }
    return entry;
  });
  return changed ? next : (entries as PresenceEntry<T>[]);
}

/** 退场动画结束：移除指定键且仍处于 exiting 状态的条目；无变化时原样返回 */
export function finishExiting<T>(entries: readonly PresenceEntry<T>[], keys: ReadonlySet<string>): PresenceEntry<T>[] {
  let changed = false;
  const next = entries.filter((entry) => {
    if (entry.phase === "exiting" && keys.has(entry.key)) {
      changed = true;
      return false;
    }
    return true;
  });
  return changed ? next : (entries as PresenceEntry<T>[]);
}

export interface FlipRect {
  top: number;
  left: number;
}

export interface FlipDelta {
  dx: number;
  dy: number;
  distance: number;
}

/**
 * 计算每个元素的 FLIP 反向位移（从新位置指回旧位置）。
 * 当祖先容器（如项目分区）与子行同时位移时，扣除最近已记录祖先的原始位移，避免父子叠加双倍位移；
 * 跨分区迁移（置顶 / 取消置顶）时，新祖先与子行各自的位移会自动抵消到准确的视觉起点。
 */
export function computeFlipDeltas(
  prevRects: ReadonlyMap<string, FlipRect>,
  nextRects: ReadonlyMap<string, FlipRect>,
  parentOf: ReadonlyMap<string, string | null>,
  threshold = 0.5,
): Map<string, FlipDelta> {
  const raw = new Map<string, { dx: number; dy: number }>();
  for (const [id, next] of nextRects) {
    const prev = prevRects.get(id);
    if (!prev) continue;
    raw.set(id, { dx: prev.left - next.left, dy: prev.top - next.top });
  }

  const deltas = new Map<string, FlipDelta>();
  for (const [id, delta] of raw) {
    let ancDx = 0;
    let ancDy = 0;
    let cursor = parentOf.get(id) ?? null;
    const seen = new Set<string>([id]);
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      const ancRaw = raw.get(cursor);
      if (ancRaw) {
        ancDx = ancRaw.dx;
        ancDy = ancRaw.dy;
        break;
      }
      cursor = parentOf.get(cursor) ?? null;
    }
    const dx = delta.dx - ancDx;
    const dy = delta.dy - ancDy;
    const distance = Math.hypot(dx, dy);
    if (distance >= threshold) {
      deltas.set(id, { dx, dy, distance });
    }
  }
  return deltas;
}

/** 按位移距离微调动画时长（190ms–280ms）：同区微调利落，跨区置顶滑移从容 */
export function flipDuration(distance: number): number {
  return Math.round(Math.max(190, Math.min(280, 180 + Math.sqrt(Math.max(0, distance)) * 5)));
}

/** 从 getComputedStyle(el).transform 解析当前 translate(x, y) 像素偏移，便于打断中的动画无缝续接 */
export function parseTranslateOffset(transform: string | null | undefined): { x: number; y: number } {
  if (!transform || transform === "none") return { x: 0, y: 0 };
  const m2d = transform.match(/^matrix\(([^)]+)\)$/);
  if (m2d) {
    const parts = m2d[1]!.split(",").map((s) => Number(s.trim()));
    if (parts.length === 6 && Number.isFinite(parts[4]) && Number.isFinite(parts[5])) {
      return { x: parts[4]!, y: parts[5]! };
    }
  }
  const m3d = transform.match(/^matrix3d\(([^)]+)\)$/);
  if (m3d) {
    const parts = m3d[1]!.split(",").map((s) => Number(s.trim()));
    if (parts.length === 16 && Number.isFinite(parts[12]) && Number.isFinite(parts[13])) {
      return { x: parts[12]!, y: parts[13]! };
    }
  }
  return { x: 0, y: 0 };
}
