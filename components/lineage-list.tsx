/**
 * [INPUT]: 依赖 @get-bb/plugin-sdk/app 的侧边栏线程数据、provider 图标、线程快捷操作与菜单、状态组件、导航; 依赖 server.ts 的 lineage RPC; 依赖 lib/tree 建树、lib/conversations（对话视图）与 lib/view（分支树视图）两个展示模型; 依赖 components/motion 的存在感列表与全局 FLIP 滑移; 依赖 components/i18n 的 LanguageProvider / useT / useLang（全部界面文案按界面语言从词典取）; 依赖 lib/settle 的本机搁置存储约定（设置页“全部取消搁置”后经 SETTLED_CHANGED_EVENT 重读，列表加载完才清理过期记录）
 * [OUTPUT]: 对外提供 LineageList: experimental_threadList 槽位的列表组件
 * [POS]: 插件界面主体; 消费者: app.tsx; 与 lib 的边界: 谁挂在谁下面、怎么排序由 lib/conversations（对话视图：对话是主角，不出现分支）与 lib/view（分支树视图：分支是主行，对话是次级行）决定，这里只负责渲染与交互（折叠、视图切换、悬停快捷操作、轮询、入场/退场/重排/置顶动效）; 视觉全部在 styles.css，颜色只用宿主主题变量
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ThreadTitle,
  experimental_ProviderIcon as ProviderIcon,
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  experimental_ThreadActionsMenu as ThreadActionsMenu,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_copyToClipboard as copyToClipboard,
  experimental_useProviders as useProviders,
  experimental_useRpcQuery as useRpcQuery,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_useThreadActions as useThreadActions,
  useBbNavigate,
  useSdk,
  useSidebarThreadDraft,
  useSidebarThreadDraftIds,
  useSidebarThreadRowStatus,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Glyph } from "@/components/icons";
import { MotionRow, reducedMotion, useFlipContainer, usePresenceList } from "@/components/motion";
import { Peek, type PeekTarget } from "@/components/peek";
import { Icon } from "@/components/ui/icon";
import { serverContract, type ProjectLineage } from "@/lib/contract";
import { activityOf, buildConversations, countDescendants, type Conversation } from "@/lib/conversations";
import type { MotionPhase } from "@/lib/motion";
import { branchLabel, buildLineageTree, collectAncestry, walkThreads, type BranchView } from "@/lib/tree";
import { matchThreads } from "@/lib/search";
import { isThreadSettled, needsUserAttention, nextAttentionId, orderByVisual, parseSettledMap, SETTLED_CHANGED_EVENT, SETTLED_STORAGE_KEY, settledToPrune, splitSettledConversations } from "@/lib/settle";
import type { Messages } from "@/lib/i18n";
import { LanguageProvider, useLang, useT } from "@/components/i18n";
import { buildProjectView, pathLabels, relativeTime, rollupTone, rowColor, rowTone, toneOf, worktreeCleanupCommand, type RowColor, type ViewNode } from "@/lib/view";

type Thread = PluginSidebarThread;
/** family: 默认，一个 worktree 一张卡片、按谁派的缩进；lineage: 分支树 */
type ViewMode = "family" | "lineage";
type Provider = ReturnType<typeof useProviders>["providers"][number];

interface PluginThreadListProps {
  activeThreadId: string | null;
  activeProjectId: string | null;
  isCompactViewport: boolean;
  onNavigate: () => void;
}

const POLL_MS = 45_000;
const STORAGE_VIEW = "worktree-lineage.mode";
const STORAGE_COLLAPSED = "worktree-lineage.collapsed";
const STORAGE_SETTLED = SETTLED_STORAGE_KEY;
/** 输入停顿多久才去问 bb 的官方搜索（它搜消息内容，要走服务器） */
const SEARCH_DEBOUNCE_MS = 260;
const SEARCH_LIMIT = 8;
/** 鼠标停多久才出预览卡 */
const PEEK_DELAY_MS = 550;
/** 鼠标离开整个列表（或离开卡片）后多久收起：要够从行上横着移到卡片上（中间有一道缝） */
const PEEK_GRACE_MS = 300;
/** 鼠标离开一行、但还在列表里（经过分组标题或空隙）时多久收起：这段时间里落到另一条对话上，卡片直接滑过去 */
const PEEK_LINGER_MS = 900;
/** 卡片刚收起不久又停到一行上：不用再等，直接出（连着看几条时不必每次都等半秒） */
const PEEK_REOPEN_MS = 700;
/** 悬停时行尾的快捷按钮，和 bb 自带列表的默认设置一致；其余操作在“更多”与右键菜单里 */
const QUICK_ACTIONS = ["bb--core/regenerateTitle", "bb--core/archive"] as const;
/** bb 给这两个操作的名字只有英文：按插件的界面语言换成自己的叫法，别的操作原样显示 */
const quickActionLabel = (tx: Messages, key: string, fallback: string): string =>
  key === "bb--core/regenerateTitle" ? tx.regenerateTitle : key === "bb--core/archive" ? tx.archive : fallback;
const sourceLabel = (tx: Messages, source: "recorded" | "reflog" | "reflog-commit" | "unknown") =>
  ({ recorded: tx.sourceRecorded, reflog: tx.sourceReflog, "reflog-commit": tx.sourceReflogCommit, unknown: tx.sourceUnknown })[source];

const normalizePath = (p: string) => p.replace(/\/+$/, "");

/** 折叠状态：只记用户动过的节点，其余走默认 */
function usePersistentMap(key: string) {
  const [map, setMap] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const set = useCallback(
    (id: string, value: boolean) =>
      setMap((prev) => {
        const next = { ...prev, [id]: value };
        localStorage.setItem(key, JSON.stringify(next));
        return next;
      }),
    [key],
  );
  return [map, set] as const;
}

/** 本地软收起（Settle）记录：threadId → 收起时间戳；纯插件本地状态，绝不触碰 bb 归档与磁盘工作区 */
function useSettledMap(key: string) {
  const [map, setMap] = useState<Record<string, number>>(() => {
    try {
      return parseSettledMap(localStorage.getItem(key));
    } catch {
      return {};
    }
  });
  // 设置页“全部移回”或别的标签页改了记录：重读一遍
  useEffect(() => {
    const reload = () => {
      try {
        setMap(parseSettledMap(localStorage.getItem(key)));
      } catch {
        // 读不到就保持现状
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) reload();
    };
    window.addEventListener(SETTLED_CHANGED_EVENT, reload);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(SETTLED_CHANGED_EVENT, reload);
      window.removeEventListener("storage", onStorage);
    };
  }, [key]);
  const persist = useCallback(
    (updater: (prev: Record<string, number>) => Record<string, number>) =>
      setMap((prev) => {
        const next = updater(prev);
        if (next === prev) return prev;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // 隐私模式或存储满时忽略持久化失败
        }
        return next;
      }),
    [key],
  );
  const settle = useCallback((id: string) => persist((prev) => ({ ...prev, [id]: Date.now() })), [persist]);
  const unsettle = useCallback(
    (id: string) =>
      persist((prev) => {
        if (!(id in prev)) return prev;
        const { [id]: _, ...rest } = prev;
        return rest;
      }),
    [persist],
  );
  const prune = useCallback(
    (dropIds: readonly string[]) =>
      persist((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const id of dropIds) {
          if (id in next) {
            delete next[id];
            changed = true;
          }
        }
        return changed ? next : prev;
      }),
    [persist],
  );
  return { settled: map, settle, unsettle, prune };
}

interface ListContext {
  activeThreadId: string | null;
  onNavigate: () => void;
  compact: boolean;
  view: ViewMode;
  now: number;
  /** 首屏画完之后才为 true：之后的新行撑开、退场收起、重排与置顶滑移才生效，首屏不闪 */
  ready: boolean;
  /** 当前仍存在于侧边栏的全部对话 id（含置顶与各项目），用于区分“归档消失”和“跨区迁移” */
  activeIds: ReadonlySet<string>;
  isRelocated: (threadId: string) => boolean;
  isNewGlobal: (threadId: string) => boolean;
  /** 折叠 / 入场 / 退场高度过渡结束后刷新 FLIP 基准坐标 */
  syncPositions: () => void;
  /** 本地软收起状态与操作（不触发 bb 归档） */
  settled: Readonly<Record<string, number>>;
  draftIds: ReadonlySet<string>;
  settle: (threadId: string) => void;
  unsettle: (threadId: string) => void;
  threadsById: Map<string, Thread>;
  providersById: Map<string, Provider>;
  childCount: Map<string, number>;
  focusId: string | null;
  focusSet: Set<string> | null;
  setFocus: (id: string | null) => void;
  isOpen: (key: string, fallback?: boolean) => boolean;
  toggle: (key: string, fallback?: boolean) => void;
  /** 悬停预览卡：鼠标停在一行上一小会儿后显示；移开、滚动、按键时收起 */
  peekSchedule: (thread: Thread, row: HTMLElement) => void;
  peekCancel: () => void;
  /** 快速筛选结果里用方向键选中的那一行 */
  selectedId: string | null;
}
const Ctx = createContext<ListContext | null>(null);

