/**
 * [INPUT]: 无外部依赖（纯数据 + 纯函数）
 * [OUTPUT]: 对外提供 Lang / LanguageSetting 类型、LANGUAGE_SETTINGS、LANGUAGE_OPTION_LABELS、resolveLanguage（auto / en / zh → en | zh）、MESSAGES（界面全部文案，en 与 zh 两本同构词典）、SETTINGS_TEXT（服务端设置项的英文标签与说明，bb 设置页不能随语言切换）、relativeTime / agoText（按语言的短相对时间、多久以前）、LANGUAGE_STORAGE_KEY
 * [POS]: lib 的界面语言层; 消费者: components/i18n.tsx（解析语言、提供 useT）、app.tsx（槽位与设置分区的标题）、components/settings-section.tsx（设置面板）、server.ts（设置项标签）、lib/view.ts（相对时间）; 与 lib/briefing.ts 的边界: 这里只管界面文案，交给模型的提示词按语言放在 briefing
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 *
 * 零混用规则：选了一种语言，界面上就只出现这种语言。英文词典里不能有汉字，中文词典里不能有英文界面词；
 * 只有专有名词与代码保持原样（Git、BB、HEAD、分支名、路径、命令、按键名 Esc / Alt / Option）。test/i18n.test.ts 机械校验。
 */

export type Lang = "en" | "zh";
export const LANGUAGE_SETTINGS = ["auto", "en", "zh"] as const;
export type LanguageSetting = (typeof LANGUAGE_SETTINGS)[number];

/** 设置项下拉框的选项名：语言名按惯例用它自己的文字写，让任何人都认得出自己的语言（不属于界面词典） */
export const LANGUAGE_OPTION_LABELS: Record<LanguageSetting, string> = { auto: "Auto (follow BB)", en: "English", zh: "简体中文" };

/** 前端把设置值镜像到这里：挂载时同步读，第一帧就是对的语言，不闪 */
export const LANGUAGE_STORAGE_KEY = "worktree-lineage.language";

export function isLanguageSetting(value: unknown): value is LanguageSetting {
  return typeof value === "string" && (LANGUAGE_SETTINGS as readonly string[]).includes(value);
}

/**
 * 设置值 → 实际语言。en / zh 直接用；auto（或无效值）按宿主语言依次判断：
 * 第一个非空的语言标签以 zh 开头 → 中文，其余 → 英文。调用方按 BB 界面语言（<html lang>）在前、浏览器语言在后传入。
 */
export function resolveLanguage(setting: unknown, hostLanguages: readonly (string | null | undefined)[]): Lang {
  if (setting === "en" || setting === "zh") return setting;
  const first = hostLanguages.find((tag): tag is string => typeof tag === "string" && tag.trim() !== "");
  return first && /^zh\b/i.test(first.trim()) ? "zh" : "en";
}

type Count = (n: number) => string;
type Text = (value: string) => string;

