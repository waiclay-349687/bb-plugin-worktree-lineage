import { describe, expect, it } from "vitest";
import { summarizeCooldowns } from "../briefings";
import { serverContract, settingsStatusSchema, type SettingsStatus } from "../lib/contract";
import { agoText, MESSAGES } from "../lib/i18n";
import { parseSettledMap, settledToPrune, type SettleCheckable } from "../lib/settle";
import { normalizeSettings } from "../lib/prefs";

const HAN = /[一-鿿]/;

describe("summarizeCooldowns（设置页的冷却清单）", () => {
  const now = 1_000_000;
  it("按模型合并多台机器的冷却取最晚截止，网关整体冷却记为 null，过期的不列，按截止先后排", () => {
    const table = new Map<string, number>([
      ["host-1|http://gw|model-a", now + 60_000],
      ["host-2|http://gw|model-a", now + 300_000],
      ["host-1|http://gw|*", now + 30_000],
      ["host-1|http://gw|model-b", now - 1],
    ]);
    expect(summarizeCooldowns(table, now)).toEqual([
      { model: null, until: now + 30_000 },
      { model: "model-a", until: now + 300_000 },
    ]);
  });

  it("空表或全部过期时为空", () => {
    expect(summarizeCooldowns(new Map(), now)).toEqual([]);
    expect(summarizeCooldowns(new Map([["h|g|m", now]]), now)).toEqual([]);
  });
});

describe("本机 Settle 记录", () => {
  it("parseSettledMap 丢掉坏数据，永不抛出", () => {
    expect(parseSettledMap(null)).toEqual({});
    expect(parseSettledMap("not json")).toEqual({});
    expect(parseSettledMap("[1,2]")).toEqual({});
    expect(parseSettledMap('{"a":1,"b":"x","c":null,"d":2}')).toEqual({ a: 1, d: 2 });
  });

  const thread = (id: string, extra: Partial<SettleCheckable> = {}): SettleCheckable => ({ id, parentThreadId: null, createdAt: 1, updatedAt: 1, latestAttentionAt: 1, indicator: "none", ...extra });

  it("列表还没加载完时一条都不清（加载中的列表只是一部分）", () => {
    expect(settledToPrune({ a: 10, gone: 10 }, () => undefined, new Set(), false)).toEqual([]);
  });

  it("加载完以后：找不到的（已归档 / 删除）与被新活动唤醒的才清", () => {
    const threads = new Map([
      ["quiet", thread("quiet")],
      ["woke", thread("woke", { latestAttentionAt: 99 })],
      ["running", thread("running", { indicator: "runtime" })],
    ]);
    const drop = settledToPrune({ quiet: 10, woke: 10, running: 10, gone: 10 }, (id) => threads.get(id), new Set(), true);
    expect(drop.sort()).toEqual(["gone", "running", "woke"]);
  });
});

describe("设置页 RPC 契约", () => {
  const status: SettingsStatus = {
    values: normalizeSettings({}),
    defaultPrompts: { en: "default en", zh: "default zh" },
    language: "auto",
    briefingLanguage: "en",
    briefingEnabled: true,
    gateway: { baseUrl: "http://127.0.0.1:3425", models: ["a/model", "b/model"] },
    claudeModel: "haiku",
    briefing: {
      spentToday: 12,
      dailyLimit: 300,
      queued: 0,
      working: false,
      cooldowns: [{ model: null, until: 5 }],
      retryWaiting: 1,
      pausedAt: null,
      last: { status: "ok", via: "gateway", model: "a/model", at: 4 },
    },
  };

  it("状态快照通过 schema 校验；last 为空、失败、本机 claude 三种形状都合法", () => {
    expect(settingsStatusSchema.parse(status)).toEqual(status);
    for (const last of [null, { status: "failed", at: 1 }, { status: "ok", via: "claude", model: "haiku", at: 1 }] as const) {
      expect(settingsStatusSchema.safeParse({ ...status, briefing: { ...status.briefing, last } }).success).toBe(true);
    }
    expect(settingsStatusSchema.safeParse({ ...status, language: "fr" }).success).toBe(false);
  });

  it("updateSettings 只接受合法的语言与布尔开关，两项都可省略", () => {
    const input = serverContract.updateSettings.input;
    expect(input.safeParse({}).success).toBe(true);
    expect(input.safeParse({ language: "zh" }).success).toBe(true);
    expect(input.safeParse({ briefingEnabled: false }).success).toBe(true);
    expect(input.safeParse({ language: "jp" }).success).toBe(false);
    expect(input.safeParse({ briefingEnabled: "yes" }).success).toBe(false);
  });

  it("设置页三个方法都在契约里，返回同一个状态快照", () => {
    expect(serverContract.settingsStatus.output).toBe(settingsStatusSchema);
    expect(serverContract.updateSettings.output).toBe(settingsStatusSchema);
    expect(serverContract.resetBriefingCooldowns.output).toBe(settingsStatusSchema);
  });
});

describe("agoText 与设置页文案", () => {
  const now = 10 * 24 * 3600_000;
  it("多久以前：不到一分钟写 now / 刚刚，否则 5m ago / 5分钟前", () => {
    expect([agoText(now - 10_000, now, "en"), agoText(now - 5 * 60_000, now, "en")]).toEqual(["now", "5m ago"]);
    expect([agoText(now - 10_000, now, "zh"), agoText(now - 5 * 60_000, now, "zh")]).toEqual(["刚刚", "5分钟前"]);
  });

  it("设置页的关键文案两种语言各自纯净，中文不用“已完结”", () => {
    const en = MESSAGES.en;
    const zh = MESSAGES.zh;
    const enTexts = [en.settingsTitle, en.setLanguage, en.languageAuto, en.setBriefings, en.setToday(3, 300), en.unsettleAll, en.settledCount(2), en.setLimitReached];
    const zhTexts = [zh.settingsTitle, zh.setLanguage, zh.languageAuto, zh.setBriefings, zh.setToday(3, 300), zh.unsettleAll, zh.settledCount(2), zh.setLimitReached];
    expect(enTexts.filter((t) => HAN.test(t))).toEqual([]);
    expect(zhTexts.flatMap((t) => t.match(/[A-Za-z]+/g) ?? []).filter((w) => w !== "BB")).toEqual([]);
    expect([zh.unsettleAll, zh.settledCount(2)]).toEqual(["全部取消搁置", "本机已搁置 2 条"]);
    expect(zhTexts.join("")).not.toContain("已完结");
  });
});
