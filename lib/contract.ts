/**
 * [INPUT]: 依赖 @get-bb/plugin-sdk 的 defineRpcContract 与 zod
 * [OUTPUT]: 对外提供 hostContract（host 端契约: scanLineage 读 git、writeBriefing 按 route 调网关或本机 claude，失败可带冷却建议）、modelRouteSchema / ModelRoute（gateway | claude 两条通道）、serverContract（app↔server 契约: lineage、briefing、settingsStatus / updateSettings / resetBriefingCooldowns（设置页）、briefingConfig / setBriefingConfig / regenerateBriefing（给 session-cockpit 的跨插件契约）、reportLanguage）、settingsStatusSchema / settingsValuesSchema / settingsPatchSchema / briefingConfigSchema / setBriefingConfigSchema 与 briefingConfigToPatch及血缘数据类型
 * [POS]: lib 的契约层; 消费者: host.ts、server.ts、briefings.ts、lib/model-run.ts、app.tsx、components/peek.tsx、lib/lineage.ts; 只定义数据形状，不含逻辑; serverContract.briefing 的输出另被 session-cockpit 插件跨插件读取，字段不可随意改
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { storedBriefingSchema } from "./briefing";
import { LANGUAGE_SETTINGS } from "./i18n";
import { DAILY_LIMIT, DEFAULT_VIEWS, PEEK_DELAY, PROMPT_MAX_LENGTH } from "./prefs";

/**
 * 分支的起点从哪来，按可信度从高到低：
 * - recorded:      bb 建 worktree 时记录的起点（environment.mergeBaseBranch / 选择器输入）
 * - reflog:        git 分支创建记录里直接写了分支名（"branch: Created from <branch>"）
 * - reflog-commit: 创建记录只写了提交，按“当时哪个分支指向这个提交”反查得到
 * - unknown:       查不到；不靠提交历史推算，宁缺毋滥
 */
export const parentSourceSchema = z.enum([
  "recorded",
  "reflog",
  "reflog-commit",
  "unknown",
]);
export type ParentSource = z.infer<typeof parentSourceSchema>;

export const worktreeSchema = z.object({
  /** 绝对路径（git worktree list 给出的原样路径） */
  path: z.string(),
  /** 检出的分支短名；detached 时为 null */
  branch: z.string().nullable(),
  head: z.string().nullable(),
  /** 第一条记录 = 主检出 */
  isMain: z.boolean(),
  locked: z.boolean(),
});
export type Worktree = z.infer<typeof worktreeSchema>;

export const branchNodeSchema = z.object({
  name: z.string(),
  tip: z.string(),
  /** 分支创建时间（unix 秒），取自 reflog 第一条；没有 reflog 时为 null */
  createdAt: z.number().nullable(),
  /** 最后提交时间（unix 秒） */
  committedAt: z.number().nullable(),
  /** 起点分支短名；根或查不到时为 null */
  parent: z.string().nullable(),
  parentSource: parentSourceSchema,
  /** 本分支的 tip 已是 parent tip 的祖先（且两者不同）= 已合回上游；parent 为 null 时为 false */
  mergedIntoParent: z.boolean(),
  /** 相对 parent 的领先提交数（merge-base..tip）；parent 为 null 时为 null */
  aheadOfParent: z.number().nullable(),
  /** 检出该分支的 worktree 路径；没有 worktree 时为 null */
  worktreePath: z.string().nullable(),
});
export type BranchNode = z.infer<typeof branchNodeSchema>;

export const repoScanSchema = z.object({
  sourcePath: z.string(),
  /** git common dir 的真实路径，作为仓库身份 */
  commonDir: z.string(),
  defaultBranch: z.string().nullable(),
  worktrees: z.array(worktreeSchema),
  /**
   * 只包含“相关”分支：有 worktree 的分支、默认分支、以及把它们连到根所需的祖先分支。
   * 其余本地分支不返回，避免几十个无关分支把树撑爆。
   */
  branches: z.array(branchNodeSchema),
  scannedAt: z.number(),
});
export type RepoScan = z.infer<typeof repoScanSchema>;