const en = {
  appTitle: "Worktree Lineage",
  appDescription: "A thread list laid out by where the code came from: Conversation and Branch Tree views, hover briefings, Settle and attention jumps.",

  // 顶栏
  viewGroup: "View",
  viewConversations: "Conversations",
  viewConversationsHint: "One row per thread; dispatched threads nest under the thread that started them",
  viewTree: "Branch Tree",
  viewTreeHint: "Branches drawn as a tree by where each one was cut from",
  clearHighlight: "Clear highlight",
  attentionLabel: ((n) => `Jump to the next thread that needs you (${n} total)`) as Count,
  attentionTitle: ((n) => `Jump to the next thread that needs you (${n} total). Press ] / [ to cycle; inside a text field use Alt/Option + ] / [`) as Count,
  filter: "Filter",
  filterTitle: "Filter threads, branches and projects (/)",
  filterPlaceholder: "Filter threads, branches, projects",
  clearFilter: "Clear filter",
  rescan: "Re-read Git",
  rescanning: "Reading Git…",

  // 搜索
  groupTitleOrBranch: "Title or branch",
  groupMentioned: "Mentioned in messages",
  groupArchived: "Archived",
  searchingMessages: "Searching messages…",
  noMatches: "No matching threads",
  untitled: "(untitled)",

  // 分区与项目
  pinned: "Pinned",
  readingGit: "Reading Git…",
  gitFailed: "Couldn't read Git",
  newThread: "New thread",
  newThreadIn: ((name) => `New thread in ${name}`) as Text,

  // 分支
  detachedHead: "Detached HEAD",
  nodeWorktree: ((path) => `Worktree: ${path}`) as Text,
  nodeNoWorktree: "No worktree (just a fork point)",
  nodeVia: ((path) => `Path: ${path}`) as Text,
  nodeSource: ((label) => `Origin from: ${label}`) as Text,
  nodeAhead: ((n) => (n === 1 ? "1 commit ahead of its origin" : `${n} commits ahead of its origin`)) as Count,
  nodeExternal: "Created outside BB",
  sourceRecorded: "BB record",
  sourceReflog: "Git branch-creation record",
  sourceReflogCommit: "Git branch-creation record (matched by commit)",
  sourceUnknown: "Unknown",
  tagMain: "Main checkout",
  tagMerged: "Merged",
  tagNoWorktree: "No worktree",
  tagOutside: "Outside BB",
  startHere: "New thread in this worktree",
  startHereUnregistered: "New thread (path copied: choose an existing worktree and paste it)",
  copyCleanup: "Copy safe cleanup command",
  copyCleanupTitle: ((command) => `Copy safe cleanup command (nothing is deleted automatically):\n${command}`) as Text,
  copiedCleanup: ((command) => `Copied: ${command}`) as Text,
  foldBranchesOpen: "Collapse branches cut from here",
  foldBranchesClosed: ((n) => (n === 1 ? "Expand 1 thread on branches cut from here" : `Expand ${n} threads on branches cut from here`)) as Count,
  footMerged: ((n) => `Merged ${n}`) as Count,
  footIdle: ((n) => `Idle worktrees ${n}`) as Count,

  // 对话行
  footSettled: ((n) => `Settled ${n}`) as Count,
  settle: "Settle",
  settleTitle: "Settle (move to Settled; doesn't archive or delete the environment)",
  unsettle: "Unsettle",
  unsettleTitle: "Unsettle (back to the main list)",
  settleDetail: "Move to Settled; nothing is archived",
  unsettleDetail: "Back to the main list",
  moreActions: "More actions",
  regenerateTitle: "Regenerate title",
  archive: "Archive",
  dispatchedFrom: ((title) => `Dispatched from: ${title}`) as Text,
  dispatchedFromOpen: ((title) => `Dispatched from: ${title} (click to open)`) as Text,
  foldChildrenOpen: ((n) => (n === 1 ? "Collapse the thread it dispatched" : `Collapse the ${n} threads it dispatched`)) as Count,
  foldChildrenClosed: ((n) => (n === 1 ? "Expand the thread it dispatched" : `Expand the ${n} threads it dispatched`)) as Count,
  highlightDispatched: ((n) => (n === 1 ? "Dispatched 1 thread; click to highlight it" : `Dispatched ${n} threads; click to highlight them`)) as Count,

  // 悬停卡片
  stageDone: "Done",
  stageDoing: "In progress",
  stageDropped: "Dropped",
  statusError: "Error",
  statusAttention: "Waiting for your reply",
  statusDraft: "Unsent draft",
  statusRunning: "Running",
  statusDone: "Done, unread",
  childError: "error",
  childAttention: "waiting",
  childRunning: "running",
  childDone: "done",
  turns: ((n) => (n === 1 ? "1 turn" : `${n} turns`)) as Count,
  dispatchedCount: ((n, parts: string[]) => (parts.length > 0 ? `Dispatched ${n} (${parts.join(", ")})` : `Dispatched ${n}`)) as (n: number, parts: string[]) => string,
  childPart: ((n, label: string) => `${n} ${label}`) as (n: number, label: string) => string,
  prOpen: "open",
  prMerged: "merged",
  prClosed: "closed",
  prDraft: "draft",
  pullRequest: ((number, state: string) => `PR #${number} ${state}`) as (number: number, state: string) => string,
  recapNow: "Now",
  recapWaiting: "Waiting on you",
  recapNext: "Next",
  recapAskSince: "You asked since",
  recapAsk: "You asked",
  recapReply: "Reply",
  recapProgress: "Progress",
  uncommitted: ((n) => `${n} uncommitted`) as Count,
  behindByAsks: ((n) => (n === 1 ? "The stages above were written 1 turn ago and update after this turn" : `The stages above were written ${n} turns ago and update after this turn`)) as Count,
  behindLatestReply: "The stages above predate the latest reply and update after this turn",
  branchFrom: ((parent) => ` from ${parent}`) as Text,

  // 相对时间
  timeNow: "now",
  timeMinutes: ((n) => `${n}m`) as Count,
  timeHours: ((n) => `${n}h`) as Count,
  timeDays: ((n) => `${n}d`) as Count,
  timeWeeks: ((n) => `${n}w`) as Count,
  ago: ((time) => `${time} ago`) as Text,

  // 设置页
  settingsTitle: "Status and quick actions",
  settingsDescription: "Live briefing status, plus one-tap switches for the same settings as above and for threads settled on this device.",
  setLanguage: "Language",
  setLanguageHint: "Applies right away to the list and to briefings written from now on.",
  languageAuto: "Auto (follow BB)",
  setBriefings: "Hover briefings",
  setBriefingsHint: "Written in the background after each turn. Hovering only reads saved briefings and never calls a model.",
  setBriefingsSwitch: "Write briefings",
  setOn: "On",
  setOff: "Off",
  setToday: ((n, limit: number) => `${n} of ${limit} today`) as (n: number, limit: number) => string,
  setRoute: "Route",
  routeGateway: ((models) => `Gateway: ${models}, then local Claude`) as Text,
  routeClaudeOnly: ((model) => `Local Claude only (${model})`) as Text,
  setBriefingLanguage: "Briefing language",
  briefingLanguageEn: "English",
  briefingLanguageZh: "Chinese",
  setLast: "Last briefing",
  lastGateway: ((model, when: string) => `Gateway · ${model} · ${when}`) as (model: string, when: string) => string,
  lastClaude: ((model, when: string) => `Local Claude · ${model} · ${when}`) as (model: string, when: string) => string,
  lastFailed: ((when) => `Failed · ${when}`) as Text,
  lastNone: "None since the plugin started",
  setCooling: "Cooling down",
  coolingGateway: "Gateway unreachable",
  coolingLeft: ((time) => `${time} left`) as Text,
  setQueue: ((n) => (n === 1 ? "1 queued" : `${n} queued`)) as Count,
  setRetry: ((n) => (n === 1 ? "1 waiting to retry" : `${n} waiting to retry`)) as Count,
  setPaused: "Paused after repeated failures",
  setLimitReached: "Daily limit reached; resumes tomorrow (UTC)",
  setReset: "Clear cooldowns and retry",
  setSettled: "Settled threads",
  setSettledHint: "Kept only in this browser. Settling never archives a thread or touches its environment.",
  settledCount: ((n) => (n === 1 ? "1 thread settled on this device" : `${n} threads settled on this device`)) as Count,
  settledNone: "No threads settled on this device",
  unsettleAll: "Unsettle all",
  setLoading: "Loading…",
  setLoadFailed: "Couldn't load the plugin status",
  setSaveFailed: "Couldn't save the setting",
};

