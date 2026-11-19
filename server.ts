/**
 * [INPUT]: 依赖 bb.sdk.projects / bb.sdk.environments 读取项目源与 bb 记录的起点分支; 依赖 host.ts 的 scanLineage 在各机器上读 git、writeBriefing 调网关或本机 claude; 依赖 briefings.ts 的速览调度; 依赖 bb.settings 的四项速览设置（开关、网关地址、网关上按顺序尝试的模型列表、兜底的 claude 模型）
 * [OUTPUT]: 对外提供 serverContract.lineage RPC（每个项目的分支血缘扫描结果 + bb 已登记环境路径）与 serverContract.briefing RPC（读一条对话存盘的速览）; 默认导出插件工厂
 * [POS]: 插件服务端汇总层; 消费者: app.tsx、components/peek.tsx; 与 host.ts 的边界: 本文件不执行命令，只负责收集 bb 侧事实、调度 host、缓存; 与 briefings.ts 的边界: 速览何时写、写哪条都在 briefings，这里只接线
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createBriefingService, parseModelList, type BriefingSettings } from "./briefings";
import {
  hostContract,
  serverContract,
  type ProjectLineage,
} from "./lib/contract";

/** 扫描结果缓存时长：侧边栏轮询频繁，git 扫描不必每次都跑 */
const CACHE_TTL_MS = 15_000;
const SCAN_TIMEOUT_MS = 60_000;
/**
 * 速览的模型链（按成本优先级）：本机 Magpie 网关上的 workbuddy DeepSeek → 同网关的免费 DeepSeek（额度少）
 * → 本机 claude 兜底。付费直连的模型不进默认链。
 */
const DEFAULT_GATEWAY_URL = "http://127.0.0.1:3425";
const DEFAULT_GATEWAY_MODELS = ["workbuddy/deepseek-v4.1-flash", "opencode-zen/deepseek-v4.1-flash-free"];
const DEFAULT_CLAUDE_MODEL = "haiku";

type EnvironmentRecord = {
  id: string;
  path: string | null;
  branchName: string | null;
  isWorktree: boolean;
  mergeBaseBranch: string | null;
  environmentProviderSelection?: {
    inputs?: { branch?: { kind?: string; name?: string } } | null;
  } | null;
};

/**
 * bb 记录的起点：优先用建 worktree 时选择器的输入（最接近“从哪切出来”），
 * 其次用 mergeBaseBranch（用户可改的比较基准，可能被改过，所以排第二）。
 */
