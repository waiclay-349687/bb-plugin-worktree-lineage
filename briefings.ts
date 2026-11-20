/**
 * [INPUT]: 依赖 bb.sdk.threads（对话大纲、列表）与 bb.sdk.environments（对话在哪台机器）、bb.events 的 thread.idle / thread.deleted、bb.storage.kv 存盘、bb.log 记录命中的通道与跳过 / 失败的网关模型、调用方注入的 callModel（经 host.ts 的 writeBriefing 调网关或本机 claude）; 依赖 lib/briefing 的提要与解析
 * [OUTPUT]: 对外提供 createBriefingService(bb, callModel, getSettings): { view(threadId), backfill(), status()（设置页的运行状态快照）, resetCooldowns()（清冷却后补写）, resetTodayCount()（清零今天的计数）, spentToday(), regenerate(threadId)（手动重新生成：不看是否已是新的，立即按当前配置重写，返回结果） }; RegenerateResult / RegenerateStatus 类型 — 在后台为每条对话写“全程速览”并存盘；view 给界面一次性取回速览、是否落后、兜底摘要（只读）; generateBriefing(callModel, hostId, request, settings, cooldowns, now): 按顺序试网关模型链（按 settings.language 校验输出）（跳过冷却中的）、全不行再兜底本机 claude 的一次生成（不依赖 bb，可单测）; parseModelList: 逗号分隔的有序模型列表; summarizeCooldowns: 冷却表 → 设置页清单; BriefingStatus 类型; CooldownTable / GatewayStep 类型
 * [POS]: 插件服务端的速览调度; 消费者: server.ts; 与 lib/briefing.ts 的边界: 这里决定“何时写、写哪条、用哪种语言写、按什么顺序走哪条通道、哪个网关模型在冷却、写完存哪”（语言和当前界面不一致的存盘速览既不显示、也算落后要重写），提示词与输出校验在 briefing; 与 host.ts 的边界: 这里不执行任何命令，回退决策在这里、执行在 host
 * [PROTOCOL]: 变更时更新此头部,然后检查项目根 CLAUDE.md
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { BRIEFING_VERSION, briefingLanguage, briefingSystemPrompt, buildDigest, promptFingerprint, countAsks, freshness, outlineKey, parseBriefing, storedBriefingSchema, type Briefing, type StoredBriefing } from "./lib/briefing";
import type { Lang } from "./lib/i18n";
import type { ModelRunResult } from "./lib/model-run";
import type { BriefingView, ModelRoute } from "./lib/contract";
import { buildRecap, type OutlineItem } from "./lib/search";

/** 按 route 把提示词交给某台机器上的模型；由 server.ts 用 host 客户端实现 */
export type CallModel = (hostId: string, input: { system: string; prompt: string; route: ModelRoute }, timeoutMs: number) => Promise<ModelRunResult>;

export interface BriefingSettings {
  enabled: boolean;
  /** 速览用哪种语言写：设置为 en / zh 时直接用，auto 时用前端报上来的界面语言 */
  language: Lang;
  /** 兜底用的本机 claude 模型 */
  model: string;
  /** 优先使用的 OpenAI 兼容网关与其上按顺序尝试的模型；null = 不走网关，直接用 claude */
  gateway: { baseUrl: string; models: string[] } | null;
  /** 自定义系统提示词；空串 = 用内置的 */
  systemPrompt: string;
  /** 每天最多写几次 */
  dailyLimit: number;
}

/** 把“逗号分隔的有序模型列表”解析成数组（兼容只写一个模型名、中文逗号与换行）；去重，空则用 fallback */
export function parseModelList(text: string, fallback: readonly string[]): string[] {
  const models = [...new Set(text.split(/[,，\n]/).map((model) => model.trim()).filter(Boolean))];
  return models.length > 0 ? models : [...fallback];
}

/** host RPC 的超时要比 host 内部的超时长：网关 fetch 45s，claude 进程 120s */
const GATEWAY_HOST_TIMEOUT_MS = 60_000;
const CLAUDE_HOST_TIMEOUT_MS = 150_000;

/**
 * 网关冷却表：键 = host + 网关地址 + 模型（模型位为 * 表示整个网关），值 = 冷却截止时间（ms）。
 * 冷却中的模型直接跳过，不再反复撞 429、刷日志；过期后自动恢复尝试。只存在内存里，插件重载即清空。
 */
export type CooldownTable = Map<string, number>;
const coolKey = (hostId: string, baseUrl: string, model: string) => `${hostId}|${baseUrl}|${model}`;