export type Messages = typeof en;

const zh: Messages = {
  appTitle: "工作树血缘",
  appDescription: "按“代码从哪来”排列的对话列表：对话与分支树两种视图、悬停速览、搁置与待办快跳。",

  viewGroup: "排列方式",
  viewConversations: "对话",
  viewConversationsHint: "一条对话一行；被派出的对话缩进排在派它的对话下面",
  viewTree: "分支树",
  viewTreeHint: "按分支从哪切出来画成一棵树",
  clearHighlight: "取消高亮",
  attentionLabel: (n) => `跳到下一个需要你的对话（共 ${n} 条）`,
  attentionTitle: (n) => `跳到下一个需要你的对话（共 ${n} 条）；按 ] / [ 循环切换，在输入框里用 Alt/Option + ] / [`,
  filter: "筛选",
  filterTitle: "筛选对话、分支、项目（按 /）",
  filterPlaceholder: "筛选对话、分支、项目",
  clearFilter: "清除筛选",
  rescan: "重新读取 Git",
  rescanning: "正在读取 Git…",

  groupTitleOrBranch: "标题或分支",
  groupMentioned: "消息里提到",
  groupArchived: "已归档",
  searchingMessages: "正在搜索消息内容…",
  noMatches: "没有匹配的对话",
  untitled: "（无标题）",

  pinned: "置顶",
  readingGit: "读取 Git…",
  gitFailed: "Git 读取失败",
  newThread: "新建对话",
  newThreadIn: (name) => `在 ${name} 新建对话`,

  detachedHead: "分离 HEAD",
  nodeWorktree: (path) => `工作树：${path}`,
  nodeNoWorktree: "没有工作树（只是一个分叉点）",
  nodeVia: (path) => `来路：${path}`,
  nodeSource: (label) => `起点依据：${label}`,
  nodeAhead: (n) => `比起点多 ${n} 个提交`,
  nodeExternal: "在 BB 之外创建",
  sourceRecorded: "BB 记录",
  sourceReflog: "Git 分支创建记录",
  sourceReflogCommit: "Git 分支创建记录（按提交反查）",
  sourceUnknown: "未知",
  tagMain: "主检出",
  tagMerged: "已合回",
  tagNoWorktree: "无工作树",
  tagOutside: "外部工作树",
  startHere: "在这个工作树新建对话",
  startHereUnregistered: "新建对话（路径已复制，在环境里选择已有工作树并粘贴）",
  copyCleanup: "复制安全清理命令",
  copyCleanupTitle: (command) => `复制安全清理命令（不会自动删除）：\n${command}`,
  copiedCleanup: (command) => `已复制：${command}`,
  foldBranchesOpen: "收起从这里切出的分支",
  foldBranchesClosed: (n) => `展开从这里切出的 ${n} 个对话`,
  footMerged: (n) => `已合回 ${n}`,
  footIdle: (n) => `空闲工作树 ${n}`,

  footSettled: (n) => `已搁置 ${n}`,
  settle: "搁置",
  settleTitle: "搁置（收进“已搁置”，不归档、不删环境）",
  unsettle: "取消搁置",
  unsettleTitle: "取消搁置（移回主列表）",
  settleDetail: "收进“已搁置”，不归档",
  unsettleDetail: "移回主列表",
  moreActions: "更多操作",
  regenerateTitle: "重新生成标题",
  archive: "归档",
  dispatchedFrom: (title) => `派自：${title}`,
  dispatchedFromOpen: (title) => `派自：${title}（点击打开）`,
  foldChildrenOpen: (n) => `收起它派出的 ${n} 个对话`,
  foldChildrenClosed: (n) => `展开它派出的 ${n} 个对话`,
  highlightDispatched: (n) => `派出了 ${n} 个对话，点击高亮它们`,

  stageDone: "已完成",
  stageDoing: "进行中",
  stageDropped: "已放弃",
  statusError: "出错",
  statusAttention: "等你回复",
  statusDraft: "有没发出去的草稿",
  statusRunning: "进行中",
  statusDone: "已完成，未读",
  childError: "出错",
  childAttention: "等你回复",
  childRunning: "进行中",
  childDone: "完成未读",
  turns: (n) => `${n} 轮`,
  dispatchedCount: (n, parts) => (parts.length > 0 ? `派出 ${n}（${parts.join("、")}）` : `派出 ${n}`),
  childPart: (n, label) => `${n} ${label}`,
  prOpen: "进行中",
  prMerged: "已合并",
  prClosed: "已关闭",
  prDraft: "草稿",
  pullRequest: (number, state) => `拉取请求 #${number} ${state}`,
  recapNow: "现在",
  recapWaiting: "等你",
  recapNext: "下一步",
  recapAskSince: "之后你问",
  recapAsk: "你问",
  recapReply: "答复",
  recapProgress: "进展",
  uncommitted: (n) => `${n} 个未提交`,
  behindByAsks: (n) => `上面的阶段写于 ${n} 轮之前，这一轮结束后更新`,
  behindLatestReply: "上面的阶段写于最新答复之前，这一轮结束后更新",
  branchFrom: (parent) => `，切自 ${parent}`,

  timeNow: "刚刚",
  timeMinutes: (n) => `${n}分钟`,
  timeHours: (n) => `${n}小时`,
  timeDays: (n) => `${n}天`,
  timeWeeks: (n) => `${n}周`,
  ago: (time) => `${time}前`,

  settingsTitle: "状态与快捷操作",
  settingsDescription: "速览的实时状态；上面几项设置与本机搁置记录的一键开关。",
  setLanguage: "界面语言",
  setLanguageHint: "立即作用于列表和之后写的速览。",
  languageAuto: "自动（跟随 BB）",
  setBriefings: "悬停速览",
  setBriefingsHint: "每轮对话结束后在后台写好；悬停只读存好的速览，从不调用模型。",
  setBriefingsSwitch: "写速览",
  setOn: "开",
  setOff: "关",
  setToday: (n, limit) => `今天 ${n} / ${limit}`,
  setRoute: "通道",
  routeGateway: (models) => `网关：${models}，不行再用本机 Claude`,
  routeClaudeOnly: (model) => `只用本机 Claude（${model}）`,
  setBriefingLanguage: "速览语言",
  briefingLanguageEn: "英文",
  briefingLanguageZh: "中文",
  setLast: "最近一条",
  lastGateway: (model, when) => `网关 · ${model} · ${when}`,
  lastClaude: (model, when) => `本机 Claude · ${model} · ${when}`,
  lastFailed: (when) => `失败 · ${when}`,
  lastNone: "插件启动后还没写过",
  setCooling: "冷却中",
  coolingGateway: "网关连不上",
  coolingLeft: (time) => `还剩 ${time}`,
  setQueue: (n) => `排队 ${n} 条`,
  setRetry: (n) => `${n} 条等待重试`,
  setPaused: "连续失败，已暂停",
  setLimitReached: "今天的次数已用完，明天（按协调世界时）恢复",
  setReset: "清除冷却并重试",
  setSettled: "已搁置的对话",
  setSettledHint: "只记在这个浏览器里；搁置从不归档对话，也不碰它的环境。",
  settledCount: (n) => `本机已搁置 ${n} 条`,
  settledNone: "本机没有已搁置的对话",
  unsettleAll: "全部取消搁置",
  setLoading: "读取中…",
  setLoadFailed: "读取插件状态失败",
  setSaveFailed: "设置保存失败",
};