function recordedBaseOf(env: EnvironmentRecord): string | null {
  if (!env.isWorktree) return null;
  const input = env.environmentProviderSelection?.inputs?.branch;
  if (input?.kind === "named" && input.name) return input.name;
  if (input?.kind === "default") return "default";
  return env.mergeBaseBranch ?? null;
}

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  // 速览走用户的模型额度，所以给一个随时能关的开关
  const settings = bb.settings.define({
    briefingEnabled: {
      type: "boolean",
      label: "用小模型写进展速览",
      description: "每轮对话结束后，在后台让小模型读完整条对话的提要，写一份分阶段的速览，显示在悬停卡片上。先按顺序试下面网关上的模型，都不行再用本机的 Claude。关闭后卡片只显示不花额度的摘要。",
      default: true,
    },
    briefingGatewayUrl: {
      type: "string",
      label: "优先使用的模型网关",
      description: `OpenAI 兼容网关的地址（默认本机 Magpie ${DEFAULT_GATEWAY_URL}）。网关连不上时冷却 1 分钟、期间直接用本机 Claude。注意：对话提要会发给网关背后的模型服务商。留空则只用本机 Claude。`,
      default: DEFAULT_GATEWAY_URL,
    },
    briefingGatewayModel: {
      type: "string",
      label: "网关上的模型（按顺序）",
      description: `网关 /v1/models 列出的模型 id，逗号分隔、按顺序尝试（只写一个也行）：某个模型超时、出错或写得不合格就试下一个，全都不行再用本机 Claude；返回 429 的模型按 Retry-After 冷却（缺省 15 分钟，最多 2 小时），冷却期内跳过。默认 ${DEFAULT_GATEWAY_MODELS.join(", ")}。`,
      default: DEFAULT_GATEWAY_MODELS.join(", "),
    },
    briefingModel: {
      type: "string",
      label: "兜底用的 Claude 模型",
      description: `网关上的模型都不可用时传给本机 claude --model 的名字，默认 ${DEFAULT_CLAUDE_MODEL}。`,
      default: DEFAULT_CLAUDE_MODEL,
    },
  });
  const briefingSettings = async (): Promise<BriefingSettings> => {
    const values = await settings.get();
    const gatewayUrl = values.briefingGatewayUrl.trim();
    return {
      enabled: values.briefingEnabled,
      model: values.briefingModel.trim() || DEFAULT_CLAUDE_MODEL,
      gateway: gatewayUrl ? { baseUrl: gatewayUrl, models: parseModelList(values.briefingGatewayModel, DEFAULT_GATEWAY_MODELS) } : null,
    };
  };
  const briefings = createBriefingService(
    bb,
    (hostId, input, timeoutMs) => host.call("writeBriefing", input, { hostId, timeoutMs }),
    briefingSettings,
  );
  // 刚打开开关时补写一遍
  settings.onChange((next, prev) => {
    if (next.briefingEnabled && !prev.briefingEnabled) void briefings.backfill().catch(() => undefined);
  });

  let cache: { at: number; value: ProjectLineage[] } | null = null;
  let inflight: Promise<ProjectLineage[]> | null = null;

  async function scanProject(project: {
    id: string;
    sources?: Array<{ hostId?: string | null; path?: string | null; isDefault?: boolean }>;
  }): Promise<ProjectLineage | null> {
    const source =
      project.sources?.find((s) => s.isDefault && s.hostId && s.path) ??
      project.sources?.find((s) => s.hostId && s.path);
    if (!source?.hostId || !source.path) return null;

    const listed = (await bb.sdk.environments.list({ projectId: project.id })) as unknown;
    const environments = (Array.isArray(listed)
      ? listed
      : ((listed as { environments?: unknown[] }).environments ?? [])) as EnvironmentRecord[];

    const recordedBases: Record<string, string> = {};
    const extraBranches: string[] = [];
    for (const env of environments) {
      const base = recordedBaseOf(env);
      if (env.branchName && base) recordedBases[env.branchName] = base;
      if (env.branchName) extraBranches.push(env.branchName);
    }
    const registered = environments.flatMap((env) =>
      typeof env.path === "string" && env.path.length > 0
        ? [{ id: env.id, path: env.path, base: recordedBaseOf(env) }]
        : [],
    );

    try {
      const result = await host.call(
        "scanLineage",
        { sourcePath: source.path, recordedBases, extraBranches },
        { hostId: source.hostId, timeoutMs: SCAN_TIMEOUT_MS },
      );
      return {
        projectId: project.id,
        hostId: source.hostId,
        sourcePath: source.path,
        result,
        environments: registered,
      };
    } catch (error) {
      return {
        projectId: project.id,
        hostId: source.hostId,
        sourcePath: source.path,
        result: {
          status: "host-unavailable",
          message: error instanceof Error ? error.message : String(error),
        },
        environments: registered,
      };
    }
  }

  async function scanAll(): Promise<ProjectLineage[]> {
    const listed = (await bb.sdk.projects.list()) as unknown;
    const projects = (Array.isArray(listed)
      ? listed
      : ((listed as { projects?: unknown[] }).projects ?? [])) as Array<{
      id: string;
      kind?: string;
      sources?: Array<{ hostId?: string | null; path?: string | null; isDefault?: boolean }>;
    }>;
    const results = await Promise.all(
      projects
        .filter((p) => p.kind !== "personal")
        .map((p) =>
          scanProject(p).catch((error) => {
            bb.log.warn(`lineage scan failed for ${p.id}: ${String(error)}`);
            return null;
          }),
        ),
    );
    return results.filter((r): r is ProjectLineage => r !== null);
  }

  async function lineage(refresh: boolean): Promise<ProjectLineage[]> {
    if (!refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
    // 并发请求共享同一次扫描，避免多个窗口同时触发重复的 git 调用
    inflight ??= scanAll()
      .then((value) => {
        cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  bb.rpc.register(serverContract, {
    lineage: async ({ refresh }) => ({
      projects: await lineage(refresh),
      generatedAt: Date.now(),
    }),
    briefing: ({ threadId }) => briefings.view(threadId),
  });
}
