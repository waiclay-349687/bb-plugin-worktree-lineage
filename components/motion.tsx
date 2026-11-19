/**
 * [INPUT]: 依赖 react 的状态与布局副作用、lib/motion 的纯状态机与 FLIP 位移计算
 * [OUTPUT]: 对外提供 usePresenceList（保留退场条目与标记新入场条目）、MotionRow（带高度撑开 / 高度收起与 FLIP 锚点的列表项）、useFlipContainer（侧边栏级跨分区 FLIP 滑移，支持打断续接与嵌套父子抵消）、reducedMotion
 * [POS]: components 的动效基础层; 消费者: components/lineage-list.tsx、components/peek.tsx; 与 styles.css 的边界: 进入 / 退场的高度与透明度过渡写在 styles.css 的 [data-motion]，位移动画由这里用 Web Animations API 驱动
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  computeFlipDeltas,
  finishEntering,
  finishExiting,
  flipDuration,
  parseTranslateOffset,
  reconcilePresence,
  type FlipRect,
  type MotionPhase,
  type PresenceEntry,
} from "@/lib/motion";

export const ENTER_MS = 220;
export const EXIT_MS = 200;
const TIMER_BUFFER_MS = 50;
const FLIP_EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";

export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface PresenceListOptions {
  /** 是否启用入场撑开与退场收起（首屏加载完成且未处于搜索筛选时为 true） */
  enabled: boolean;
  /** 视图切换等结构整体变更的键；变化时跳过过渡，避免整页乱飞 */
  resetKey?: string;
  /** 消失条目若只是搬去侧边栏其他分区（置顶 / 取消置顶 / 换父级），立刻卸载交由 FLIP */
  isRelocated?: (key: string) => boolean;
  /** 新条目在整张侧边栏里是否全新；从别区迁入的返回 false，交由 FLIP 而不是从 0 撑开 */
  isNewGlobal?: (key: string) => boolean;
}

/**
 * 列表条目存在感管理：
 * - 在渲染阶段同步合并 prev 与 next，避免归档时先闪没一帧再冒出来的闪烁
 * - 为 entering / exiting 自动挂兜底定时器，防止标签页后台或动画未触发时残留
 */
export function usePresenceList<T>(
  items: readonly T[],
  getKey: (item: T) => string,
  options: PresenceListOptions,
): {
  entries: readonly PresenceEntry<T>[];
  markEntered: (key: string) => void;
  markExited: (key: string) => void;
} {
  const [state, setState] = useState<{
    items: readonly T[];
    resetKey: string | undefined;
    entries: PresenceEntry<T>[];
  }>(() => ({
    items,
    resetKey: options.resetKey,
    entries: reconcilePresence([], items, getKey, { animateEnter: false, animateExit: false }),
  }));

  if (items !== state.items || options.resetKey !== state.resetKey) {
    const resetChanged = options.resetKey !== state.resetKey;
    const animate = options.enabled && !resetChanged && !reducedMotion();
    const entries = reconcilePresence(state.entries, items, getKey, {
      animateEnter: animate,
      animateExit: animate,
      isRelocated: options.isRelocated,
      isNewGlobal: options.isNewGlobal,
    });
    setState({ items, resetKey: options.resetKey, entries });
  }

  const markEntered = useCallback((key: string) => {
    setState((prev) => {
      const next = finishEntering(prev.entries, new Set([key]));
      return next === prev.entries ? prev : { ...prev, entries: next };
    });
  }, []);

  const markExited = useCallback((key: string) => {
    setState((prev) => {
      const next = finishExiting(prev.entries, new Set([key]));
      return next === prev.entries ? prev : { ...prev, entries: next };
    });
  }, []);

  // 兜底定时器：CSS transitionend 在元素不可见、后台标签页或被系统减动效关闭时可能不触发
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = timersRef.current;
    const activeTokens = new Set<string>();
    for (const entry of state.entries) {
      if (entry.phase !== "entering" && entry.phase !== "exiting") continue;
      const token = `${entry.phase}:${entry.key}`;
      activeTokens.add(token);
      if (timers.has(token)) continue;
      const delay = (entry.phase === "entering" ? ENTER_MS : EXIT_MS) + TIMER_BUFFER_MS;
      const key = entry.key;
      const phase = entry.phase;
      timers.set(
        token,
        setTimeout(() => {
          timers.delete(token);
          if (phase === "entering") markEntered(key);
          else markExited(key);
        }, delay),
      );
    }
    for (const [token, handle] of timers) {
      if (!activeTokens.has(token)) {
        clearTimeout(handle);
        timers.delete(token);
      }
    }
  }, [state.entries, markEntered, markExited]);

  useEffect(
    () => () => {
      for (const handle of timersRef.current.values()) clearTimeout(handle);
      timersRef.current.clear();
    },
    [],
  );

  return { entries: state.entries, markEntered, markExited };
}