export const MESSAGES: Record<Lang, Messages> = { en, zh };

/** 相对时间，尽量短：now / 5m / 3h / 2d / 3w；刚刚 / 5分钟 / 3小时 / 2天 / 3周（两周以上按周） */
export function relativeTime(at: number, now: number, lang: Lang): string {
  const t = MESSAGES[lang];
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return t.timeNow;
  if (minutes < 60) return t.timeMinutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t.timeHours(hours);
  const days = Math.floor(hours / 24);
  return days < 14 ? t.timeDays(days) : t.timeWeeks(Math.floor(days / 7));
}

/** 多久以前：5m ago / 5分钟前；不到一分钟直接写 now / 刚刚 */
export function agoText(at: number, now: number, lang: Lang): string {
  const time = relativeTime(at, now, lang);
  return now - at < 60_000 ? time : MESSAGES[lang].ago(time);
}

/**
 * 服务端设置项的标签与说明。设置页由 bb 渲染、schema 在插件启动时一次定下，不能随界面语言切换，
 * 所以固定用英文（与 BB 界面和同系列插件一致，英文 BB 的设置页里不出现汉字）；中文说明见 README.zh-CN.md。
 */
export const SETTINGS_TEXT: Record<"language" | "briefingEnabled" | "briefingGatewayUrl" | "briefingGatewayModel" | "briefingModel", { label: string; description: string }> = {
  language: {
    label: "Language",
    description: "Interface and briefing language. Auto follows the BB interface language (Chinese when BB is in Chinese, English otherwise); pick zh to use Chinese in an English BB.",
  },
  briefingEnabled: {
    label: "Write progress briefings with a small model",
    description: "After each turn, a small model reads the whole conversation digest in the background and writes a staged briefing for the hover card. It tries the gateway models below in order, then the local Claude. Off: the card shows only the zero-cost recap.",
  },
  briefingGatewayUrl: {
    label: "Preferred model gateway",
    description: "Address of an OpenAI-compatible gateway (a local Magpie by default). If it can't be reached, the local Claude is used and the gateway is retried after a minute. The conversation digest is sent to the provider behind the gateway. Leave empty to use only the local Claude.",
  },
  briefingGatewayModel: {
    label: "Gateway models (in order)",
    description: "Model ids from the gateway's /v1/models, comma separated and tried in order (one is fine). A model that times out, errors or writes invalid output is skipped; a 429 cools that model down per Retry-After (15 min if missing, at most 25 min).",
  },
  briefingModel: {
    label: "Fallback Claude model",
    description: "Name passed to the local claude --model when every gateway model fails.",
  },
};