export const scanInputSchema = z.object({
  sourcePath: z.string().min(1),
  /** bb 记录的起点：分支短名 → 起点 ref（可能是 "origin/main"、"main"、"default"） */
  recordedBases: z.record(z.string(), z.string()),
  /** 额外视为相关的分支（例如 bb 环境里检出、但 worktree list 暂时看不到的） */
  extraBranches: z.array(z.string()).default([]),
});
export type ScanInput = z.infer<typeof scanInputSchema>;

/**
 * 一次模型调用走哪条通道（都在持有对话的那台机器上）：
 * - gateway: 纯 HTTP 发给 OpenAI 兼容网关（如本机 Magpie）的 /v1/chat/completions
 * - claude:  一次性启动本机的 `claude -p`
 */
export const modelRouteSchema = z.discriminatedUnion("via", [
  z.object({ via: z.literal("gateway"), baseUrl: z.string().min(1), model: z.string().min(1) }),
  z.object({ via: z.literal("claude"), model: z.string().min(1) }),
]);
export type ModelRoute = z.infer<typeof modelRouteSchema>;

export const hostContract = defineRpcContract({
  scanLineage: {
    input: scanInputSchema,
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ok"), scan: repoScanSchema }),
      z.object({ status: z.literal("not-git"), message: z.string() }),
      z.object({ status: z.literal("failed"), message: z.string() }),
    ]),
  },
  /** 把一段提示词交给这台机器上的模型，一问一答，拿回文字；走哪条通道由 route 指定，回退由服务端决定 */
  writeBriefing: {
    input: z.object({ system: z.string().min(1), prompt: z.string().min(1), route: modelRouteSchema }),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ok"), text: z.string(), costUsd: z.number().nullable(), durationMs: z.number() }),
      z.object({
        status: z.literal("failed"),
        message: z.string(),
        /** 建议暂停多久：model = 只停这个网关模型（429 + Retry-After），gateway = 整个网关连不上 */
        cooldown: z.object({ scope: z.enum(["model", "gateway"]), ms: z.number() }).optional(),
      }),
    ]),
  },
});

export const projectLineageSchema = z.object({
  projectId: z.string(),
  hostId: z.string(),
  sourcePath: z.string(),
  result: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), scan: repoScanSchema }),
    z.object({ status: z.literal("not-git"), message: z.string() }),
    z.object({ status: z.literal("failed"), message: z.string() }),
    z.object({ status: z.literal("host-unavailable"), message: z.string() }),
  ]),
  /** bb 已登记的环境（用来区分“外部 worktree”，以及在某个 worktree 里开新对话） */
  environments: z.array(z.object({ id: z.string(), path: z.string(), base: z.string().nullable() })),
});
export type ProjectLineage = z.infer<typeof projectLineageSchema>;

/** 卡片 / 面板显示一条对话的进展所需的全部内容，一次取回 */
export const briefingViewSchema = z.object({
  briefing: storedBriefingSchema.nullable(),
  /** 相对当前对话，存盘的速览是否落后；没有速览时为 null */
  freshness: z
    .discriminatedUnion("state", [
      z.object({ state: z.literal("fresh") }),
      z.object({ state: z.literal("behind"), newAsks: z.number() }),
    ])
    .nullable(),
  /** 不花 token 的兜底摘要：一共几轮、最近一次要求、它之后的答复开头 */
  recap: z.object({ turns: z.number(), ask: z.string().nullable(), reply: z.string().nullable() }),
  /** 用户在插件设置里关掉了速览 */
  enabled: z.boolean(),
});
export type BriefingView = z.infer<typeof briefingViewSchema>;

/** regenerateBriefing 的结果（对外契约，session-cockpit 按 status 显示原因） */
export const regenerateResultSchema = z.object({
  ok: z.boolean(),
  status: z.enum(["written", "disabled", "empty", "unavailable", "limit", "failed", "skipped"]),
  briefing: storedBriefingSchema.nullable(),
  error: z.string().optional(),
});
export type RegenerateResultView = z.infer<typeof regenerateResultSchema>;