/** 嵌套层数写成 CSS 变量：行的缩进、连线的横向位置都由它算出来（规则：下一级的图标对齐上一级文字的左缘） */
const depthStyle = (depth: number) => ({ "--wl-depth": depth }) as CSSProperties;
const useList = () => useContext(Ctx)!;

/** 来路上已经画出的对话：上级就在来路上时不再标注“派自” */

/** 槽位组件：先在根部解析界面语言，整棵列表（含 portal 出去的悬停卡片）都从 Provider 取文案 */
export function LineageList(props: PluginThreadListProps) {
  return (
    <LanguageProvider>
      <LineageListBody {...props} />
    </LanguageProvider>
  );
}

function LineageListBody(props: PluginThreadListProps) {
  const tx = useT();
  const lang = useLang();
  const { threads: allThreads, projects, status: threadsStatus } = useSidebarThreads();
  const { providers } = useProviders();
  const navigate = useBbNavigate();
  const [view, setView] = useState<ViewMode>(() => (localStorage.getItem(STORAGE_VIEW) === "lineage" ? "lineage" : "family"));
  const [collapsed, setCollapsed] = usePersistentMap(STORAGE_COLLAPSED);
  const { settled, settle: rawSettle, unsettle, prune } = useSettledMap(STORAGE_SETTLED);
  const [focusId, setFocus] = useState<string | null>(null);

  const query = useRpcQuery({ contract: serverContract, method: "lineage", input: { refresh: false } });
  // 只在页面可见时轮询；切回可见或窗口重新聚焦时立刻补一次
  const refetchRef = useRef(query.refetch);
  refetchRef.current = query.refetch;
  useEffect(() => {
    const refetch = () => void refetchRef.current();
    const timer = setInterval(() => !document.hidden && refetch(), POLL_MS);
    const onVisibility = () => !document.hidden && refetch();
    window.addEventListener("focus", refetch);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refetch);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const threads = useMemo(() => allThreads.filter((t) => !t.isHidden && !t.isArchived), [allThreads]);
  const threadsById = useMemo(() => new Map(threads.map((t) => [t.id, t])), [threads]);
  const providersById = useMemo(() => new Map(providers.map((p) => [p.id, p])), [providers]);
  const childCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of threads) if (t.parentThreadId) counts.set(t.parentThreadId, (counts.get(t.parentThreadId) ?? 0) + 1);
    return counts;
  }, [threads]);
  const focusSet = useMemo(() => {
    if (!focusId) return null;
    const parentOf = new Map(threads.map((t) => [t.id, t.parentThreadId ?? null]));
    const set = new Set<string>([focusId]);
    for (const t of threads) if (collectAncestry(t.id, parentOf).has(focusId)) set.add(t.id);
    return set;
  }, [focusId, threads]);
  const lineageByProject = useMemo(() => new Map((query.data?.projects ?? []).map((p) => [p.projectId, p])), [query.data]);
  const pinned = useMemo(
    () => threads.filter((t) => t.isPinned).sort((a, b) => (a.pinSortKey ?? "").localeCompare(b.pinSortKey ?? "")),
    [threads],
  );

  // ── 快速筛选 ──
  const [searching, setSearching] = useState(false);
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const results = useMemo(() => matchThreads(threads, projectNames, text), [threads, projectNames, text]);
  const filtering = searching && text.trim() !== "";
  // bb 官方搜索：搜消息内容，也搜已归档的对话。输入停顿后再问，避免每个字都请求一次
  const sdk = useSdk();
  const [remote, setRemote] = useState<{ query: string; active: SearchHit[]; archived: SearchHit[] } | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);
  useEffect(() => {
    const queryText = text.trim();
    if (!searching || queryText.length < 2) {
      setRemote(null);
      setRemoteBusy(false);
      return;
    }
    setRemoteBusy(true);
    const abort = new AbortController();
    const timer = setTimeout(() => {
      sdk.threads
        .search({ query: queryText, limitPerGroup: String(SEARCH_LIMIT), signal: abort.signal })
        .then((found) => {
          if (abort.signal.aborted) return;
          setRemote({ query: queryText, active: found.active.results.map(toHit), archived: found.archived.results.map(toHit) });
          setRemoteBusy(false);
        })
        .catch(() => {
          if (!abort.signal.aborted) setRemoteBusy(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [searching, text, sdk]);
  // 三组候选：标题 / 分支命中的（本地，即时）→ 消息里提到的 → 已归档的；同一条对话只出现在最靠前的那组
  const localIds = useMemo(() => new Set(results.map((t) => t.id)), [results]);
  const mentioned = useMemo(() => (remote?.active ?? []).filter((hit) => !localIds.has(hit.id)), [remote, localIds]);
  const archivedHits = remote?.archived ?? [];
  const candidateIds = useMemo(
    () => [...results.map((t) => t.id), ...mentioned.map((h) => h.id), ...archivedHits.map((h) => h.id)],
    [results, mentioned, archivedHits],
  );
  const selectedId = filtering ? candidateIds[Math.min(cursor, candidateIds.length - 1)] ?? null : null;
  const closeSearch = () => {
    setSearching(false);
    setText("");
    setCursor(0);
  };
  // 在侧边栏之外的任何地方按 “/” 都能开始筛选；正在输入框或编辑器里打字时不抢
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (!rootRef.current || rootRef.current.offsetParent === null) return;
      event.preventDefault();
      setSearching(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (searching) inputRef.current?.focus();
  }, [searching]);

  // ── 悬停预览卡 ──
  const [peek, setPeek] = useState<{ threadId: string; top: number; left: number } | null>(null);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const peekOpen = useRef(false);
  peekOpen.current = peek !== null;
  /** 立刻收起（滚动、按键、点击时） */
  /** 鼠标是否在卡片上（卡片被收起时不会收到“离开”事件，所以收起的地方要顺手清掉） */
  const peekOver = useRef(false);
  const peekClose = useCallback(() => {
    clearTimeout(peekTimer.current);
    peekOver.current = false;
    setPeek(null);
  }, []);
  const peekClosedAt = useRef(0);
  /**
   * 鼠标离开一行：先等一会儿再收。还在列表里（正经过分组标题、行与行之间的空隙）就多等一些，
   * 让卡片留在原地，等鼠标落到下一条对话上再滑过去；离开了整个列表则很快收起。
   */
  const peekCancel = useCallback((delay: number = PEEK_LINGER_MS) => {
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => {
      if (peekOpen.current) peekClosedAt.current = Date.now();
      peekOver.current = false;
      setPeek(null);
    }, delay);
  }, []);
  const peekLeaveList = useCallback(() => peekCancel(PEEK_GRACE_MS), [peekCancel]);
  /** 鼠标在卡片上：卡片留着（可以选字、复制），离开卡片再按“离开列表”处理 */
  const peekHover = useMemo(
    () => ({
      onEnter: () => {
        peekOver.current = true;
        clearTimeout(peekTimer.current);
      },
      onLeave: () => {
        peekOver.current = false;
        peekCancel(PEEK_GRACE_MS);
      },
    }),
    [peekCancel],
  );
  const peekSchedule = useCallback((thread: Thread, row: HTMLElement) => {
    clearTimeout(peekTimer.current);
    const show = () => {
      const rect = row.getBoundingClientRect();
      const side = rootRef.current?.getBoundingClientRect();
      setPeek({ threadId: thread.id, top: rect.top, left: (side?.right ?? rect.right) + 14 });
    };
    // 卡片已经开着（或刚收起）：不关再开，直接移到这一行
    if (peekOpen.current || Date.now() - peekClosedAt.current < PEEK_REOPEN_MS) show();
    else peekTimer.current = setTimeout(show, PEEK_DELAY_MS);
  }, []);
  useEffect(() => {
    // 只有“列表自己被滚动”才收起（行从鼠标下面移走了）。别处的滚动不算：
    // 正在输出的对话会不停滚动聊天区，那不该把这边的卡片关掉
    const onScroll = (event: Event) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && (event.target.contains(root) || root.contains(event.target))) peekClose();
    };
    // 鼠标在卡片上时，按键（复制的快捷键）和在卡片里的点击、拖选都不收起卡片；Esc 照常收起
    const onKey = (event: KeyboardEvent) => {
      if (!peekOver.current || event.key === "Escape") peekClose();
    };
    const onDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element && event.target.closest(".wl-peek"))) peekClose();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      clearTimeout(peekTimer.current);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [peekClose]);
  /**
   * 预览卡里的分支信息和列表用同一个来源：git 里这个 worktree 现在检出的分支。
   * bb 环境记录的分支名可能已经过时（agent 在 worktree 里切过分支），只在读不到 git 时才用它兜底。
   */
  const worktreeBranch = useMemo(() => {
    const map = new Map<string, { branch: string | null; parent: string | null }>();
    for (const project of query.data?.projects ?? []) {
      if (project.result.status !== "ok") continue;
      const parents = new Map(project.result.scan.branches.map((b) => [b.name, b.parent]));
      for (const worktree of project.result.scan.worktrees) {
        map.set(normalizePath(worktree.path), { branch: worktree.branch, parent: worktree.branch ? parents.get(worktree.branch) ?? null : null });
      }
    }
    return map;
  }, [query.data]);
  const draftIds = useSidebarThreadDraftIds();
  const peekThread = peek ? threadsById.get(peek.threadId) : undefined;
  const peekTarget: PeekTarget | null =
    peek && peekThread
      ? {
          thread: peekThread,
          hasDraft: draftIds.has(peekThread.id),
          top: peek.top,
          left: peek.left,
          projectName: peekThread.projectId ? projectNames.get(peekThread.projectId) ?? null : null,
          provider: peekThread.providerId ? providersById.get(peekThread.providerId) : undefined,
          ...(() => {
            const info = peekThread.environment?.path ? worktreeBranch.get(normalizePath(peekThread.environment.path)) : undefined;
            return { branch: info ? info.branch : peekThread.environment?.branchName ?? null, parentBranch: info?.parent ?? null, detached: info ? info.branch === null : false };
          })(),
          dispatchedBy: peekThread.parentThreadId ? threadsById.get(peekThread.parentThreadId)?.displayTitle ?? null : null,
          children: threads.filter((t) => t.parentThreadId === peekThread.id).map((t) => toneOf(t.indicator)),
          time: relativeTime(activityOf(peekThread, toneOf(peekThread.indicator) === "running"), Date.now(), lang),
        }
      : null;

  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 900);
    return () => clearTimeout(timer);
  }, []);

  const settle = useCallback(
    (id: string) => {
      rawSettle(id);
      peekClose();
    },
    [rawSettle, peekClose],
  );

  // 自动清理已归档/删除、或因新活动而唤醒的软收起记录，防止 localStorage 堆积或日后意外回落；列表加载完才清
  useEffect(() => {
    const drop = settledToPrune(settled, (id) => threadsById.get(id), draftIds, threadsStatus === "ready");
    if (drop.length > 0) prune(drop);
  }, [settled, threadsById, threadsStatus, draftIds, prune]);

  // 按侧边栏视觉顺序收集“需要你”的对话（黄草稿 / 蓝等你或出错 / 绿完成未读），供 ] / [ 快捷键与顶栏徽标跳转
  const { attentionIds, topAttentionColor } = useMemo(() => {
    const ordered: string[] = [];
    const rank: RowColor[] = ["waiting", "draft", "done"];
    let best = rank.length;
    const collect = (thread: Thread) => {
      const hasDraft = draftIds.has(thread.id);
      if (!needsUserAttention(thread.indicator, hasDraft)) return;
      if (isThreadSettled(thread, settled[thread.id], hasDraft)) return;
      ordered.push(thread.id);
      const color = rowColor(rowTone(thread.indicator, hasDraft));
      if (color) best = Math.min(best, rank.indexOf(color));
    };
    for (const t of pinned) collect(t);
    for (const project of projects) {
      const projectThreads = threads
        .filter((t) => t.projectId === project.id && !t.isPinned)
        .sort((a, b) => activityOf(b, toneOf(b.indicator) === "running") - activityOf(a, toneOf(a.indicator) === "running"));
      for (const t of projectThreads) collect(t);
    }
    return { attentionIds: ordered, topAttentionColor: rank[best] ?? null };
  }, [pinned, projects, threads, draftIds, settled]);

  const jumpAttention = useCallback(
    (direction: 1 | -1) => {
      // 两种视图的嵌套、分组与排序都不同：以屏幕上实际渲染出的行序为准，收起分组里的接在后面
      const rendered = Array.from(rootRef.current?.querySelectorAll("[data-sidebar-thread-id]") ?? [], (el) => el.getAttribute("data-sidebar-thread-id"));
      const target = nextAttentionId(orderByVisual(attentionIds, rendered), props.activeThreadId, direction);
      if (!target) return;
      navigate.toThread(target);
      props.onNavigate();
      requestAnimationFrame(() => {
        rootRef.current?.querySelector(`[data-sidebar-thread-id="${CSS.escape(target)}"]`)?.closest(".wl-cell")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    },
    [attentionIds, props.activeThreadId, navigate, props.onNavigate],
  );

  // 快捷键在需要你的对话间前后循环跳转：
  // - 裸键 ] / [：焦点不在输入框或编辑器里时才生效，打字时不抢
  // - Alt/Option + ] / [：任何地方都生效。bb 打开对话后焦点会落进输入框，只靠裸键跳一次之后就按不动了；
  //   按物理键位（event.code）判断，因为 macOS 上 Option 会把 ] 变成别的字符。bb 自己用的是 Cmd / Ctrl+Shift + 方括号，不冲突
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.defaultPrevented || event.isComposing) return;
      const bare = !event.altKey && (event.key === "]" || event.key === "[");
      const withAlt = event.altKey && !event.shiftKey && (event.code === "BracketRight" || event.code === "BracketLeft");
      if (!bare && !withAlt) return;
      const target = event.target as HTMLElement | null;
      if (bare && target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (!rootRef.current || rootRef.current.offsetParent === null) return;
      if (attentionIds.length === 0) return;
      event.preventDefault();
      jumpAttention(event.key === "]" || event.code === "BracketRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [attentionIds.length, jumpAttention]);

  // 区分“全新对话”和“从别区搬来的对话（置顶/取消置顶）”：knownIdsRef 在 commit 后更新，渲染期始终保存上一帧的全集
  const activeIds = useMemo(() => new Set(threads.map((t) => t.id)), [threads]);
  const knownIdsRef = useRef<Set<string> | null>(null);
  useLayoutEffect(() => {
    knownIdsRef.current = activeIds;
  }, [activeIds]);
  const isRelocated = useCallback((id: string) => activeIds.has(id), [activeIds]);
  const isNewGlobal = useCallback((id: string) => knownIdsRef.current !== null && !knownIdsRef.current.has(id), []);

  // 顺序 / 归属签名：仅当置顶、软收起、项目归属、父子关系、分支路径或排序时间戳变动时才运行 FLIP
  const placementSig = useMemo(() => {
    if (filtering) return "filter";
    const pinPart = pinned.map((t) => t.id).join(",");
    const settledPart = Object.keys(settled).sort().join(",");
    const orderPart = threads
      .map((t) => {
        const running = toneOf(t.indicator) === "running";
        return `${t.projectId ?? ""}:${t.isPinned ? 1 : 0}:${t.pinSortKey ?? ""}:${t.parentThreadId ?? ""}:${t.environment?.path ?? ""}:${activityOf(t, running)}:${t.id}`;
      })
      .join("|");
    return `${view}#${pinPart}#${settledPart}#${orderPart}#${query.data?.generatedAt ?? 0}`;
  }, [filtering, view, pinned, settled, threads, query.data?.generatedAt]);

  const { syncPositions } = useFlipContainer(rootRef, {
    enabled: ready && !filtering,
    skipKey: `${view}:${filtering ? 1 : 0}`,
    placementSig,
  });

  const ctx: ListContext = {
    activeThreadId: props.activeThreadId,
    onNavigate: props.onNavigate,
    compact: props.isCompactViewport,
    view,
    now: Date.now(),
    ready,
    activeIds,
    isRelocated,
    isNewGlobal,
    syncPositions,
    settled,
    draftIds,
    settle,
    unsettle,
    threadsById,
    providersById,
    childCount,
    focusId,
    focusSet,
    setFocus,
    isOpen: (key, fallback = true) => !(collapsed[key] ?? !fallback),
    toggle: (key, fallback = true) => setCollapsed(key, !(collapsed[key] ?? !fallback)),
    peekSchedule,
    peekCancel,
    selectedId,
  };

  const switchView = (next: ViewMode) => {
    setView(next);
    localStorage.setItem(STORAGE_VIEW, next);
  };

  return (
    <Ctx.Provider value={ctx}>
      <div
        ref={rootRef}
        className="wl-root"
        data-view={view}
        data-compact={props.isCompactViewport}
        data-focus={focusSet !== null}
        onPointerLeave={peekLeaveList}
      >
        <div className="wl-bar">
          {searching ? (
            <label className="wl-search wl-enter">
              <Glyph name="search" size={12} />
              <input
                ref={inputRef}
                value={text}
                placeholder={tx.filterPlaceholder}
                aria-label={tx.filterPlaceholder}
                spellCheck={false}
                onChange={(event) => {
                  setText(event.target.value);
                  setCursor(0);
                }}
                onBlur={() => {
                  if (text.trim() === "") closeSearch();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeSearch();
                  } else if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setCursor((n) => Math.min(n + 1, Math.max(candidateIds.length - 1, 0)));
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setCursor((n) => Math.max(n - 1, 0));
                  } else if (event.key === "Enter" && selectedId) {
                    event.preventDefault();
                    navigate.toThread(selectedId);
                    props.onNavigate();
                    closeSearch();
                  }
                }}
              />
              <button type="button" className="wl-kbd" title={tx.clearFilter} onMouseDown={(event) => event.preventDefault()} onClick={closeSearch}>
                esc
              </button>
            </label>
          ) : (
            <>
              <div className="wl-seg" role="group" aria-label={tx.viewGroup} data-view={view}>
                {/* 只有当前视图显示文字，另一个只留图标（名字在 aria-label / title 里）：英文叫法长，两个都写出来顶栏放不下 */}
                <button type="button" aria-pressed={view === "family"} aria-label={tx.viewConversations} title={`${tx.viewConversations}: ${tx.viewConversationsHint}`} onClick={() => switchView("family")}>
                  <Glyph name="dispatch" size={12} />
                  <span className="wl-seg-label">{tx.viewConversations}</span>
                </button>
                <button type="button" aria-pressed={view === "lineage"} aria-label={tx.viewTree} title={`${tx.viewTree}: ${tx.viewTreeHint}`} onClick={() => switchView("lineage")}>
                  <Glyph name="branch" size={12} />
                  <span className="wl-seg-label">{tx.viewTree}</span>
                </button>
              </div>
              <span className="wl-grow" />
              {focusId ? (
                <button type="button" className="wl-clear" onClick={() => setFocus(null)}>
                  {tx.clearHighlight}
                </button>
              ) : null}
              {attentionIds.length > 0 && topAttentionColor ? (
                <button
                  type="button"
                  className="wl-attn"
                  data-yours={topAttentionColor}
                  aria-label={tx.attentionLabel(attentionIds.length)}
                  title={tx.attentionTitle(attentionIds.length)}
                  onClick={() => jumpAttention(1)}
                >
                  <span className="wl-attn-dot" />
                  {attentionIds.length}
                </button>
              ) : null}
              <button type="button" className="wl-btn" aria-label={tx.filter} title={tx.filterTitle} onClick={() => setSearching(true)}>
                <Glyph name="search" />
              </button>
              <button
                type="button"
                className="wl-btn"
                aria-label={tx.rescan}
                title={query.isFetching ? tx.rescanning : tx.rescan}
                onClick={() => void query.refetch()}
              >
                <Glyph name="refresh" className={query.isFetching ? "wl-spin" : undefined} />
              </button>
            </>
          )}
        </div>

        {filtering ? (
          <>
            <ResultGroup title={tx.groupTitleOrBranch} count={results.length}>
              {results.map((thread) => (
                <ThreadCell
                  key={thread.id}
                  thread={thread}
                  sub={
                    <span className="wl-path">
                      <span className="wl-path-leaf">{thread.projectId ? projectNames.get(thread.projectId) : null}</span>
                      {thread.environment?.branchName ? <span className="wl-path-via">{branchLabel(thread.environment.branchName).leaf}</span> : null}
                    </span>
                  }
                />
              ))}
            </ResultGroup>
            <ResultGroup title={tx.groupMentioned} count={mentioned.length}>
              {mentioned.map((hit) => {
                const live = threadsById.get(hit.id);
                return live ? (
                  <ThreadCell key={hit.id} thread={live} sub={<Snippet hit={hit} />} />
                ) : (
                  <HitCell key={hit.id} hit={hit} />
                );
              })}
            </ResultGroup>
            <ResultGroup title={tx.groupArchived} count={archivedHits.length}>
              {archivedHits.map((hit) => (
                <HitCell key={hit.id} hit={hit} quiet />
              ))}
            </ResultGroup>
            {candidateIds.length === 0 ? (
              <div className="wl-empty">{remoteBusy || (remote === null && text.trim().length >= 2) ? tx.searchingMessages : tx.noMatches}</div>
            ) : remoteBusy ? (
              <div className="wl-empty">{tx.searchingMessages}</div>
            ) : null}
          </>
        ) : null}

        {!filtering ? <PinnedSection pinned={pinned} /> : null}

        {(filtering ? [] : projects).map((project) => {
          const projectThreads = threads.filter((t) => t.projectId === project.id && !t.isPinned);
          const lineage = lineageByProject.get(project.id);
          if (projectThreads.length === 0 && !lineage) return null;
          return (
            <ProjectSection
              key={project.id}
              projectId={project.id}
              isPersonal={project.isPersonal}
              name={project.name}
              threads={projectThreads}
              lineage={lineage}
              loading={query.isLoading}
            />
          );
        })}
        {!props.isCompactViewport ? <Peek target={peekTarget} hover={peekHover} /> : null}
      </div>
    </Ctx.Provider>
  );
}

