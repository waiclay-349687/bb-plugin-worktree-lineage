/**
 * [INPUT]: 依赖 @get-bb/plugin-sdk 的 defineRpcContract 与 zod
 * [OUTPUT]: 对外提供 hostContract（host 端契约: scanLineage 读 git、writeBriefing 调本机小模型）、serverContract（app↔server 契约: lineage、briefing）及血缘数据类型
 * [POS]: lib 的契约层; 消费者: host.ts、server.ts、briefings.ts、app.tsx、components/peek.tsx、lib/lineage.ts; 只定义数据形状，不含逻辑
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { storedBriefingSchema } from "./briefing";

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

export const hostContract = defineRpcContract({
  scanLineage: {
    input: scanInputSchema,
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ok"), scan: repoScanSchema }),
      z.object({ status: z.literal("not-git"), message: z.string() }),
      z.object({ status: z.literal("failed"), message: z.string() }),
    ]),
  },
  /** 把一段提示词交给这台机器上的小模型，一问一答，拿回文字 */
  writeBriefing: {
    input: z.object({ system: z.string().min(1), prompt: z.string().min(1), model: z.string().min(1) }),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ok"), text: z.string(), costUsd: z.number().nullable(), durationMs: z.number() }),
      z.object({ status: z.literal("failed"), message: z.string() }),
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
});