/**
 * 列表项容器：承担三件事：
 * 1. 新行入场：先挂在 0fr（enter-from），下一帧切到 entering 平滑撑开高度并推开下方行
 * 2. 归档退场：保持在位切到 exiting，内容淡出轻移同时高度收到 0fr，过渡完再卸载
 * 3. 常规驻留：挂 data-flip-id 参与侧边栏全局 FLIP（重排、置顶、取消置顶平滑滑移）
 */
export function MotionRow({
  phase,
  flipId,
  onEntered,
  onExited,
  onSettled,
  children,
}: {
  phase: MotionPhase;
  flipId?: string;
  onEntered?: () => void;
  onExited?: () => void;
  /** 高度过渡结束通知外层刷新 FLIP 基准坐标 */
  onSettled?: () => void;
  children: ReactNode;
}) {
  const [armed, setArmed] = useState(() => phase !== "entering" || reducedMotion());
  const rowRef = useRef<HTMLLIElement>(null);

  useLayoutEffect(() => {
    if (phase !== "entering" || armed) return;
    let raf2 = 0;
    // 双 rAF 确保浏览器先完成 0fr 首次绘制，下一帧切到 1fr 时 100% 触发高度过渡
    const raf1 = requestAnimationFrame(() => {
      void rowRef.current?.offsetHeight;
      raf2 = requestAnimationFrame(() => setArmed(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [phase, armed]);

  const motionAttr = phase === "entering" ? (armed ? "entering" : "enter-from") : phase === "exiting" ? "exiting" : undefined;

  return (
    <li
      ref={rowRef}
      data-flip-id={phase === "present" ? flipId : undefined}
      data-motion={motionAttr}
      inert={phase === "exiting" || undefined}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || event.propertyName !== "grid-template-rows") return;
        if (phase === "exiting") {
          onExited?.();
          onSettled?.();
        } else if (phase === "entering" && armed) {
          onEntered?.();
          onSettled?.();
        }
      }}
    >
      <div className="wl-item-clip">{children}</div>
    </li>
  );
}

/** 采集容器内全部参与 FLIP 的元素坐标（相对于容器顶边，滚动侧边栏不会导致误判） */
function measureElements(root: HTMLElement): {
  elements: Map<string, HTMLElement>;
  rects: Map<string, FlipRect>;
  parentOf: Map<string, string | null>;
} {
  const rootRect = root.getBoundingClientRect();
  const elements = new Map<string, HTMLElement>();
  const rects = new Map<string, FlipRect>();
  const parentOf = new Map<string, string | null>();
  const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-flip-id]"));
  for (const el of nodes) {
    const id = el.dataset.flipId;
    if (!id) continue;
    // 跳过正在隐藏折叠区内或刚进入/退场中的节点
    if (el.dataset.motion === "exiting" || el.dataset.motion === "enter-from") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    elements.set(id, el);
    rects.set(id, { top: rect.top - rootRect.top, left: rect.left - rootRect.left });
    const anc = el.parentElement?.closest("[data-flip-id]") as HTMLElement | null;
    parentOf.set(id, anc?.dataset.flipId ?? null);
  }
  return { elements, rects, parentOf };
}

/**
 * 侧边栏全局 FLIP 控制器：
 * - 同区重排（活跃跳顶、排序变化）：相邻行平滑让位与滑入
 * - 跨区迁移（置顶 / 取消置顶）：同一 threadId 从原项目区直接滑飞进置顶区（或反向），原位置下方行同步平滑合拢
 * - 打断续接：若某行滑到一半再次变动，读取其当前视觉偏移再起新动画，不闪烁不跳回
 */
export function useFlipContainer(
  rootRef: RefObject<HTMLElement | null>,
  options: {
    enabled: boolean;
    /** 视图或筛选模式切换时改变此键，跳过本帧 FLIP 只刷新坐标 */
    skipKey: string;
    /** 仅当条目顺序或归属变化时才执行 FLIP，避免每秒重渲染或悬停触发多余计算 */
    placementSig: string;
  },
): { syncPositions: () => void } {
  const prevRectsRef = useRef(new Map<string, FlipRect>());
  const prevSkipRef = useRef(options.skipKey);
  const prevSigRef = useRef(options.placementSig);
  const activeAnimsRef = useRef(new Map<HTMLElement, Animation>());

  const syncPositions = useCallback(() => {
    const root = rootRef.current;
    if (!root || activeAnimsRef.current.size > 0) return;
    prevRectsRef.current = measureElements(root).rects;
  }, [rootRef]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const skipChanged = prevSkipRef.current !== options.skipKey;
    const sigChanged = prevSigRef.current !== options.placementSig;
    prevSkipRef.current = options.skipKey;
    prevSigRef.current = options.placementSig;

    // 若不是顺序/归属变化，或未就绪/刚切视图/减动效：只刷新基准坐标，不播 FLIP
    if (!options.enabled || skipChanged || !sigChanged || reducedMotion()) {
      for (const [el, anim] of activeAnimsRef.current) {
        anim.cancel();
        delete el.dataset.flipping;
      }
      activeAnimsRef.current.clear();
      prevRectsRef.current = measureElements(root).rects;
      return;
    }

    // 取消正在播的 FLIP 前，先把它们的剩余偏移并入 prevRects，实现打断无缝续接
    const effectivePrev = new Map<string, FlipRect>(prevRectsRef.current);
    for (const [el, anim] of activeAnimsRef.current) {
      const id = el.dataset.flipId;
      if (id) {
        const base = effectivePrev.get(id);
        if (base) {
          const offset = parseTranslateOffset(getComputedStyle(el).transform);
          effectivePrev.set(id, { top: base.top + offset.y, left: base.left + offset.x });
        }
      }
      anim.cancel();
      delete el.dataset.flipping;
    }
    activeAnimsRef.current.clear();

    const { elements, rects, parentOf } = measureElements(root);
    if (effectivePrev.size > 0) {
      const deltas = computeFlipDeltas(effectivePrev, rects, parentOf);
      for (const [id, delta] of deltas) {
        const el = elements.get(id);
        if (!el || typeof el.animate !== "function") continue;
        // 长距离跨行滑移（如置顶 / 取消置顶）临时抬高层级，防止飞越其他行时被遮挡
        const lift = delta.distance > 36;
        if (lift) el.dataset.flipping = "true";
        const anim = el.animate(
          [
            { transform: `translate3d(${delta.dx}px, ${delta.dy}px, 0)` },
            { transform: "translate3d(0, 0, 0)" },
          ],
          { duration: flipDuration(delta.distance), easing: FLIP_EASING },
        );
        activeAnimsRef.current.set(el, anim);
        const cleanup = () => {
          if (activeAnimsRef.current.get(el) === anim) activeAnimsRef.current.delete(el);
          if (lift) delete el.dataset.flipping;
        };
        anim.onfinish = cleanup;
        anim.oncancel = cleanup;
      }
    }

    prevRectsRef.current = rects;
  }, [rootRef, options.enabled, options.skipKey, options.placementSig]);

  useEffect(
    () => () => {
      for (const [el, anim] of activeAnimsRef.current) {
        anim.cancel();
        delete el.dataset.flipping;
      }
      activeAnimsRef.current.clear();
    },
    [],
  );

  return { syncPositions };
}