/** bb 官方搜索的一条命中：一条对话 + 命中的那段文字 */
interface SearchHit {
  id: string;
  /** 没有标题时为 null，渲染时按语言显示“无标题” */
  title: string | null;
  providerId: string | null;
  projectId: string | null;
  updatedAt: number;
  /** 命中处前后的文字，分成三段：前 / 命中的词 / 后 */
  before: string;
  match: string;
  after: string;
}

function toHit(result: {
  thread: { id: string; title: string | null; titleFallback: string | null; providerId: string | null; projectId: string | null; updatedAt: number };
  matches: { text: string; highlightRanges: { start: number; end: number }[] }[];
}): SearchHit {
  const { thread } = result;
  const first = result.matches[0];
  const range = first?.highlightRanges[0];
  // 命中的文字是 markdown 原文：去掉强调、代码、标题这些符号，压成一行
  const flat = (value: string) => value.replace(/[*`#>]+/g, "").replace(/\s+/g, " ");
  // 命中的词前面只留一小段上下文，保证它落在第一行里
  const before = first && range ? flat(first.text.slice(Math.max(0, range.start - 14), range.start)) : "";
  return {
    id: thread.id,
    title: thread.title ?? thread.titleFallback ?? null,
    providerId: thread.providerId,
    projectId: thread.projectId,
    updatedAt: thread.updatedAt,
    before: first && range && range.start > 14 ? `…${before}` : before,
    match: first && range ? flat(first.text.slice(range.start, range.end)) : "",
    after: first && range ? flat(first.text.slice(range.end, range.end + 60)) : first ? flat(first.text.slice(0, 70)) : "",
  };
}

/** 命中处的那段文字，命中的词加重 */
function Snippet({ hit }: { hit: SearchHit }) {
  return (
    <span className="wl-snippet">
      {hit.before}
      {hit.match ? <mark>{hit.match}</mark> : null}
      {hit.after}
    </span>
  );
}

/** 一组候选；没有命中时整组不出现 */
function ResultGroup({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <section>
      <div className="wl-section-head">
        <span className="wl-section-name" style={{ paddingLeft: 4 }}>
          {title}
        </span>
        <span className="wl-count" style={{ marginLeft: 6 }}>
          {count}
        </span>
      </div>
      <ul className="wl-flow">{children}</ul>
    </section>
  );
}

/** 不在侧边栏当前列表里的命中（主要是已归档的对话）：没有实时状态，只有标题、命中文字和时间 */
function HitCell({ hit, quiet = false }: { hit: SearchHit; quiet?: boolean }) {
  const tx = useT();
  const lang = useLang();
  const title = hit.title ?? tx.untitled;
  const list = useList();
  const navigate = useBbNavigate();
  const provider = hit.providerId ? list.providersById.get(hit.providerId) : undefined;
  return (
    <li>
      <div className="wl-cell" data-lines={2} data-quiet={quiet} data-selected={list.selectedId === hit.id || undefined}>
        <a
          className="wl-cell-link"
          href="#"
          draggable={false}
          aria-label={title}
          onClick={(event) => {
            event.preventDefault();
            navigate.toThread(hit.id);
            list.onNavigate();
          }}
        />
        <div className="wl-line1">
          <span className="wl-logo" title={provider?.displayName}>
            {provider ? <ProviderIcon providerKind="agent" provider={provider} className="size-3.5" aria-label={provider.displayName} /> : null}
          </span>
          <span className="wl-title">{title}</span>
        </div>
        <div className="wl-line2">
          <Snippet hit={hit} />
          <span className="wl-grow" />
          <span className="wl-time">{relativeTime(hit.updatedAt, list.now, lang)}</span>
        </div>
      </div>
    </li>
  );
}

/** 置顶分区：第一条置顶出现时头部柔和淡入、最后一条归档时整区随行平滑收起 */
function PinnedSection({ pinned }: { pinned: Thread[] }) {
  const tx = useT();
  const list = useList();
  const presence = usePresenceList(pinned, (t) => t.id, {
    enabled: list.ready,
    isRelocated: list.isRelocated,
    isNewGlobal: list.isNewGlobal,
  });
  if (presence.entries.length === 0) return null;
  const exitingAll = pinned.length === 0;
  return (
    <Section
      sectionKey="section:pinned"
      flipId={exitingAll ? undefined : "section:pinned"}
      title={tx.pinned}
      count={pinned.length || undefined}
      exiting={exitingAll}
      animateHeader={list.ready}
    >
      <ul className="wl-tree">
        {presence.entries.map((entry) => (
          <ThreadCell
            key={entry.key}
            thread={entry.item}
            phase={entry.phase}
            onEntered={() => presence.markEntered(entry.key)}
            onExited={() => presence.markExited(entry.key)}
          />
        ))}
      </ul>
    </Section>
  );
}

function Section({
  sectionKey,
  flipId,
  title,
  count,
  note,
  action,
  exiting = false,
  animateHeader = false,
  children,
}: {
  sectionKey: string;
  flipId?: string;
  title: string;
  count?: number;
  note?: string | null;
  action?: ReactNode;
  exiting?: boolean;
  animateHeader?: boolean;
  children: ReactNode;
}) {
  const list = useList();
  const open = list.isOpen(sectionKey);
  return (
    <div className="wl-section-wrap" data-flip-id={flipId} data-section-exiting={exiting || undefined}>
      <section className="wl-section-clip" data-section-enter={animateHeader || undefined}>
        <div className="wl-section-head">
          <button type="button" className="wl-section-toggle" data-open={open} aria-expanded={open} onClick={() => list.toggle(sectionKey)}>
            <span className="wl-section-name">{title}</span>
            {count ? <span className="wl-count">{count}</span> : null}
            {note ? <span className="wl-count">· {note}</span> : null}
            <Glyph name="chevron" size={10} className="wl-chev" />
          </button>
          {action}
        </div>
        <Collapse open={open}>{children}</Collapse>
      </section>
    </div>
  );
}

/** 项目级动作：在某个 worktree 里开新对话 */
interface ProjectActions {
  projectId: string;
  defaultBranch: string | null;
  /** 仓库主检出的路径（清理命令的 git -C 用） */
  repoPath: string | null;
  canStartIn: (node: BranchView<Thread>) => boolean;
  startIn: (node: BranchView<Thread>) => void;
}

const EMPTY_CONVERSATIONS: Conversation<Thread>[] = [];
const EMPTY_NODES: ViewNode<Thread>[] = [];
const EMPTY_LOOSE: { thread: Thread }[] = [];

function hasThreadInConversation(item: Conversation<Thread>, id: string | null): boolean {
  if (!id) return false;
  if (item.thread.id === id) return true;
  return item.children.some((child) => hasThreadInConversation(child, id));
}

function ProjectSection({
  projectId,
  isPersonal,
  name,
  threads,
  lineage,
  loading,
}: {
  projectId: string;
  isPersonal: boolean;
  name: string;
  threads: Thread[];
  lineage: ProjectLineage | undefined;
  loading: boolean;
}) {
  const tx = useT();
  const list = useList();
  const navigate = useBbNavigate();
  const scan = lineage?.result.status === "ok" ? lineage.result.scan : null;
  const tree = useMemo(() => (scan ? buildLineageTree(threads, scan, lineage?.environments ?? []) : null), [scan, threads, lineage]);
  const projectView = useMemo(() => (list.view === "lineage" && tree ? buildProjectView(tree) : null), [list.view, tree]);
  // 对话视图只看对话；没有 git 的项目（或还没读到 git）在分支树视图里也照常列出对话，不画树
  const conversations = useMemo(
    () => (projectView ? null : buildConversations(threads, (t) => toneOf(t.indicator) === "running")),
    [projectView, threads],
  );
  const split = useMemo(
    () => (conversations ? splitSettledConversations(conversations, list.settled, list.draftIds) : null),
    [conversations, list.settled, list.draftIds],
  );
  const settledRootIds = useMemo(() => new Set((split?.settled ?? EMPTY_CONVERSATIONS).map((c) => c.thread.id)), [split]);
  const settledHoldsActive = useMemo(
    () => (split?.settled ?? EMPTY_CONVERSATIONS).some((c) => hasThreadInConversation(c, list.activeThreadId)),
    [split, list.activeThreadId],
  );
  const settledOpen = list.isOpen(`settled:${projectId}`, settledHoldsActive);
  // 软收进 Settled 折叠架时：架子合着就播平滑收起退场，架子开着就走 FLIP 滑进去
  const isActiveConvRelocated = useCallback(
    (id: string) => list.isRelocated(id) && (!settledRootIds.has(id) || settledOpen),
    [list, settledRootIds, settledOpen],
  );
  const convPresence = usePresenceList(split?.active ?? EMPTY_CONVERSATIONS, (item) => item.thread.id, {
    enabled: list.ready && split !== null,
    resetKey: `${list.view}:${projectView ? "tree" : "conv"}`,
    isRelocated: isActiveConvRelocated,
    isNewGlobal: list.isNewGlobal,
  });
  const rootsPresence = usePresenceList(projectView?.roots ?? EMPTY_NODES, (node) => node.key, {
    enabled: list.ready && projectView !== null,
    resetKey: `${list.view}:${projectView ? "tree" : "conv"}`,
  });
  const loosePresence = usePresenceList(projectView?.loose ?? EMPTY_LOOSE, (leaf) => leaf.thread.id, {
    enabled: list.ready && projectView !== null,
    resetKey: `${list.view}:${projectView ? "tree" : "conv"}`,
    isRelocated: list.isRelocated,
    isNewGlobal: list.isNewGlobal,
  });

  const actions = useMemo<ProjectActions>(() => {
    const envIdByPath = new Map((lineage?.environments ?? []).map((e) => [normalizePath(e.path), e.id]));
    const envIdOf = (node: BranchView<Thread>) => (node.worktreePath ? envIdByPath.get(normalizePath(node.worktreePath)) : undefined);
    return {
      projectId,
      defaultBranch: scan?.defaultBranch ?? null,
      repoPath: lineage?.sourcePath ?? null,
      canStartIn: (node) => envIdOf(node) !== undefined,
      startIn: (node) => {
        const environmentId = envIdOf(node);
        if (environmentId) {
          navigate.toCompose({ projectId, environmentId, focusPrompt: true });
        } else {
          // bb 还不认识这个 worktree：打开新建对话，并把路径放进剪贴板，供 Existing worktree 搜索
          if (node.worktreePath) void copyToClipboard({ text: node.worktreePath });
          navigate.toCompose({ projectId, hostId: lineage?.hostId, focusPrompt: true });
        }
        list.onNavigate();
      },
    };
  }, [lineage, scan, navigate, projectId, list.onNavigate]);

  const note = !scan && !isPersonal ? (loading ? tx.readingGit : lineage && lineage.result.status !== "not-git" ? tx.gitFailed : null) : null;

  return (
    <Section
      sectionKey={`project:${projectId}`}
      flipId={`section:project:${projectId}`}
      title={name}
      count={split ? split.active.reduce((sum, item) => sum + 1 + countDescendants(item), 0) : threads.length}
      note={note}
      action={
        <button
          type="button"
          className="wl-btn wl-reveal"
          aria-label={tx.newThreadIn(name)}
          title={tx.newThread}
          onClick={() => {
            navigate.toCompose({ projectId: isPersonal ? undefined : projectId, focusPrompt: true });
            list.onNavigate();
          }}
        >
          <Glyph name="plus" size={12} />
        </button>
      }
    >
      {split ? (
        <>
          {convPresence.entries.length > 0 ? (
            <ul className="wl-tree">
              {convPresence.entries.map((entry) => (
                <ConversationItem
                  key={entry.key}
                  item={entry.item}
                  phase={entry.phase}
                  onEntered={() => convPresence.markEntered(entry.key)}
                  onExited={() => convPresence.markExited(entry.key)}
                />
              ))}
            </ul>
          ) : null}
          <SettledFoot projectId={projectId} items={split.settled} open={settledOpen} holdsActive={settledHoldsActive} />
        </>
      ) : projectView ? (
        <>
          <ul className="wl-tree">
            {rootsPresence.entries.map((entry) => (
              <BranchItem
                key={entry.key}
                view={entry.item}
                actions={actions}
                phase={entry.phase}
                onEntered={() => rootsPresence.markEntered(entry.key)}
                onExited={() => rootsPresence.markExited(entry.key)}
              />
            ))}
            {loosePresence.entries.map((entry) => (
              <ThreadCell
                key={entry.key}
                thread={entry.item.thread}
                phase={entry.phase}
                onEntered={() => loosePresence.markEntered(entry.key)}
                onExited={() => loosePresence.markExited(entry.key)}
                origin
              />
            ))}
          </ul>
          <ProjectFoot
            merged={projectView.merged.filter((b) => b.threads.length > 0)}
            idle={[...projectView.idle, ...projectView.merged.filter((b) => b.threads.length === 0)]}
            actions={actions}
          />
        </>
      ) : null}
    </Section>
  );
}

function nodeTitle(view: ViewNode<Thread>, tx: Messages): string {
  const { node } = view;
  const name = (b: BranchView<Thread>) => b.branch ?? tx.detachedHead;
  const lines = [
    name(node),
    node.worktreePath ? tx.nodeWorktree(node.worktreePath) : tx.nodeNoWorktree,
    view.via.length > 0 ? tx.nodeVia([...view.via.map(name), name(node)].join(" → ")) : null,
    node.parentSource ? tx.nodeSource(sourceLabel(tx, node.parentSource)) : null,
    node.ahead !== null && node.ahead > 0 ? tx.nodeAhead(node.ahead) : null,
    node.isExternal ? tx.nodeExternal : null,
  ];
  return lines.filter(Boolean).join("\n");
}

function countThreads(view: ViewNode<Thread>): number {
  let total = [...walkThreads(view.node.threads)].length;
  for (const child of view.children) total += countThreads(child);
  return total;
}

/** 分支行右侧的小字标记：这条分支现在是什么状况 */
function branchTags(node: BranchView<Thread>, tx: Messages): string[] {
  return [
    node.isMain ? tx.tagMain : null,
    node.merged ? tx.tagMerged : node.ahead !== null && node.ahead > 0 ? `+${node.ahead}` : null,
    node.worktreePath === null ? tx.tagNoWorktree : null,
    node.isExternal ? tx.tagOutside : null,
  ].filter((tag): tag is string => tag !== null);
}

/** 一条分支上的全部对话，按最近活动排；这个视图里对话是次级行，不再按“谁派的”嵌套（派自谁用行上的小箭头表示） */
function branchThreads(node: BranchView<Thread>): Thread[] {
  const running = (t: Thread) => toneOf(t.indicator) === "running";
  return [...walkThreads(node.threads)].sort((a, b) => activityOf(b, running(b)) - activityOf(a, running(a)));
}

/**
 * 分支树视图的一个节点：分支是主行（图标 + 等宽分支名 + 右侧小字标记），它上面的对话是下面的次级行，
 * 从它切出去的分支再缩进一格。对齐只有一条规则：下一级的图标对齐上一级文字的左缘。
 */
function BranchItem({
  view,
  actions,
  quiet = false,
  depth = 0,
  phase = "present",
  onEntered,
  onExited,
}: {
  view: ViewNode<Thread>;
  actions: ProjectActions;
  quiet?: boolean;
  depth?: number;
  phase?: MotionPhase;
  onEntered?: () => void;
  onExited?: () => void;
}) {
  const tx = useT();
  const list = useList();
  const { node } = view;
  const exiting = phase === "exiting";
  const threads = useMemo(() => {
    const all = branchThreads(node);
    // 分支退场时过滤掉只是被置顶迁走的对话，避免与置顶区同时出现两份
    return exiting ? all.filter((t) => !list.activeIds.has(t.id)) : all;
  }, [node, exiting, list.activeIds]);
  const threadPresence = usePresenceList(threads, (t) => t.id, {
    enabled: list.ready && !exiting,
    resetKey: list.view,
    isRelocated: list.isRelocated,
    isNewGlobal: list.isNewGlobal,
  });
  const childrenPresence = usePresenceList(view.children, (child) => child.key, {
    enabled: list.ready && !exiting,
    resetKey: list.view,
  });
  const key = `node:${actions.projectId}:${view.key}`;
  const open = list.isOpen(key);
  const hasKids = childrenPresence.entries.length > 0;
  const hidden = view.children.length > 0 && !open ? view.children.reduce((sum, child) => sum + countThreads(child), 0) : 0;
  const tone = rollupTone(threads.map((t) => t.indicator));
  const dim = list.focusSet !== null && !threads.some((t) => list.focusSet!.has(t.id));
  const startHere = node.worktreePath ? { run: () => actions.startIn(node), known: actions.canStartIn(node) } : undefined;
  // 只给 bb 之外的、空闲或已合回的非主 worktree：
  // - 里面还有对话在跑 / 等你 / 出错时不给，免得把正在用的 worktree 删掉
  // - bb 登记过的环境（canStartIn）不给：它的生命周期归 bb 管（归档对话时 bb 自己删），绕过 bb 用 git 删会留下悬空的环境记录
  const busy = threads.some((t) => toneOf(t.indicator) !== null && toneOf(t.indicator) !== "done");
  const cleanupCmd =
    node.worktreePath && !node.isMain && !busy && !actions.canStartIn(node) && (quiet || node.merged || threads.length === 0)
      ? worktreeCleanupCommand({ repoPath: actions.repoPath, worktreePath: node.worktreePath, branch: node.branch, merged: node.merged })
      : null;
  const labels = pathLabels(view.via, node, tx.detachedHead);
  const leaf = labels.pop()!;
  const tags = branchTags(node, tx);

  return (
    <MotionRow
      phase={phase}
      flipId={`branch:${actions.projectId}:${view.key}`}
      onEntered={onEntered}
      onExited={onExited}
      onSettled={list.syncPositions}
    >
      <div className="wl-brow" title={nodeTitle(view, tx)} data-dim={dim} data-quiet={quiet || node.merged || undefined} data-ghost={node.worktreePath === null || undefined}>
        <span className="wl-bicon" data-tone={tone ?? undefined}>
          <Glyph name={node.isMain ? "home" : node.branch === null ? "commit" : node.merged ? "merged" : "branch"} size={14} />
        </span>
        <span className="wl-bname">
          {labels.length > 0 ? <span className="wl-bvia">{labels.join(" › ")} › </span> : null}
          {leaf}
        </span>
        {tags.length > 0 ? <span className="wl-btags">{tags.join(" · ")}</span> : null}
        {cleanupCmd && !exiting ? <CopyCleanupButton command={cleanupCmd} /> : null}
        {startHere && !exiting ? <StartHereButton {...startHere} reveal /> : null}
        {hasKids && !exiting ? <FoldButton open={open} hidden={hidden} toggle={() => list.toggle(key)} /> : null}
      </div>
      {threadPresence.entries.length > 0 ? (
        // 后面还有切出去的分支时，竖线要穿过最后一条对话接下去
        <ul className="wl-tree" data-nested="true" data-continues={(hasKids && open) || undefined} style={depthStyle(depth + 1)}>
          {threadPresence.entries.map((entry) => (
            <ThreadCell
              key={entry.key}
              thread={entry.item}
              phase={exiting ? "present" : entry.phase}
              forceStaticTitle={exiting}
              onEntered={() => threadPresence.markEntered(entry.key)}
              onExited={() => threadPresence.markExited(entry.key)}
              secondary
              origin
              focusChip
            />
          ))}
        </ul>
      ) : null}
      {hasKids ? (
        <Collapse open={open}>
          <ul className="wl-tree" data-nested="true" style={depthStyle(depth + 1)}>
            {childrenPresence.entries.map((entry) => (
              <BranchItem
                key={entry.key}
                view={entry.item}
                actions={actions}
                quiet={quiet}
                depth={depth + 1}
                phase={exiting ? "present" : entry.phase}
                onEntered={() => childrenPresence.markEntered(entry.key)}
                onExited={() => childrenPresence.markExited(entry.key)}
              />
            ))}
          </ul>
        </Collapse>
      ) : null}
    </MotionRow>
  );
}

function StartHereButton({ run, known, reveal = false }: { run: () => void; known: boolean; reveal?: boolean }) {
  const tx = useT();
  return (
    <button
      type="button"
      className={reveal ? "wl-btn wl-reveal" : "wl-btn"}
      aria-label={tx.startHere}
      title={known ? tx.startHere : tx.startHereUnregistered}
      onClick={run}
    >
      <Glyph name="plus" size={12} />
    </button>
  );
}

/** 复制空闲 / 已合回 worktree 的安全清理命令（绝不自动删目录） */
function CopyCleanupButton({ command }: { command: string }) {
  const tx = useT();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  return (
    <button
      type="button"
      className="wl-btn wl-reveal"
      data-copied={copied || undefined}
      aria-label={tx.copyCleanup}
      title={copied ? tx.copiedCleanup(command) : tx.copyCleanupTitle(command)}
      onClick={() => {
        void copyToClipboard({ text: command });
        setCopied(true);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1600);
      }}
    >
      <Glyph name={copied ? "check" : "terminal"} size={12} />
    </button>
  );
}

/** 对话视图的 Settled 架子：做完了但不想触发 bb 归档（不删托管环境）的对话收在这里，随时可恢复 */
function SettledFoot({
  projectId,
  items,
  open,
  holdsActive,
}: {
  projectId: string;
  items: Conversation<Thread>[];
  open: boolean;
  holdsActive: boolean;
}) {
  const tx = useT();
  const list = useList();
  const key = `settled:${projectId}`;
  const presence = usePresenceList(items, (item) => item.thread.id, {
    enabled: list.ready && open,
    resetKey: list.view,
    isRelocated: list.isRelocated,
    isNewGlobal: list.isNewGlobal,
  });
  if (items.length === 0 && presence.entries.length === 0) return null;

  return (
    <div>
      <button type="button" className="wl-foot" data-open={open} aria-expanded={open} onClick={() => list.toggle(key, holdsActive)}>
        <Glyph name="chevron" size={9} className="wl-chev" />
        <span>{tx.footSettled(items.length)}</span>
      </button>
      <Collapse open={open}>
        <ul className="wl-tree">
          {presence.entries.map((entry) => (
            <ConversationItem
              key={entry.key}
              item={entry.item}
              settled
              phase={entry.phase}
              onEntered={() => presence.markEntered(entry.key)}
              onExited={() => presence.markExited(entry.key)}
            />
          ))}
        </ul>
      </Collapse>
    </div>
  );
}

/** 收起时常显并带上被收起的对话数；展开时只在悬停出现 */
function FoldButton({ open, hidden, toggle }: { open: boolean; hidden: number; toggle: () => void }) {
  const tx = useT();
  return (
    <button
      type="button"
      className={open ? "wl-chip wl-reveal" : "wl-chip"}
      data-open={open}
      aria-expanded={open}
      title={open ? tx.foldBranchesOpen : tx.foldBranchesClosed(hidden)}
      onClick={toggle}
    >
      {open ? null : hidden}
      <Glyph name="chevron" size={8} className="wl-chev" />
    </button>
  );
}

/** 分支树视图的项目页脚：已合回的分支、没有对话的 worktree，各收成一个数字，点开才展开 */
function ProjectFoot({ merged, idle, actions }: { merged: BranchView<Thread>[]; idle: BranchView<Thread>[]; actions: ProjectActions }) {
  const tx = useT();
  const list = useList();
  const key = `foot:${actions.projectId}`;
  const mergedThreads = useMemo(() => merged.flatMap((branch) => [...walkThreads(branch.threads)]), [merged]);
  const holdsActive = mergedThreads.some((t) => t.id === list.activeThreadId);
  const open = list.isOpen(key, holdsActive);
  if (merged.length === 0 && idle.length === 0) return null;

  return (
    <div>
      <button type="button" className="wl-foot" data-open={open} aria-expanded={open} onClick={() => list.toggle(key, holdsActive)}>
        <Glyph name="chevron" size={9} className="wl-chev" />
        {merged.length > 0 ? <span>{tx.footMerged(merged.length)}</span> : null}
        {merged.length > 0 && idle.length > 0 ? <span className="wl-foot-sep">·</span> : null}
        {idle.length > 0 ? <span>{tx.footIdle(idle.length)}</span> : null}
      </button>
      <Collapse open={open}>
        <ul className="wl-tree">
          {[...merged, ...idle].map((branch) => (
            <BranchItem key={branch.key} view={{ kind: "card", key: branch.key, via: [], node: branch, children: [] }} actions={actions} quiet />
          ))}
        </ul>
      </Collapse>
    </div>
  );
}

/**
 * 对话视图的一个节点：一条对话一行；它派出的对话缩进一格排在下面，用细拐线连着，可以整组收起。
 * 这个视图不出现分支。
 */
function ConversationItem({
  item,
  depth = 0,
  settled = false,
  phase = "present",
  onEntered,
  onExited,
}: {
  item: Conversation<Thread>;
  depth?: number;
  settled?: boolean;
  phase?: MotionPhase;
  onEntered?: () => void;
  onExited?: () => void;
}) {
  const list = useList();
  const key = `conv:${item.thread.id}`;
  const exiting = phase === "exiting";
  // 父对话退场时过滤掉仍存活的子对话（它们已晋升到顶层，避免双份渲染）
  const liveChildren = useMemo(
    () => (exiting ? item.children.filter((c) => !list.activeIds.has(c.thread.id)) : item.children),
    [exiting, item.children, list.activeIds],
  );
  const childPresence = usePresenceList(liveChildren, (c) => c.thread.id, {
    enabled: list.ready && !exiting,
    resetKey: list.view,
    isRelocated: list.isRelocated,
    isNewGlobal: list.isNewGlobal,
  });
  const total = countDescendants(item);
  // 默认展开：派出的对话是这一家正在做的事，收起是用户自己的选择
  const open = list.isOpen(key);
  // 只有对话视图顶层允许整家 Settle / Unsettle（子对话随父对话一起收放）
  const settleAction =
    depth === 0 && !exiting
      ? settled
        ? { mode: "unsettle" as const, run: () => list.unsettle(item.thread.id) }
        : { mode: "settle" as const, run: () => list.settle(item.thread.id) }
      : undefined;
  return (
    <ThreadCell
      thread={item.thread}
      quiet={settled}
      settleAction={settleAction}
      phase={phase}
      onEntered={onEntered}
      onExited={onExited}
      fold={total > 0 && !exiting ? { count: total, open, toggle: () => list.toggle(key) } : undefined}
    >
      {childPresence.entries.length > 0 ? (
        <Collapse open={open}>
          <ul className="wl-tree" data-nested="true" style={depthStyle(depth + 1)}>
            {childPresence.entries.map((entry) => (
              <ConversationItem
                key={entry.key}
                item={entry.item}
                depth={depth + 1}
                settled={settled}
                phase={exiting ? "present" : entry.phase}
                onEntered={() => childPresence.markEntered(entry.key)}
                onExited={() => childPresence.markExited(entry.key)}
              />
            ))}
          </ul>
        </Collapse>
      ) : null}
    </ThreadCell>
  );
}

/**
 * 带高度动画的展开 / 收起。内容在第一次展开时才挂载；收起动画结束后卸载，
 * 这样收起的对话行不会留在 DOM 里干扰 bb 的行快捷键。
 * 展开稳定后放开 overflow（data-settled），避免裁切跨区置顶飞跃与选中阴影。
 */
function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const list = useList();
  const [mounted, setMounted] = useState(open);
  const [settled, setSettled] = useState(open);
  // “上一次的 open”放在 state 里而不是 ref：渲染被 React 丢弃时 state 会一起回滚，ref 不会，
  // 用 ref 会出现“已展开但内容没挂载”的空架子（实测连点页脚 + 切视图时出现过）
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open && !mounted) setMounted(true);
    if (settled) setSettled(false);
  }
  useEffect(() => {
    // 兜底：只要是展开的就保证内容已挂载
    if (open) setMounted(true);
    if (reducedMotion()) {
      setMounted(open);
      setSettled(open);
      list.syncPositions();
      return;
    }
    const timer = setTimeout(() => {
      if (open) setSettled(true);
      else setMounted(false);
      list.syncPositions();
    }, 260);
    return () => clearTimeout(timer);
  }, [open, list.syncPositions]);

  return (
    <div
      className="wl-collapse"
      data-open={open}
      data-settled={settled || undefined}
      inert={!open}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || event.propertyName !== "grid-template-rows") return;
        if (!open) setMounted(false);
        else setSettled(true);
        list.syncPositions();
      }}
    >
      <div className="wl-collapse-inner">{mounted ? children : null}</div>
    </div>
  );
}

/** 侧边栏线程 → bb 线程菜单需要的目标形状（环境 id 可能为空） */
function actionTarget(thread: Thread) {
  const env = thread.environment;
  return { ...thread, environment: env?.id ? { id: env.id, path: env.path } : null };
}

/** 悬停时出现在标题行右端的快捷操作。只在行第一次被悬停后才挂载，避免每一行都订阅操作列表 */
function QuickActions({
  thread,
  startHere,
  settleAction,
}: {
  thread: Thread;
  startHere?: { run: () => void; known: boolean };
  settleAction?: { mode: "settle" | "unsettle"; run: () => void };
}) {
  const tx = useT();
  const target = actionTarget(thread);
  const entries = useThreadActions(target, { keys: QUICK_ACTIONS });
  return (
    <span className="wl-actions">
      {startHere ? <StartHereButton {...startHere} /> : null}
      {settleAction ? (
        <button
          type="button"
          className="wl-btn"
          aria-label={settleAction.mode === "settle" ? tx.settle : tx.unsettle}
          title={settleAction.mode === "settle" ? tx.settleTitle : tx.unsettleTitle}
          onClick={settleAction.run}
        >
          <Glyph name={settleAction.mode} size={13} />
        </button>
      ) : null}
      {entries
        .filter((entry) => entry.action.choices === undefined)
        .map((entry) => (
          <button
            key={entry.key}
            type="button"
            className="wl-btn"
            aria-label={quickActionLabel(tx, entry.key, entry.action.label)}
            title={quickActionLabel(tx, entry.key, entry.action.label)}
            disabled={entry.action.disabled}
            onClick={() => void entry.action.run()}
          >
            <Icon name={entry.action.icon} className="size-3.5" />
          </button>
        ))}
      <ThreadActionsMenu
        thread={target}
        side="right"
        align="start"
        sideOffset={8}
        trigger={(triggerProps) => (
          <button {...triggerProps} type="button" className="wl-btn" aria-label={tx.moreActions} title={tx.moreActions}>
            <Glyph name="more" size={14} />
          </button>
        )}
      />
    </span>
  );
}

/**
 * 一条对话，一行：provider 图标 → 标题 → 右侧两个固定的槽。
 * 左槽是它派出的对话数（有才出现）；右槽是状态标记或时间，二选一。悬停时右槽原地换成快捷操作
 * （排在同一行里，不浮在别的控件上面，所以不会挡住左槽）。
 *
 * - sub:       第二行（只有搜索结果用：命中的那段文字、所在项目）
 * - secondary: 分支树视图里的次级行：小一号、灰一档
 * - fold:      对话视图里，它派出的对话可以整组收起；数量槽就是开关
 * - focusChip: 分支树视图里，派出的对话散在各个分支上；数量槽改成“高亮它们”
 * - origin:    它是被派出来的，而派它的对话不在它上面：标题后给一个“派自”的小箭头
 */
function ThreadCell({
  thread,
  sub,
  secondary = false,
  quiet = false,
  fold,
  focusChip = false,
  origin: showOrigin = false,
  startHere,
  settleAction,
  phase = "present",
  forceStaticTitle = false,
  onEntered,
  onExited,
  children,
}: {
  thread: Thread;
  /** 排在这一行下面、属于它的内容（它派出的对话） */
  children?: ReactNode;
  sub?: ReactNode;
  secondary?: boolean;
  quiet?: boolean;
  fold?: { count: number; open: boolean; toggle: () => void };
  focusChip?: boolean;
  origin?: boolean;
  startHere?: { run: () => void; known: boolean };
  settleAction?: { mode: "settle" | "unsettle"; run: () => void };
  phase?: MotionPhase;
  forceStaticTitle?: boolean;
  onEntered?: () => void;
  onExited?: () => void;
}) {
  const tx = useT();
  const lang = useLang();
  const list = useList();
  const navigate = useBbNavigate();
  const { splitProps, layout } = useSidebarThreadSplit(thread.id);
  const rowStatus = useSidebarThreadRowStatus(thread.id);
  const [hot, setHot] = useState(false);

  const exiting = phase === "exiting" || forceStaticTitle;
  const isActive = list.activeThreadId === thread.id;
  const isFocused = list.focusId === thread.id;
  const dispatched = focusChip ? list.childCount.get(thread.id) ?? 0 : 0;
  const provider = thread.providerId ? list.providersById.get(thread.providerId) : undefined;
  const origin = showOrigin && thread.parentThreadId ? list.threadsById.get(thread.parentThreadId) : undefined;
  // 输入框里有没发出去的内容：bb 把它单独给，不在 indicator 里。行尾画 bb 自己的铅笔，整行换成草稿色
  const { hasUnsubmittedDraft } = useSidebarThreadDraft(thread.id);
  const indicator = !hasUnsubmittedDraft ? thread.indicator : thread.indicator === "none" ? "draft" : thread.indicator === "runtime" ? "working-draft" : thread.indicator;
  const showGlyph = rowStatus !== null || indicator !== "none";
  const running = toneOf(thread.indicator) === "running";
  const time = relativeTime(activityOf(thread, running), list.now, lang);
  const tone = rowTone(thread.indicator, hasUnsubmittedDraft);
  // 搜索结果行保留轻淡入；正常列表行由 MotionRow 高度撑开和全局 FLIP 接管，避免置顶滑移时闪烁
  const arrive = useRef(sub !== undefined && list.ready).current;
  // 状态变了（比如从运行中变成完成、变成等你回复）时，整行闪一下提示
  const lastTone = useRef(tone);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (lastTone.current === tone) return;
    lastTone.current = tone;
    if (tone === null || tone === "running" || tone === "draft") return;
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), 1500);
    return () => clearTimeout(timer);
  }, [tone]);

  // 只有空闲或完成未读（且未置顶）的对话才展示 Settle 按钮；Settled 架子里的对话始终展示 Unsettle
  const effectiveSettle =
    settleAction && (settleAction.mode === "unsettle" || (!thread.isPinned && (tone === null || tone === "done")))
      ? settleAction
      : undefined;

  return (
    <MotionRow
      phase={phase}
      flipId={sub === undefined ? `thread:${thread.id}` : undefined}
      onEntered={onEntered}
      onExited={onExited}
      onSettled={list.syncPositions}
    >
      <ThreadActionsContextMenu thread={actionTarget(thread)}>
        <div
          className={arrive ? "wl-cell wl-arrive" : "wl-cell"}
          data-tone={tone ?? undefined}
          data-yours={!quiet ? rowColor(tone) ?? undefined : undefined}
          data-quiet={quiet || undefined}
          data-flash={flash || undefined}
          data-selected={list.selectedId === thread.id || undefined}
          data-lines={sub !== undefined ? 2 : 1}
          data-secondary={secondary || undefined}
          data-active={isActive}
          data-focused={isFocused}
          data-unread={thread.isUnread}
          data-split={!isActive && layout !== null}
          data-dim={list.focusSet !== null && !list.focusSet.has(thread.id)}
          onPointerEnter={(event) => {
            if (exiting) return;
            if (!hot) setHot(true);
            if (event.pointerType === "mouse") list.peekSchedule(thread, event.currentTarget);
          }}
          onPointerLeave={() => list.peekCancel()}
          onFocus={hot || exiting ? undefined : () => setHot(true)}
        >
          {running && !exiting ? <span className="wl-arc" aria-hidden="true" /> : null}
          <a
            className="wl-cell-link"
            data-sidebar-thread-shortcut-target=""
            data-sidebar-thread-id={thread.id}
            href={thread.href}
            draggable={false}
            aria-label={thread.displayTitle}
            aria-current={isActive ? "page" : undefined}
            {...splitProps}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              event.preventDefault();
              navigate.toThread(thread.id);
              list.onNavigate();
            }}
          />
          <div className="wl-line1">
            <span className="wl-logo" title={provider?.displayName}>
              {provider ? <ProviderIcon providerKind="agent" provider={provider} className="size-3.5" aria-label={provider.displayName} /> : null}
            </span>
            <span className="wl-title">
              {exiting ? thread.displayTitle : <ThreadTitle threadId={thread.id} />}
            </span>
            {origin ? (
              <button
                type="button"
                className="wl-btn"
                style={{ width: 18, height: 18 }}
                aria-label={tx.dispatchedFrom(origin.displayTitle)}
                title={tx.dispatchedFromOpen(origin.displayTitle)}
                onClick={() => {
                  navigate.toThread(origin.id);
                  list.onNavigate();
                }}
              >
                <Glyph name="origin" size={11} />
              </button>
            ) : null}
            {fold ? (
              <button
                type="button"
                className="wl-chip"
                data-open={fold.open}
                aria-expanded={fold.open}
                title={fold.open ? tx.foldChildrenOpen(fold.count) : tx.foldChildrenClosed(fold.count)}
                onClick={fold.toggle}
              >
                <Glyph name="dispatch" size={9} />
                {fold.count}
              </button>
            ) : dispatched > 0 ? (
              <button
                type="button"
                className="wl-chip"
                aria-pressed={isFocused}
                title={isFocused ? tx.clearHighlight : tx.highlightDispatched(dispatched)}
                onClick={() => list.setFocus(isFocused ? null : thread.id)}
              >
                <Glyph name="dispatch" size={9} />
                {dispatched}
              </button>
            ) : null}
            <span className="wl-tail">
              <span className="wl-slot">{showGlyph ? <ThreadStatusGlyph indicator={indicator} rowStatus={rowStatus} size="compact" /> : time}</span>
              {hot && !list.compact && !exiting ? <QuickActions thread={thread} startHere={startHere} settleAction={effectiveSettle} /> : null}
            </span>
          </div>
          {sub !== undefined ? <div className="wl-line2">{sub}</div> : null}
        </div>
      </ThreadActionsContextMenu>
      {children}
    </MotionRow>
  );
}
