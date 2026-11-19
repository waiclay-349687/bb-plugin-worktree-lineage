/**
 * [INPUT]: 依赖 bb.sdk.threads（对话大纲、列表）与 bb.sdk.environments（对话在哪台机器）、bb.events 的 thread.idle / thread.deleted、bb.storage.kv 存盘、调用方注入的 callModel（经 host.ts 的 writeBriefing 调本机小模型）; 依赖 lib/briefing 的提要与解析
 * [OUTPUT]: 对外提供 createBriefingService(bb, callModel, getSettings): { view(threadId), backfill() } — 在后台为每条对话写“全程速览”并存盘；view 给界面一次性取回速览、是否落后、兜底摘要（只读）
 * [POS]: 插件服务端的速览调度; 消费者: server.ts; 与 lib/briefing.ts 的边界: 这里决定“何时写、写哪条、写完存哪”，提示词与输出校验在 briefing; 与 host.ts 的边界: 这里不执行任何命令
 * [PROTOCOL]: 变更时更新此头部,然后检查项目根 CLAUDE.md
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { BRIEFING_SYSTEM_PROMPT, BRIEFING_VERSION, buildDigest, countAsks, freshness, outlineKey, parseBriefing, storedBriefingSchema, type StoredBriefing } from "./lib/briefing";
import type { ModelRunResult } from "./lib/model-run";
import type { BriefingView } from "./lib/contract";
import { buildRecap, type OutlineItem } from "./lib/search";

/** 把提示词交给某台机器上的小模型；由 server.ts 用 host 客户端实现 */
export type CallModel = (hostId: string, input: { system: string; prompt: string; model: string }, timeoutMs: number) => Promise<ModelRunResult>;

export interface BriefingSettings {
  enabled: boolean;
  model: string;
}

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
const HOST_TIMEOUT_MS = 150_000;
/** 启动时补写：只管最近活跃的对话，且有上限，避免第一次启用时一口气写几百条 */
const BACKFILL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const BACKFILL_LIMIT = 40;
const BACKFILL_DELAY_MS = 8_000;
/** 每天最多写这么多次：防止意外的循环把额度烧掉 */
const DAILY_LIMIT = 300;
/** 同一条对话在同一进度（大纲指纹相同）上失败后，过这么久才再试 */
const RETRY_AFTER_MS = 60 * 60 * 1000;

/** 连续失败这么多次就清空队列：多半是本机的 claude 不可用，继续排队只会白花时间和额度 */
const MAX_CONSECUTIVE_FAILURES = 3;

const today = () => new Date().toISOString().slice(0, 10);

export function createBriefingService(bb: BbPluginApi, callModel: CallModel, getSettings: () => Promise<BriefingSettings>) {
  const queue: string[] = [];
  let working = false;
  const failed = new Map<string, { key: string; at: number }>();
  let consecutiveFailures = 0;

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
    return {
      briefing: stored,
      freshness: stored ? freshness(stored, outline) : null,
      recap: buildRecap(outline),
      enabled: settings.enabled,
    };
  }

  /** 当天已写次数；超过上限返回 false */
  async function spend(): Promise<boolean> {
    const record = (await bb.storage.kv.get<{ day: string; count: number }>(SPEND_KEY)) ?? { day: today(), count: 0 };
    const count = record.day === today() ? record.count : 0;
    if (count >= DAILY_LIMIT) return false;
    await bb.storage.kv.set(SPEND_KEY, { day: today(), count: count + 1 });
    return true;
  }

  async function write(threadId: string): Promise<void> {
    const settings = await getSettings();
    if (!settings.enabled) return;

    const thread = (await bb.sdk.threads.get({ threadId })) as unknown as ThreadRecord;
    // 隐藏对话是别的插件的后台工作，侧边栏里看不到；已归档的不再有人悬停
    if (thread.archivedAt || (thread.visibility && thread.visibility !== "visible")) return;
    // 还在跑的对话等它停下来再写：thread.idle 会再触发一次
    if (thread.status === "active" || thread.status === "starting") return;
    if (!thread.environmentId) return;

    const outline = (await bb.sdk.threads.conversationOutline({ threadId })) as unknown as { items: OutlineItem[] };
    const askCount = countAsks(outline.items);
    if (askCount === 0) return;

    // 任何新消息都算新进展：不只是新要求，子对话回报之后的续写也要重写
    const key = outlineKey(outline.items);
    const stored = await read(threadId);
    if (stored && freshness(stored, outline.items).state === "fresh") return;
    const lastFailure = failed.get(threadId);
    if (lastFailure && lastFailure.key === key && Date.now() - lastFailure.at < RETRY_AFTER_MS) return;

    const environment = (await bb.sdk.environments.get({ environmentId: thread.environmentId })) as unknown as { hostId?: string | null };
    if (!environment.hostId) return;
    if (!(await spend())) {
      bb.log.warn(`briefing daily limit (${DAILY_LIMIT}) reached; skipping ${threadId}`);
      return;
    }

    const result = await callModel(
      environment.hostId,
      { system: BRIEFING_SYSTEM_PROMPT, prompt: buildDigest(outline.items, { active: false }), model: settings.model },
      HOST_TIMEOUT_MS,
    );
    const briefing = result.status === "ok" ? parseBriefing(result.text) : null;
    if (!briefing) {
      failed.set(threadId, { key, at: Date.now() });
      consecutiveFailures += 1;
      bb.log.warn(`briefing failed for ${threadId}: ${result.status === "ok" ? "unparseable model output" : result.message}`);
      return;
    }
    failed.delete(threadId);
    consecutiveFailures = 0;
    await bb.storage.kv.set(KEY(threadId), { ...briefing, version: BRIEFING_VERSION, outlineKey: key, askCount, generatedAt: Date.now() } satisfies StoredBriefing);
    bb.log.info(`briefing written for ${threadId} (${askCount} asks, ${result.status === "ok" ? `${result.durationMs}ms, $${result.costUsd ?? "?"}` : ""})`);
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

  return { view, backfill };
}