/** 插件全部设置项的当前值（经 lib/prefs 的 normalizeSettings 收紧后） */
export const settingsValuesSchema = z.object({
  language: z.enum(LANGUAGE_SETTINGS),
  briefingEnabled: z.boolean(),
  briefingLanguage: z.enum(LANGUAGE_SETTINGS),
  briefingGatewayUrl: z.string(),
  briefingGatewayModel: z.string(),
  briefingModel: z.string(),
  briefingSystemPrompt: z.string(),
  briefingDailyLimit: z.number(),
  peekEnabled: z.boolean(),
  peekDelayMs: z.number(),
  defaultView: z.enum(DEFAULT_VIEWS),
});

const dailyLimitInput = z.number().int().min(DAILY_LIMIT.min).max(DAILY_LIMIT.max);
const promptInput = z.string().max(PROMPT_MAX_LENGTH);
const textInput = z.string().max(2000);

/** 设置页一次改几项：都可省略；数字与长度在这里校验，越界直接拒绝 */
export const settingsPatchSchema = z.object({
  language: z.enum(LANGUAGE_SETTINGS).optional(),
  briefingEnabled: z.boolean().optional(),
  briefingLanguage: z.enum(LANGUAGE_SETTINGS).optional(),
  briefingGatewayUrl: textInput.optional(),
  briefingGatewayModel: textInput.optional(),
  briefingModel: z.string().trim().min(1).max(200).optional(),
  briefingSystemPrompt: promptInput.optional(),
  briefingDailyLimit: dailyLimitInput.optional(),
  peekEnabled: z.boolean().optional(),
  peekDelayMs: z.number().int().min(PEEK_DELAY.min).max(PEEK_DELAY.max).optional(),
  defaultView: z.enum(DEFAULT_VIEWS).optional(),
  /** 一次性动作：清零今天的计数、清网关与重试冷却 */
  resetTodayCount: z.boolean().optional(),
  clearCooldowns: z.boolean().optional(),
});
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/**
 * 给 session-cockpit 等别的插件读写速览配置（按插件 id "worktree-lineage" 调用）。字段名与含义是对外契约，改了要通知对方。
 * resolvedLanguage 是速览实际用的语言（auto 时跟随界面语言）。
 */
export const briefingConfigSchema = z.object({
  enabled: z.boolean(),
  language: z.enum(LANGUAGE_SETTINGS),
  gatewayUrl: z.string(),
  gatewayModel: z.string(),
  fallbackModel: z.string(),
  systemPrompt: z.string(),
  defaultSystemPromptEn: z.string(),
  defaultSystemPromptZh: z.string(),
  dailyLimit: z.number(),
  todayCount: z.number(),
  resolvedLanguage: z.enum(["en", "zh"]),
});
export type BriefingConfig = z.infer<typeof briefingConfigSchema>;

export const setBriefingConfigSchema = z.object({
  enabled: z.boolean().optional(),
  language: z.enum(LANGUAGE_SETTINGS).optional(),
  gatewayUrl: textInput.optional(),
  gatewayModel: textInput.optional(),
  fallbackModel: z.string().trim().min(1).max(200).optional(),
  systemPrompt: promptInput.optional(),
  dailyLimit: dailyLimitInput.optional(),
  resetTodayCount: z.boolean().optional(),
  clearCooldowns: z.boolean().optional(),
});
export type SetBriefingConfig = z.infer<typeof setBriefingConfigSchema>;

/** setBriefingConfig 的字段 → 设置页补丁（两套名字指向同一份 bb.settings） */
export function briefingConfigToPatch(input: SetBriefingConfig): SettingsPatch {
  const patch: SettingsPatch = {};
  if (input.enabled !== undefined) patch.briefingEnabled = input.enabled;
  if (input.language !== undefined) patch.briefingLanguage = input.language;
  if (input.gatewayUrl !== undefined) patch.briefingGatewayUrl = input.gatewayUrl;
  if (input.gatewayModel !== undefined) patch.briefingGatewayModel = input.gatewayModel;
  if (input.fallbackModel !== undefined) patch.briefingModel = input.fallbackModel;
  if (input.systemPrompt !== undefined) patch.briefingSystemPrompt = input.systemPrompt;
  if (input.dailyLimit !== undefined) patch.briefingDailyLimit = input.dailyLimit;
  if (input.resetTodayCount !== undefined) patch.resetTodayCount = input.resetTodayCount;
  if (input.clearCooldowns !== undefined) patch.clearCooldowns = input.clearCooldowns;
  return patch;
}

