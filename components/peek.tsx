/**
 * [INPUT]: 依赖 @get-bb/plugin-sdk/app 的线程数据类型、provider 图标、keyed RPC 查询与 useRpc; 读取本插件服务端的 briefing RPC（存盘的全程速览 + 是否落后 + 兜底摘要，一次取回）; 读取内置插件 bb--git 的 status 与 bb--github-pr-status 的 pullRequests; 依赖 components/i18n 的 useT（卡片标签按界面语言）
 * [OUTPUT]: 对外提供 Peek: 悬停预览卡。有速览时显示“一句话 + 分阶段 + 现在 / 等你 / 下一步”；没有速览或速览落后时，用不花 token 的摘要（你问 / 答复）补上。卡片自己从不触发模型调用。在对话之间移动时是同一张卡片连续变形：位置和高度一起过渡，旧内容淡出的同时新内容淡入。鼠标可以移到卡片上：卡片不消失，文字可选中复制
 * [POS]: components 的浮层; 消费者: components/lineage-list.tsx; 与它的边界: 何时显示 / 隐藏由列表决定（鼠标进出卡片经 hover 回调告诉列表），这里只负责取数、展示与切换动画; 卡片渲染到 document.body（侧边栏有自己的层叠上下文，留在里面会被主区域盖住）
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  experimental_ProviderIcon as ProviderIcon,
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  useRpc,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { Glyph } from "@/components/icons";
import { useT } from "@/components/i18n";
import type { Messages } from "@/lib/i18n";
import type { BriefingStage } from "@/lib/briefing";
import type { BriefingView, serverContract } from "@/lib/contract";
import { rowTone, type RowTone, type Tone } from "@/lib/view";
import { formatHomePathForDisplay } from "@/lib/utils";

declare const __BB_PLUGIN_ID__: string | undefined;

const lineStats = z.object({ fileCount: z.number(), insertions: z.number(), deletions: z.number() });
/** 只抄我们读的那几个字段；其余字段 zod 会丢弃 */
const gitContract = defineRpcContract({
  status: {
    input: z.object({ keys: z.array(z.string()) }),
    output: z.record(
      z.string(),
      z.object({
        outcome: z.string(),
        workspace: z.object({ workingTree: lineStats, allChanges: lineStats.nullish() }).optional(),
      }),
    ),
  },
});
const prContract = defineRpcContract({
  pullRequests: {
    input: z.object({ keys: z.array(z.string()) }),
    output: z.record(
      z.string(),
      z.object({
        outcome: z.string(),
        pullRequest: z.object({ number: z.number(), title: z.string(), state: z.string() }).optional(),
      }),
    ),
  },
});

const prState = (tx: Messages, state: string): string =>
  ({ OPEN: tx.prOpen, MERGED: tx.prMerged, CLOSED: tx.prClosed, DRAFT: tx.prDraft })[state.toUpperCase()] ?? state.toLowerCase();

/** bb 自己管理的 worktree 路径又长又没有信息量，不显示；其余路径把家目录缩成 ~ */
function describePath(path: string | null): string | null {
  if (!path) return null;
  if (path.includes("/.bb/plugins/environment-git-worktree/")) return null;
  return formatHomePathForDisplay(path);
}

export interface PeekTarget {
  thread: PluginSidebarThread;
  /** 输入框里有没发出去的内容 */
  hasDraft: boolean;
  /** 触发它的那一行在视口里的位置 */
  top: number;
  /** 卡片贴着侧边栏右缘出现 */
  left: number;
  projectName: string | null;
  provider: ComponentProps<typeof ProviderIcon>["provider"] | undefined;
  /** git 里这个 worktree 现在检出的分支；读不到 git 时是 bb 记录的分支名 */
  branch: string | null;
  parentBranch: string | null;
  detached: boolean;
  dispatchedBy: string | null;
  /** 它直接派出的对话各自的状态 */
  children: (Tone | null)[];
  time: string;
}

