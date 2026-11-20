import { afterEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createBriefingService, type BriefingSettings, type CallModel } from "../briefings";
import { BRIEFING_VERSION, outlineKey, promptFingerprint } from "../lib/briefing";
import { regenerateResultSchema } from "../lib/contract";
import { MESSAGES, regenerateText } from "../lib/i18n";
import type { OutlineItem } from "../lib/search";

const VALID = JSON.stringify({ about: "Add login", stages: [{ title: "Build form", state: "done", note: "Tests green" }], now: "Waiting for review", waiting: null, next: null });
const ITEMS: OutlineItem[] = [
  { id: "u1", role: "user", preview: "add a login page" },
  { id: "a1", role: "assistant", preview: "done, tests pass" },
];

const baseSettings: BriefingSettings = { enabled: true, language: "en", model: "haiku", gateway: null, systemPrompt: "", dailyLimit: 300 };

/** 最小的 bb：只有速览服务用到的接口；kv 是内存表 */
function fakeBb(options: { items?: OutlineItem[]; hostId?: string | null; status?: string } = {}) {
  const kv = new Map<string, unknown>();
  const bb = {
    sdk: {
      threads: {
        get: async () => ({ id: "t1", status: options.status ?? "idle", environmentId: "e1", visibility: "visible" }),
        conversationOutline: async () => ({ items: options.items ?? ITEMS }),
        list: async () => ({ threads: [] }),
      },
      environments: { get: async () => ({ hostId: options.hostId === undefined ? "h1" : options.hostId }) },
    },
    storage: {
      kv: {
        get: async (key: string) => kv.get(key),
        set: async (key: string, value: unknown) => void kv.set(key, value),
        delete: async (key: string) => void kv.delete(key),
      },
    },
    events: { on: () => undefined },
    log: { info: () => undefined, warn: () => undefined },
    onDispose: () => undefined,
  };
  return { bb: bb as unknown as BbPluginApi, kv };
}

function service(settings: Partial<BriefingSettings> = {}, bbOptions: Parameters<typeof fakeBb>[0] = {}, reply: () => Promise<unknown> = async () => ({ status: "ok", text: VALID, costUsd: null, durationMs: 5 })) {
  const { bb, kv } = fakeBb(bbOptions);
  const calls: Parameters<CallModel>[] = [];
  const callModel: CallModel = async (...args) => {
    calls.push(args);
    return (await reply()) as Awaited<ReturnType<CallModel>>;
  };
  const s = createBriefingService(bb, callModel, async () => ({ ...baseSettings, ...settings }));
  return { s, kv, calls };
}

afterEach(() => vi.useRealTimers());