/** 网关链上每个没用上的模型留下的一步，供日志追踪 */
export type GatewayStep =
  | { model: string; kind: "cooling"; until: number }
  | { model: string; kind: "failed"; reason: string; cooldownMs: number | null };

export type GenerateOutcome =
  | {
      status: "ok";
      briefing: Briefing;
      via: ModelRoute["via"];
      model: string;
      durationMs: number;
      costUsd: number | null;
      /** 命中之前跳过或失败的网关模型（按顺序）；直接命中第一个时为空 */
      steps: GatewayStep[];
    }
  | { status: "failed"; steps: GatewayStep[]; message: string };

/**
 * 一次生成：按顺序试网关上的模型，冷却中的跳过；某个模型连不上、超时、出错或输出过不了 parseBriefing
 * 就试下一个；网关全都不行再兜底到本机 claude。只有 claude 也失败才算失败（才计入连续失败、才进重试冷却）。
 * 429 / 连不上时按 host 给的建议写入冷却表；连不上是网关级冷却，同一轮里后面的模型也随之跳过。
 */
export async function generateBriefing(
  callModel: CallModel,
  hostId: string,
  request: { system: string; prompt: string },
  settings: Pick<BriefingSettings, "model" | "gateway"> & { language?: Lang },
  cooldowns: CooldownTable = new Map(),
  now: () => number = Date.now,
): Promise<GenerateOutcome> {
  const attempt = async (route: ModelRoute, timeoutMs: number) => {
    const result = await callModel(hostId, { ...request, route }, timeoutMs).catch(
      (error): ModelRunResult => ({ status: "failed", message: error instanceof Error ? error.message : String(error) }),
    );
    if (result.status !== "ok") return { ok: false as const, reason: result.message, cooldown: result.cooldown };
    const briefing = parseBriefing(result.text, settings.language ?? "zh");
    if (!briefing) return { ok: false as const, reason: `unparseable model output: ${result.text.replace(/\s+/g, " ").slice(0, 120)}`, cooldown: undefined };
    return { ok: true as const, briefing, durationMs: result.durationMs, costUsd: result.costUsd };
  };
  /** 仍在冷却返回截止时间，没有或已过期返回 0（过期的顺手删掉） */
  const coolingUntil = (key: string) => {
    const until = cooldowns.get(key) ?? 0;
    if (until > now()) return until;
    cooldowns.delete(key);
    return 0;
  };

  const steps: GatewayStep[] = [];
  const succeed = (via: ModelRoute["via"], model: string, hit: { briefing: Briefing; durationMs: number; costUsd: number | null }): GenerateOutcome => ({
    status: "ok",
    briefing: hit.briefing,
    via,
    model,
    durationMs: hit.durationMs,
    costUsd: hit.costUsd,
    steps,
  });

  if (settings.gateway) {
    const { baseUrl, models } = settings.gateway;
    const gatewayKey = coolKey(hostId, baseUrl, "*");
    for (const model of models) {
      const until = Math.max(coolingUntil(gatewayKey), coolingUntil(coolKey(hostId, baseUrl, model)));
      if (until > 0) {
        steps.push({ model, kind: "cooling", until });
        continue;
      }
      const hit = await attempt({ via: "gateway", baseUrl, model }, GATEWAY_HOST_TIMEOUT_MS);
      if (hit.ok) return succeed("gateway", model, hit);
      const cooldownMs = hit.cooldown && hit.cooldown.ms > 0 ? hit.cooldown.ms : null;
      if (hit.cooldown && cooldownMs !== null) cooldowns.set(hit.cooldown.scope === "gateway" ? gatewayKey : coolKey(hostId, baseUrl, model), now() + cooldownMs);
      steps.push({ model, kind: "failed", reason: hit.reason, cooldownMs });
    }
  }
  const hit = await attempt({ via: "claude", model: settings.model }, CLAUDE_HOST_TIMEOUT_MS);
  if (hit.ok) return succeed("claude", settings.model, hit);
  return { status: "failed", steps, message: hit.reason };
}

/**
 * 冷却表 → 给设置页看的清单：按模型合并（同一模型在几台机器上冷却，取最晚的截止时间），model 为 null 表示整个网关连不上；
 * 已过期的不列，按截止时间先后排。
 */
export function summarizeCooldowns(table: ReadonlyMap<string, number>, now: number): { model: string | null; until: number }[] {
  const latest = new Map<string | null, number>();
  for (const [key, until] of table) {
    if (until <= now) continue;
    const raw = key.slice(key.lastIndexOf("|") + 1);
    const model = raw === "*" ? null : raw;
    latest.set(model, Math.max(latest.get(model) ?? 0, until));
  }
  return [...latest].map(([model, until]) => ({ model, until })).sort((a, b) => a.until - b.until);
}