/** 设置页的插件状态快照 */
export const settingsStatusSchema = z.object({
  values: settingsValuesSchema,
  /** 内置提示词（设置页“填入默认”用） */
  defaultPrompts: z.object({ en: z.string(), zh: z.string() }),
  language: z.enum(LANGUAGE_SETTINGS),
  /** 速览实际用的语言（auto 时是前端报上来的界面语言） */
  briefingLanguage: z.enum(["en", "zh"]),
  briefingEnabled: z.boolean(),
  gateway: z.object({ baseUrl: z.string(), models: z.array(z.string()) }).nullable(),
  claudeModel: z.string(),
  briefing: z.object({
    spentToday: z.number(),
    dailyLimit: z.number(),
    queued: z.number(),
    working: z.boolean(),
    /** model 为 null 表示整个网关连不上 */
    cooldowns: z.array(z.object({ model: z.string().nullable(), until: z.number() })),
    retryWaiting: z.number(),
    pausedAt: z.number().nullable(),
    last: z
      .discriminatedUnion("status", [
        z.object({ status: z.literal("ok"), via: z.enum(["gateway", "claude"]), model: z.string(), at: z.number() }),
        z.object({ status: z.literal("failed"), at: z.number() }),
      ])
      .nullable(),
  }),
});
export type SettingsStatus = z.infer<typeof settingsStatusSchema>;

export const serverContract = defineRpcContract({
  lineage: {
    input: z.object({ refresh: z.boolean().default(false) }),
    output: z.object({
      projects: z.array(projectLineageSchema),
      generatedAt: z.number(),
    }),
  },
  /**
   * 读一条对话存盘的速览，连同“它是否落后”的结论和不花 token 的兜底摘要。
   * 只读，不触发生成（生成只在一轮对话结束时由服务端发起）。别的插件也可以按插件 id 调用它。
   */
  briefing: {
    input: z.object({ threadId: z.string().min(1) }),
    output: briefingViewSchema,
  },
  /** 设置页读一次插件状态：两项可在设置页直接改的设置 + 速览的运行状态（只读，不触发生成） */
  settingsStatus: {
    input: z.object({}),
    output: settingsStatusSchema,
  },
  /** 设置页改设置：写进 bb.settings（与声明式设置、bb plugin config 同一份），返回最新状态 */
  updateSettings: {
    input: settingsPatchSchema,
    output: settingsStatusSchema,
  },
  /** 别的插件（session-cockpit）读速览配置；只读 */
  briefingConfig: {
    input: z.object({}).optional(),
    output: briefingConfigSchema,
  },
  /** 别的插件改速览配置：写进同一份 bb.settings，或执行清零 / 清冷却；返回最新配置 */
  setBriefingConfig: {
    input: setBriefingConfigSchema,
    output: briefingConfigSchema,
  },
  /** 设置页手动恢复：清网关冷却与失败重试的冷却，然后补写一遍；返回最新状态 */
  resetBriefingCooldowns: {
    input: z.object({}),
    output: settingsStatusSchema,
  },
  /**
   * 手动重新生成一条对话的速览（悬停卡片与 session-cockpit 的 Progress 都可以调用）：不看是否已是新的，立即按当前配置重写。
   * status 说明结果，调用方据此按自己的语言提示：written / disabled / empty / unavailable / limit / failed（error 是英文原因，只供日志）。
   */
  regenerateBriefing: {
    input: z.object({ threadId: z.string().min(1) }),
    output: regenerateResultSchema,
  },
  /** 前端报告它解析出的界面语言（设置为 auto 时由浏览器语言决定）；服务端据此决定 auto 模式下速览用哪种语言 */
  reportLanguage: {
    input: z.object({ language: z.enum(["en", "zh"]) }),
    output: z.object({ ok: z.literal(true) }),
  },
});