describe("regenerate（手动重新生成速览）", () => {
  it("已有新的速览也强制按当前配置重写，并写盘", async () => {
    const { s, kv, calls } = service();
    kv.set("briefing:t1", { about: "old", stages: [{ title: "x", state: "done", note: "" }], now: "", waiting: null, next: null, version: BRIEFING_VERSION, language: "en", promptKey: "", outlineKey: outlineKey(ITEMS), askCount: 1, generatedAt: 1 });
    const result = await s.regenerate("t1");
    expect(result).toMatchObject({ ok: true, status: "written" });
    expect(result.briefing?.about).toBe("Add login");
    expect(calls).toHaveLength(1);
    expect((kv.get("briefing:t1") as { about: string }).about).toBe("Add login");
    expect(regenerateResultSchema.safeParse(result).success).toBe(true);
  });

  it("用最新配置：速览语言与自定义提示词进了这次请求，指纹写进存盘", async () => {
    const { s, kv, calls } = service({ language: "zh", systemPrompt: "Keep it short." });
    await s.regenerate("t1");
    const input = calls[0]![1];
    expect(input.system.startsWith("Keep it short.")).toBe(true);
    expect(input.system).toContain("简体中文");
    expect(input.prompt).toContain("要求：");
    expect(kv.get("briefing:t1")).toMatchObject({ language: "zh", promptKey: promptFingerprint("Keep it short.") });
  });

  it("开关关着、对话没有内容、找不到机器：各自给出清楚的状态，不调用模型", async () => {
    const off = service({ enabled: false });
    expect(await off.s.regenerate("t1")).toMatchObject({ ok: false, status: "disabled" });
    const empty = service({}, { items: [] });
    expect(await empty.s.regenerate("t1")).toMatchObject({ ok: false, status: "empty" });
    const noHost = service({}, { hostId: null });
    expect(await noHost.s.regenerate("t1")).toMatchObject({ ok: false, status: "unavailable" });
    expect([off.calls, empty.calls, noHost.calls].every((c) => c.length === 0)).toBe(true);
  });

  it("今天的次数用完：返回 limit，不调用模型", async () => {
    const { s, kv, calls } = service({ dailyLimit: 10 });
    kv.set("briefing-spend", { day: new Date().toISOString().slice(0, 10), count: 10 });
    expect(await s.regenerate("t1")).toMatchObject({ ok: false, status: "limit" });
    expect(calls).toHaveLength(0);
  });

  it("模型全都失败：返回 failed 与原因，不吞掉", async () => {
    const { s } = service({}, {}, async () => ({ status: "failed", message: "claude not found" }));
    expect(await s.regenerate("t1")).toEqual({ ok: false, status: "failed", briefing: null, error: "claude not found" });
  });

  it("还在跑的对话也可以手动重新生成", async () => {
    const { s, calls } = service({}, { status: "active" });
    expect(await s.regenerate("t1")).toMatchObject({ ok: true, status: "written" });
    expect(calls).toHaveLength(1);
  });

  it("同一条对话连点两次：只调用一次模型，两次拿到同一个结果", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { s, calls } = service({}, {}, async () => {
      await gate;
      return { status: "ok", text: VALID, costUsd: null, durationMs: 5 };
    });
    const first = s.regenerate("t1");
    const second = s.regenerate("t1");
    await Promise.resolve();
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
    expect(a.status).toBe("written");
  });
});

describe("跨语言显示：悬停卡片与 Progress 同一份速览", () => {
  const zhBriefing = { about: "给侧边栏加登录页", stages: [{ title: "做表单", state: "done", note: "测试已通过" }], now: "等你验收", waiting: "要不要保留旧登录？", next: "上线后删掉旧代码", version: BRIEFING_VERSION, language: "zh", promptKey: "", outlineKey: outlineKey(ITEMS), askCount: 1, generatedAt: 1 };

  it("界面 / 速览语言是英文、存盘的是中文速览：原样给出，不藏、不降级成兜底摘要；是否落后只看对话内容", async () => {
    const { s, kv } = service({ language: "en" });
    kv.set("briefing:t1", zhBriefing);
    const view = await s.view("t1");
    expect(view.briefing).toMatchObject({ about: "给侧边栏加登录页", stages: [{ title: "做表单", note: "测试已通过" }], now: "等你验收", waiting: "要不要保留旧登录？", language: "zh" });
    expect(view.freshness).toEqual({ state: "fresh" });
  });

  it("反过来（速览语言中文、存盘英文）同样原样给出", async () => {
    const { s, kv } = service({ language: "zh" });
    kv.set("briefing:t1", { ...zhBriefing, about: "Add a login page", language: "en" });
    expect((await s.view("t1")).briefing).toMatchObject({ about: "Add a login page", language: "en" });
  });

  it("重新生成时指定语言：这一次按指定语言写，提示词与提要都换成那种语言", async () => {
    const { s, kv, calls } = service({ language: "en" });
    const result = await s.regenerate("t1", "zh");
    expect(result).toMatchObject({ ok: true, status: "written" });
    expect(result.briefing?.language).toBe("zh");
    expect(calls[0]![1].system).toContain("简体中文");
    expect(calls[0]![1].prompt).toContain("要求：");
    expect(kv.get("briefing:t1")).toMatchObject({ language: "zh" });
  });
});

describe("regenerateText（结果说明）两种语言各自纯净", () => {
  const statuses = ["written", "disabled", "empty", "unavailable", "limit", "failed"] as const;
  it("英文不含汉字，中文不含英文词", () => {
    expect(statuses.map((st) => regenerateText(MESSAGES.en, st)).filter((t) => /[一-鿿]/.test(t))).toEqual([]);
    expect(statuses.flatMap((st) => regenerateText(MESSAGES.zh, st).match(/[A-Za-z]+/g) ?? [])).toEqual([]);
    expect(regenerateText(MESSAGES.zh, "limit")).toBe("今天的速览次数已用完");
  });
});