/**
 * 一次写速览的结果。status：written 写好了；disabled 速览开关关着；empty 对话还没有可总结的内容；
 * unavailable 对话没有环境或所在机器不可达；limit 今天的次数用完了；failed 网关与本机 claude 都没写成（error 里是原因）；
 * skipped 后台排队时发现不必写（已是新的等），手动重新生成不会返回它。
 */
export type RegenerateStatus = "written" | "disabled" | "empty" | "unavailable" | "limit" | "failed" | "skipped";
export interface RegenerateResult {
  ok: boolean;
  status: RegenerateStatus;
  briefing: StoredBriefing | null;
  error?: string;
}
const SKIPPED: RegenerateResult = { ok: false, status: "skipped", briefing: null };

/** 设置页上的速览运行状态（只读快照） */
export interface BriefingStatus {
  spentToday: number;
  dailyLimit: number;
  queued: number;
  working: boolean;
  cooldowns: { model: string | null; until: number }[];
  /** 生成失败后在重试冷却里的对话数 */
  retryWaiting: number;
  /** 连续失败太多次清空了队列的时间；之后又写成过一条就清掉 */
  pausedAt: number | null;
  last: { status: "ok"; via: ModelRoute["via"]; model: string; at: number } | { status: "failed"; at: number } | null;
}

/** 日志里的时长：不足一分钟写秒，否则写分钟 */
const span = (ms: number) => (ms < 60_000 ? `${Math.ceil(ms / 1000)}s` : `${Math.ceil(ms / 60_000)}m`);

type ThreadRecord = {
  id: string;
  status?: string;
  environmentId?: string | null;
  archivedAt?: number | null;
  visibility?: string;
  updatedAt?: number;
};

const KEY = (threadId: string) => `briefing:${threadId}`;
const SPEND_KEY = "briefing-spend";
/** 启动时补写：只管最近活跃的对话，且有上限，避免第一次启用时一口气写几百条 */
const BACKFILL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const BACKFILL_LIMIT = 40;
const BACKFILL_DELAY_MS = 8_000;
/** 同一条对话在同一进度（大纲指纹相同）上失败后，过这么久才再试 */
const RETRY_AFTER_MS = 60 * 60 * 1000;

/** 连续失败（网关与 claude 都失败）这么多次就清空队列：多半是本机的 claude 不可用，继续排队只会白花时间和额度 */
const MAX_CONSECUTIVE_FAILURES = 3;

const today = () => new Date().toISOString().slice(0, 10);

