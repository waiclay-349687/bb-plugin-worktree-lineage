/**
 * [INPUT]: 依赖 bb.sdk.projects / bb.sdk.environments 读取项目源与 bb 记录的起点分支; 依赖 host.ts 的 scanLineage 在各机器上读 git、writeBriefing 调网关或本机 claude; 依赖 briefings.ts 的速览调度; 依赖 bb.settings 的五项设置（界面语言 language，速览的开关、网关地址、网关上按顺序尝试的模型列表、兜底的 claude 模型）; 依赖 lib/i18n 的设置项英文文案; 依赖 bb.storage.kv 记住前端报上来的界面语言
 * [OUTPUT]: 对外提供 serverContract.lineage RPC（每个项目的分支血缘扫描结果 + bb 已登记环境路径）、serverContract.briefing RPC（读一条对话存盘的速览）与 serverContract.reportLanguage RPC（前端报告解析出的界面语言，auto 模式下决定速览语言、设置页标签固定英文）; 默认导出插件工厂
 * [POS]: 插件服务端汇总层; 消费者: app.tsx、components/peek.tsx; 与 host.ts 的边界: 本文件不执行命令，只负责收集 bb 侧事实、调度 host、缓存; 与 briefings.ts 的边界: 速览何时写、写哪条都在 briefings，这里只接线
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createBriefingService, parseModelList, type BriefingSettings } from "./briefings";
import { LANGUAGE_OPTION_LABELS, LANGUAGE_SETTINGS, SETTINGS_TEXT, type Lang } from "./lib/i18n";
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
/** 前端最近一次报上来的界面语言（en / zh） */
const UI_LANGUAGE_KEY = "ui-language";
/** auto 模式下界面语言变了：稳定这么久才按新语言补写速览，且这段冷却内最多补写一次 */
const LANGUAGE_SETTLE_MS = 60_000;
const LANGUAGE_BACKFILL_COOLDOWN_MS = 30 * 60_000;

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
  // 前端上次报上来的界面语言（auto 模式下决定速览用哪种语言）；还没报过就按英文
  let uiLanguage: Lang = (await bb.storage.kv.get<Lang>(UI_LANGUAGE_KEY).catch(() => undefined)) === "zh" ? "zh" : "en";
  // 设置页由 bb 渲染、schema 启动时一次定下，不能随语言切换：标签固定英文
  const text = SETTINGS_TEXT;
  // 速览走用户的模型额度，所以给一个随时能关的开关
  const settings = bb.settings.define({
    language: {
      type: "select",
      ...text.language,
      options: [...LANGUAGE_SETTINGS],
      experimental_optionLabels: LANGUAGE_OPTION_LABELS,
      default: "auto",
    },
    briefingEnabled: { type: "boolean", ...text.briefingEnabled, default: true },
    briefingGatewayUrl: { type: "string", ...text.briefingGatewayUrl, default: DEFAULT_GATEWAY_URL },
    briefingGatewayModel: { type: "string", ...text.briefingGatewayModel, default: DEFAULT_GATEWAY_MODELS.join(", ") },
    briefingModel: { type: "string", ...text.briefingModel, default: DEFAULT_CLAUDE_MODEL },
  });
  /** 速览实际用的语言：设置为 en / zh 时直接用；auto 时只有前端知道浏览器语言，用它报上来的值 */
  const briefingLanguageOf = (setting: string): Lang => (setting === "en" || setting === "zh" ? setting : uiLanguage);
  const briefingSettings = async (): Promise<BriefingSettings> => {
    const values = await settings.get();
    const gatewayUrl = values.briefingGatewayUrl.trim();
    return {
      enabled: values.briefingEnabled,
      language: briefingLanguageOf(values.language),
      model: values.briefingModel.trim() || DEFAULT_CLAUDE_MODEL,
      gateway: gatewayUrl ? { baseUrl: gatewayUrl, models: parseModelList(values.briefingGatewayModel, DEFAULT_GATEWAY_MODELS) } : null,
    };
  };
  const briefings = createBriefingService(
    bb,
    (hostId, input, timeoutMs) => host.call("writeBriefing", input, { hostId, timeoutMs }),
    briefingSettings,
  );
  // 刚打开开关、或者速览语言变了：补写一遍（补写有条数上限，旧语言的速览在此之前不显示）
  settings.onChange((next, prev) => {
    const languageChanged = briefingLanguageOf(next.language) !== briefingLanguageOf(prev.language);
    if ((next.briefingEnabled && !prev.briefingEnabled) || (next.briefingEnabled && languageChanged)) void briefings.backfill().catch(() => undefined);
  });
  /**
   * 前端解析出的界面语言（auto 时由浏览器语言决定），正在用的窗口说了算（前端在挂载与窗口获得焦点时报告）。
   * 记下来；auto 模式下新语言稳定 1 分钟后补写一次（30 分钟内最多一次，几个语言不同的窗口来回切换时不会反复补写）。
   */
  let languageTimer: ReturnType<typeof setTimeout> | undefined;
  let lastLanguageBackfill = 0;
  bb.onDispose(() => clearTimeout(languageTimer));
  async function reportLanguage(language: Lang): Promise<{ ok: true }> {
    if (language === uiLanguage) return { ok: true };
    uiLanguage = language;
    await bb.storage.kv.set(UI_LANGUAGE_KEY, language);
    // auto 模式下速览随之换语言：新语言稳定 1 分钟后补写一次（旧语言的速览在此之前不显示）；
    // 30 分钟内最多一次，开着几个语言不同的窗口来回切换时不会反复补写
    clearTimeout(languageTimer);
    languageTimer = setTimeout(() => {
      void (async () => {
        const values = await settings.get();
        if (uiLanguage !== language || !values.briefingEnabled || values.language !== "auto") return;
        if (Date.now() - lastLanguageBackfill < LANGUAGE_BACKFILL_COOLDOWN_MS) return;
        lastLanguageBackfill = Date.now();
        await briefings.backfill();
      })().catch(() => undefined);
    }, LANGUAGE_SETTLE_MS);
    return { ok: true };
  }

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
    reportLanguage: ({ language }) => reportLanguage(language),
  });
}