/** 每条对话上次取回的内容：再次移到它上面时立刻可用，同时在后台重读一次（只是读存盘，不花钱） */
const viewCache = new Map<string, BriefingView>();
const EMPTY_VIEW: BriefingView = { briefing: null, freshness: null, recap: { turns: 0, ask: null, reply: null }, enabled: true };

function StageMark({ state }: { state: BriefingStage["state"] }) {
  const tx = useT();
  const label = { done: tx.stageDone, doing: tx.stageDoing, dropped: tx.stageDropped }[state];
  return (
    <span className="wl-peek-mark" data-state={state} role="img" aria-label={label}>
      {state === "done" ? <Glyph name="check" size={10} /> : state === "dropped" ? <Glyph name="dash" size={10} /> : null}
    </span>
  );
}

const statusLabel = (tx: Messages, tone: RowTone): string =>
  ({ error: tx.statusError, attention: tx.statusAttention, draft: tx.statusDraft, running: tx.statusRunning, done: tx.statusDone })[tone];

/** 派出的对话按状态计数时的顺序与叫法（空闲的不值得占字） */
const childLabels = (tx: Messages): [Tone, string][] => [
  ["error", tx.childError],
  ["attention", tx.childAttention],
  ["running", tx.childRunning],
  ["done", tx.childDone],
];

/**
 * 取数层。卡片画的是 shown，不是 target：鼠标移到另一条对话时，新内容取回之前继续画旧的，
 * 取回后一次换过去。这样卡片不会先缩成只剩标题、再长回来。
 */
/** 鼠标移到卡片上 / 离开卡片：由列表决定卡片留不留 */
export interface PeekHover {
  onEnter: () => void;
  onLeave: () => void;
}

const PEEK_EXIT_MS = 130;