export function createBriefingService(bb: BbPluginApi, callModel: CallModel, getSettings: () => Promise<BriefingSettings>) {
  const queue: string[] = [];
  let working = false;
  const failed = new Map<string, { key: string; at: number }>();
  const cooldowns: CooldownTable = new Map();
  let consecutiveFailures = 0;
  let pausedAt: number | null = null;
  const inflight = new Map<string, Promise<RegenerateResult>>();
  let last: BriefingStatus["last"] = null;

  async function read(threadId: string): Promise<StoredBriefing | null> {
    const parsed = storedBriefingSchema.safeParse(await bb.storage.kv.get(KEY(threadId)));
    return parsed.success ? parsed.data : null;
  }

  /** 给界面的一次性视图：存盘的速览 + 是否落后 + 兜底摘要。只读大纲和存盘，不调模型 */
  async function view(threadId: string): Promise<BriefingView> {
    const [stored, outline, settings] = await Promise.all([
      read(threadId),
      bb.sdk.threads.conversationOutline({ threadId }).then(
        (result) => (result as unknown as { items: OutlineItem[] }).items,
        () => [] as OutlineItem[],
      ),
      getSettings(),
    ]);
    // 换了界面语言之后，旧语言写的速览不拿出来（不然就是另一种语言混进界面）；卡片先用兜底摘要，下一轮按新语言重写
    // 输出里总带上 language（旧速览缺这个字段时补上），别的插件按语言匹配展示
    const usable = stored && briefingLanguage(stored) === settings.language ? { ...stored, language: briefingLanguage(stored) } : null;
    return {
      briefing: usable,
      freshness: usable ? freshness(usable, outline) : null,
      recap: buildRecap(outline),
      enabled: settings.enabled,
    };
  }

  /** 当天已写次数；超过上限返回 false */
  async function spend(limit: number): Promise<boolean> {
    const record = (await bb.storage.kv.get<{ day: string; count: number }>(SPEND_KEY)) ?? { day: today(), count: 0 };
    const count = record.day === today() ? record.count : 0;
    if (count >= limit) return false;
    await bb.storage.kv.set(SPEND_KEY, { day: today(), count: count + 1 });
    return true;
  }

  /**
   * 写一条速览。后台（force = false）遇到这些情况直接跳过：速览已是新的、刚失败过还在重试冷却、对话还在跑、隐藏或已归档；
   * 用户手动“重新生成”（force = true）不看这些，立即按当前配置重写。两种都尊重开关、每天上限，并返回结果说明发生了什么。
   * 同一条对话同时只写一份：正在写时再来一次（后台排队或用户连点）直接复用那一次的结果。
   */
  function write(threadId: string, force = false): Promise<RegenerateResult> {
    const running = inflight.get(threadId);
    if (running) return running;
    const job = produce(threadId, force).finally(() => inflight.delete(threadId));
    inflight.set(threadId, job);
    return job;
  }

  async function produce(threadId: string, force: boolean): Promise<RegenerateResult> {
    const settings = await getSettings();
    if (!settings.enabled) return { ok: false, status: "disabled", briefing: null };

    const thread = (await bb.sdk.threads.get({ threadId })) as unknown as ThreadRecord;
    const active = thread.status === "active" || thread.status === "starting";
    if (!force) {
      // 隐藏对话是别的插件的后台工作，侧边栏里看不到；已归档的不再有人悬停
      if (thread.archivedAt || (thread.visibility && thread.visibility !== "visible")) return SKIPPED;
      // 还在跑的对话等它停下来再写：thread.idle 会再触发一次
      if (active) return SKIPPED;
    }
    if (!thread.environmentId) return { ok: false, status: "unavailable", briefing: null, error: "thread has no environment" };

    const outline = (await bb.sdk.threads.conversationOutline({ threadId })) as unknown as { items: OutlineItem[] };
    const askCount = countAsks(outline.items);
    if (askCount === 0) return { ok: false, status: "empty", briefing: null };

    // 任何新消息都算新进展：不只是新要求，子对话回报之后的续写也要重写
    const key = outlineKey(outline.items);
    const promptKey = promptFingerprint(settings.systemPrompt);
    if (!force) {
      const stored = await read(threadId);
      if (stored && freshness(stored, outline.items, settings.language, promptKey).state === "fresh") return SKIPPED;
      const lastFailure = failed.get(threadId);
      if (lastFailure && lastFailure.key === key && Date.now() - lastFailure.at < RETRY_AFTER_MS) return SKIPPED;
    }

    const environment = (await bb.sdk.environments.get({ environmentId: thread.environmentId })) as unknown as { hostId?: string | null };
    if (!environment.hostId) return { ok: false, status: "unavailable", briefing: null, error: "environment has no host" };
    if (!(await spend(settings.dailyLimit))) {
      bb.log.warn(`briefing daily limit (${settings.dailyLimit}) reached; skipping ${threadId}`);
      return { ok: false, status: "limit", briefing: null, error: `daily limit ${settings.dailyLimit} reached` };
    }

    const outcome = await generateBriefing(
      callModel,
      environment.hostId,
      { system: briefingSystemPrompt(settings.language, settings.systemPrompt), prompt: buildDigest(outline.items, { active, language: settings.language }) },
      settings,
      cooldowns,
    );
    // 真正撞上的失败才 warn；冷却中的跳过只在结果那一行里带一句，不刷屏
    for (const step of outcome.steps) {
      if (step.kind !== "failed") continue;
      const cooling = step.cooldownMs === null ? "" : `; cooling down ${span(step.cooldownMs)}`;
      bb.log.warn(`briefing gateway ${step.model} failed for ${threadId}: ${step.reason}${cooling}; trying next`);
    }
    const skipped = outcome.steps.flatMap((step) => (step.kind === "cooling" ? [`${step.model} (${span(step.until - Date.now())} left)`] : []));
    const skippedNote = skipped.length > 0 ? `; skipped while cooling: ${skipped.join(", ")}` : "";
    const how = force ? " (manual)" : "";
    if (outcome.status === "failed") {
      failed.set(threadId, { key, at: Date.now() });
      if (!force) consecutiveFailures += 1;
      last = { status: "failed", at: Date.now() };
      bb.log.warn(`briefing failed for ${threadId}${how} (claude ${settings.model}): ${outcome.message}${skippedNote}`);
      return { ok: false, status: "failed", briefing: null, error: outcome.message };
    }
    failed.delete(threadId);
    consecutiveFailures = 0;
    pausedAt = null;
    last = { status: "ok", via: outcome.via, model: outcome.model, at: Date.now() };
    const stored: StoredBriefing = { ...outcome.briefing, version: BRIEFING_VERSION, language: settings.language, promptKey, outlineKey: key, askCount, generatedAt: Date.now() };
    await bb.storage.kv.set(KEY(threadId), stored);
    const cost = outcome.costUsd === null ? "" : `, $${outcome.costUsd}`;
    const fallback = outcome.steps.length > 0 ? " (fallback)" : "";
    bb.log.info(`briefing written for ${threadId}${how} via ${outcome.via} ${outcome.model}${fallback} (${askCount} asks, ${outcome.durationMs}ms${cost})${skippedNote}`);
    return { ok: true, status: "written", briefing: stored };
  }

  /** 用户手动重新生成一条对话的速览：不看是否已是新的，立即按当前配置重写；结果里说明成功或为什么没写成 */
  async function regenerate(threadId: string): Promise<RegenerateResult> {
    try {
      const first = await write(threadId, true);
      // 正好碰上后台在写这条（复用了它的结果）而后台判断“不必写”：那不是用户要的，再强制写一次
      return first.status === "skipped" ? await write(threadId, true) : first;
    } catch (error) {
      return { ok: false, status: "failed", briefing: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 一次只写一条：小模型调用走用户的订阅额度，不并发抢占 */
  async function drain(): Promise<void> {
    if (working) return;
    working = true;
    try {
      for (let threadId = queue.shift(); threadId !== undefined; threadId = queue.shift()) {
        await write(threadId).catch((error) => bb.log.warn(`briefing error for ${threadId}: ${String(error)}`));
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          bb.log.warn(`briefing: ${consecutiveFailures} failures in a row, dropping ${queue.length} queued threads`);
          queue.length = 0;
          consecutiveFailures = 0;
          pausedAt = Date.now();
        }
      }
    } finally {
      working = false;
    }
  }

  function enqueue(threadId: string): void {
    if (!queue.includes(threadId)) queue.push(threadId);
    void drain();
  }

  async function backfill(): Promise<void> {
    if (!(await getSettings()).enabled) return;
    const listed = (await bb.sdk.threads.list({ archived: false, limit: 200 })) as unknown;
    const threads = (Array.isArray(listed) ? listed : ((listed as { threads?: unknown[] }).threads ?? [])) as ThreadRecord[];
    const since = Date.now() - BACKFILL_WINDOW_MS;
    threads
      .filter((thread) => (thread.updatedAt ?? 0) >= since)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, BACKFILL_LIMIT)
      .forEach((thread) => enqueue(thread.id));
  }

  // 一轮对话结束 = 有新进展可写；悬停、打开对话都不会触发
  bb.events.on("thread.idle", ({ thread }) => enqueue(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => void bb.storage.kv.delete(KEY(thread.id)));

  const timer = setTimeout(() => void backfill().catch((error) => bb.log.warn(`briefing backfill failed: ${String(error)}`)), BACKFILL_DELAY_MS);
  bb.onDispose(() => {
    clearTimeout(timer);
    queue.length = 0;
  });

  /** 设置页用的运行状态快照（只读，不触发任何生成） */
  async function spentToday(): Promise<number> {
    const record = await bb.storage.kv.get<{ day: string; count: number }>(SPEND_KEY);
    return record?.day === today() ? record.count : 0;
  }

  async function status(): Promise<BriefingStatus> {
    const settings = await getSettings();
    return {
      spentToday: await spentToday(),
      dailyLimit: settings.dailyLimit,
      queued: queue.length,
      working,
      cooldowns: summarizeCooldowns(cooldowns, Date.now()),
      retryWaiting: failed.size,
      pausedAt,
      last,
    };
  }

  /** 用户在设置页手动恢复：清掉网关冷却与失败重试的冷却，再补写一遍（补写本身有条数与每天上限） */
  async function resetCooldowns(): Promise<void> {
    cooldowns.clear();
    failed.clear();
    consecutiveFailures = 0;
    pausedAt = null;
    await backfill();
  }

  /** 用户在设置页手动清零今天的计数（上限防的是意外循环；用户确认后再给一天的额度） */
  async function resetTodayCount(): Promise<void> {
    await bb.storage.kv.set(SPEND_KEY, { day: today(), count: 0 });
  }

  return { view, backfill, status, resetCooldowns, resetTodayCount, spentToday, regenerate };
}