export function Peek({ target, hover }: { target: PeekTarget | null; hover: PeekHover }) {
  const rpc = useRpc<typeof serverContract>();
  // 放进 ref：这个引用每次渲染是否稳定由宿主决定，不能让它触发重复请求
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const latest = useRef(target);
  latest.current = target;
  const threadId = target?.thread.id ?? null;
  const updatedAt = target?.thread.updatedAt ?? 0;
  const [shown, setShown] = useState<{ threadId: string; target: PeekTarget; view: BriefingView } | null>(() => {
    if (!target) return null;
    const cached = viewCache.get(target.thread.id);
    return cached ? { threadId: target.thread.id, target, view: cached } : null;
  });
  useEffect(() => {
    if (!threadId) {
      if (reducedMotion()) {
        setShown(null);
        return;
      }
      const timer = setTimeout(() => setShown(null), PEEK_EXIT_MS);
      return () => clearTimeout(timer);
    }
    let cancelled = false;
    const show = (view: BriefingView) => {
      if (!cancelled && latest.current) setShown({ threadId, target: latest.current, view });
    };
    const cached = viewCache.get(threadId);
    if (cached) show(cached);
    rpcRef.current
      .call("briefing", { threadId })
      .then((view) => {
        viewCache.set(threadId, view);
        show(view);
      })
      .catch(() => show(cached ?? EMPTY_VIEW));
    return () => {
      cancelled = true;
    };
  }, [threadId, updatedAt]);

  if (shown === null) return null;
  const closing = target === null;
  // 画的就是鼠标所在的这条：位置、状态跟着最新的 target 走；关闭中保留最后一条内容淡出
  const activeTarget = !closing && shown.threadId === threadId ? target : shown.target;
  return <PeekCard target={activeTarget} view={shown.view} hover={hover} closing={closing} />;
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function PeekCard({ target, view, hover, closing }: { target: PeekTarget; view: BriefingView; hover: PeekHover; closing: boolean }) {
  const tx = useT();
  const { thread } = target;
  const envId = thread.environment?.id ?? null;
  const keys = envId ? [envId] : [];
  const git = useRpcKeyedQuery({ pluginId: "bb--git", contract: gitContract, method: "status", keys, enabled: keys.length > 0 });
  const pr = useRpcKeyedQuery({ pluginId: "bb--github-pr-status", contract: prContract, method: "pullRequests", keys, enabled: keys.length > 0 });

  const { briefing, recap } = view;
  // 速览写完之后又有了新消息：阶段仍然成立，但“现在 / 等你 / 下一步”已经过时，换成最新一轮的原话
  const fresh = briefing !== null && view.freshness?.state !== "behind";
  const newAsks = view.freshness?.state === "behind" ? view.freshness.newAsks : 0;

  /**
   * 同一张卡片连续变形（共享元素过渡）：
   * - 外框的位置和高度都用 CSS 过渡，所以从一条对话移到另一条时是滑过去、同时长高或变矮
   * - 内容换人时，把上一条对话画出来的样子留在一层“残影”里淡出，新内容同时淡入
   */
  const body = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const lastHtml = useRef("");
  const lastId = useRef(thread.id);
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const height = element.offsetHeight;
    // 先按触发行的位置放，再按实际高度往上挪，保证不超出视口
    const top = Math.max(8, Math.min(target.top - 6, window.innerHeight - height - 8));
    setBox((current) => (current && current.top === top && current.height === height ? current : { top, height }));
  });
  useLayoutEffect(() => {
    if (lastId.current === thread.id) return;
    lastId.current = thread.id;
    const layer = ghost.current;
    if (!layer || !body.current || reducedMotion()) return;
    layer.innerHTML = lastHtml.current;
    layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: "ease-in-out", fill: "forwards" }).onfinish = () => {
      layer.innerHTML = "";
    };
    body.current.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease-in-out" });
  }, [thread.id]);
  // 每次画完记下当前的样子，留给下一次换人时当残影（声明在上面两个 effect 之后，所以换人时读到的还是上一条）
  useEffect(() => {
    lastHtml.current = body.current?.innerHTML ?? "";
  });

  const workspace = envId ? git.data?.[envId]?.workspace : undefined;
  const changes = workspace?.allChanges ?? workspace?.workingTree;
  const uncommitted = workspace?.workingTree.fileCount ?? 0;
  const pullRequest = envId ? pr.data?.[envId]?.pullRequest : undefined;
  const branch = target.branch ?? (target.detached ? tx.detachedHead : null);
  const path = describePath(thread.environment?.path ?? null);
  const pluginId = typeof __BB_PLUGIN_ID__ === "string" ? __BB_PLUGIN_ID__ : "worktree-lineage";

  // 进展：一行里能说清的事实，逐项拼起来；空闲的不值得占字
  const progress: string[] = [];
  if (recap.turns > 1) progress.push(tx.turns(recap.turns));
  if (target.children.length > 0) {
    const busy = childLabels(tx)
      .map(([tone, label]) => [target.children.filter((t) => t === tone).length, label] as const)
      .filter(([n]) => n > 0);
    progress.push(tx.dispatchedCount(target.children.length, busy.map(([n, label]) => tx.childPart(n, label))));
  }
  if (pullRequest) progress.push(tx.pullRequest(pullRequest.number, prState(tx, pullRequest.state)));
  const hasChanges = changes !== undefined && (changes.fileCount > 0 || uncommitted > 0);
  const tone = rowTone(thread.indicator, target.hasDraft);
  const status = tone ? statusLabel(tx, tone) : null;

  return createPortal(
    <div
      className="wl-peek"
      role="group"
      aria-label={thread.displayTitle}
      onPointerEnter={hover.onEnter}
      onPointerLeave={hover.onLeave}
      // 第一次量出高度之前不设高度、不开过渡：卡片直接出现在正确的位置
      data-settled={box !== null || undefined}
      data-closing={closing || undefined}
      style={{ top: box?.top ?? target.top, left: target.left, height: box?.height }}
      data-bb-portaled-overlay=""
      data-bb-plugin-root=""
      data-bb-plugin={pluginId}
    >
      <div className="wl-peek-ghost" ref={ghost} aria-hidden="true" />
      <div className="wl-peek-body" ref={body}>
        <div className="wl-peek-head">
          <span className="wl-peek-logo">{target.provider ? <ProviderIcon providerKind="agent" provider={target.provider} className="size-3.5" /> : null}</span>
          <span className="wl-peek-title">{thread.displayTitle}</span>
        </div>
        <div className="wl-peek-meta">
          {target.projectName ? <span>{target.projectName}</span> : null}
          {status ? <span data-tone={tone ?? undefined}>{status}</span> : null}
          <span>{target.time}</span>
        </div>

        {briefing ? (
          <div className="wl-peek-brief">
            <p className="wl-peek-about">{briefing.about}</p>
            <ol className="wl-peek-stages">
              {briefing.stages.map((stage, index) => (
                <li key={index} data-state={stage.state}>
                  <StageMark state={stage.state} />
                  <span className="wl-peek-stage-title">{stage.title}</span>
                  {stage.note ? <span className="wl-peek-stage-note">{stage.note}</span> : null}
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        <dl className="wl-peek-recap">
          {fresh && briefing?.now ? (
            <>
              <dt>{tx.recapNow}</dt>
              <dd>{briefing.now}</dd>
            </>
          ) : null}
          {fresh && briefing?.waiting ? (
            <>
              <dt data-tone="attention">{tx.recapWaiting}</dt>
              <dd>{briefing.waiting}</dd>
            </>
          ) : null}
          {fresh && briefing?.next ? (
            <>
              <dt>{tx.recapNext}</dt>
              <dd data-quiet="true">{briefing.next}</dd>
            </>
          ) : null}
          {!fresh && recap.ask ? (
            <>
              <dt>{briefing && newAsks > 0 ? tx.recapAskSince : tx.recapAsk}</dt>
              <dd data-quiet={briefing ? undefined : "true"}>{recap.ask}</dd>
            </>
          ) : null}
          {!fresh && recap.reply ? (
            <>
              <dt>{tx.recapReply}</dt>
              <dd>{recap.reply}</dd>
            </>
          ) : null}
          {progress.length > 0 || hasChanges ? (
            <>
              <dt>{tx.recapProgress}</dt>
              <dd data-quiet="true">
                {progress.join(" · ")}
                {hasChanges && changes ? (
                  <>
                    {progress.length > 0 ? " · " : null}
                    <b data-kind="add">+{changes.insertions}</b> <b data-kind="del">−{changes.deletions}</b>
                    {uncommitted > 0 ? ` · ${tx.uncommitted(uncommitted)}` : null}
                  </>
                ) : null}
              </dd>
            </>
          ) : null}
        </dl>
        {briefing && !fresh ? (
          <p className="wl-peek-behind">{newAsks > 0 ? tx.behindByAsks(newAsks) : tx.behindLatestReply}</p>
        ) : null}

        {branch || target.dispatchedBy ? (
          <div className="wl-peek-foot">
            {branch ? (
              <div className="wl-peek-row">
                <Glyph name="branch" size={11} />
                <span className="wl-peek-mono">
                  {branch}
                  {target.parentBranch ? <em>{tx.branchFrom(target.parentBranch)}</em> : null}
                </span>
              </div>
            ) : null}
            {path ? (
              <div className="wl-peek-row">
                <Glyph name="home" size={11} />
                <span className="wl-peek-mono">{path}</span>
              </div>
            ) : null}
            {target.dispatchedBy ? (
              <div className="wl-peek-row">
                <Glyph name="origin" size={11} />
                <span>{tx.dispatchedFrom(target.dispatchedBy)}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
