import { describe, expect, it } from "vitest";
import { BRIEFING_VERSION, briefingSystemPrompt, buildDigest, freshness, outlineKey, parseBriefing } from "../lib/briefing";
import { LANGUAGE_OPTION_LABELS, MESSAGES, relativeTime, resolveLanguage, SETTINGS_TEXT, type Messages } from "../lib/i18n";
import type { OutlineItem } from "../lib/search";

const HAN = /[一-鿿]/;
/** 中文界面里允许出现的英文：专有名词与按键名，别的英文词一律不许出现 */
const ZH_ALLOWED_WORDS = new Set(["Git", "BB", "HEAD", "Alt", "Option"]);
/** 用户点名要防的“英文界面词”，单独再查一遍，失败时信息更直观 */
const ZH_BANNED = /Settled|Settle|Unsettle|worktree|Conversation|Branch|Tree|Merged|Idle|Outside|Main checkout|\bPR\b|\bfrom\b|\bnow\b/i;

/** 把一本词典里每一项都渲染成文字：函数用示例参数调用（参数本身用当前语言的示例，免得混进别的语言） */
function render(messages: Messages, sample: string): string[] {
  return Object.entries(messages).map(([key, value]) => {
    if (typeof value === "string") return value;
    if (key === "dispatchedCount") return (value as Messages["dispatchedCount"])(3, [messages.childPart(1, messages.childRunning)]);
    if (key === "childPart") return (value as Messages["childPart"])(2, messages.childDone);
    if (key === "pullRequest") return (value as Messages["pullRequest"])(12, messages.prMerged);
    const fn = value as (arg: unknown) => string;
    return /^(time|turns|uncommitted|behind|fold|foot|nodeAhead|attention|highlight)/.test(key) ? fn(3) : fn(sample);
  });
}

const words = (text: string) => text.match(/[A-Za-z]+/g) ?? [];

describe("界面词典：零混用", () => {
  it("两本词典的键完全一致", () => {
    expect(Object.keys(MESSAGES.zh).sort()).toEqual(Object.keys(MESSAGES.en).sort());
  });

  it("英文词典渲染出来的每一条都不含汉字（含单复数分支）", () => {
    const texts = [...render(MESSAGES.en, "feat/x"), ...[1, 2].flatMap((n) => [MESSAGES.en.turns(n), MESSAGES.en.nodeAhead(n), MESSAGES.en.foldChildrenOpen(n), MESSAGES.en.highlightDispatched(n)])];
    expect(texts.filter((text) => HAN.test(text))).toEqual([]);
  });

  it("中文词典渲染出来的每一条都不含英文界面词，只允许专有名词与按键名", () => {
    const texts = render(MESSAGES.zh, "示例");
    expect(texts.filter((text) => ZH_BANNED.test(text))).toEqual([]);
    const stray = texts.flatMap(words).filter((word) => !ZH_ALLOWED_WORDS.has(word));
    expect(stray).toEqual([]);
  });

  it("中文界面的关键叫法：搁置 / 已搁置 / 工作树，不用“已完结”", () => {
    const all = render(MESSAGES.zh, "示例").join("\n");
    expect(MESSAGES.zh.footSettled(2)).toBe("已搁置 2");
    expect(MESSAGES.zh.footIdle(3)).toBe("空闲工作树 3");
    expect([MESSAGES.zh.tagNoWorktree, MESSAGES.zh.tagOutside]).toEqual(["无工作树", "外部工作树"]);
    expect(all).not.toContain("已完结");
  });

  it("英文界面的关键叫法", () => {
    const t = MESSAGES.en;
    expect([t.viewConversations, t.viewTree, t.settle, t.unsettle, t.footSettled(1)]).toEqual(["Conversations", "Branch Tree", "Settle", "Unsettle", "Settled 1"]);
    expect([t.tagMain, t.tagMerged, t.tagNoWorktree, t.tagOutside, t.footIdle(2)]).toEqual(["Main checkout", "Merged", "No worktree", "Outside BB", "Idle worktrees 2"]);
    expect([t.recapNow, t.recapWaiting, t.recapNext, t.recapProgress, t.turns(12)]).toEqual(["Now", "Waiting on you", "Next", "Progress", "12 turns"]);
  });

  it("相对时间两种语言各自纯净", () => {
    const now = 100 * 24 * 3600_000;
    const ago = [0, 5 * 60_000, 3 * 3600_000, 2 * 24 * 3600_000, 30 * 24 * 3600_000];
    expect(ago.map((ms) => relativeTime(now - ms, now, "en")).filter((text) => HAN.test(text))).toEqual([]);
    expect(ago.flatMap((ms) => words(relativeTime(now - ms, now, "zh")))).toEqual([]);
  });

  it("设置项文案固定英文（bb 的设置页不能随语言切换）：不含汉字", () => {
    const texts = Object.values(SETTINGS_TEXT).flatMap((field) => [field.label, field.description]);
    expect(texts.filter((text) => HAN.test(text))).toEqual([]);
  });

  it("语言下拉框：“自动”写英文，语言名按惯例用它自己的文字", () => {
    expect(HAN.test(LANGUAGE_OPTION_LABELS.auto)).toBe(false);
    expect([LANGUAGE_OPTION_LABELS.en, LANGUAGE_OPTION_LABELS.zh]).toEqual(["English", "简体中文"]);
  });
});

describe("resolveLanguage", () => {
  it("en / zh 直接用，不看宿主语言", () => {
    expect(resolveLanguage("en", ["zh-CN"])).toBe("en");
    expect(resolveLanguage("zh", ["en-US"])).toBe("zh");
  });

  it("auto 按第一个非空的宿主语言：zh* → zh，其余 → en（调用方把 BB 的 <html lang> 放第一位）", () => {
    // 英文 BB（<html lang="en">）+ 中文系统：跟 BB 走，是英文
    expect(resolveLanguage("auto", ["en", "zh-CN", "zh"])).toBe("en");
    // BB 没写语言时才看浏览器
    expect(resolveLanguage("auto", ["", "zh-CN"])).toBe("zh");
    expect(resolveLanguage("auto", ["zh-CN", "en"])).toBe("zh");
    expect(resolveLanguage("auto", ["zh-Hant-TW"])).toBe("zh");
    expect(resolveLanguage("auto", ["", null, "zh"])).toBe("zh");
    expect(resolveLanguage("auto", ["en-US", "zh-CN"])).toBe("en");
    expect(resolveLanguage("auto", ["ja-JP"])).toBe("en");
    expect(resolveLanguage("auto", [])).toBe("en");
  });

  it("无效的设置值按 auto 处理", () => {
    expect(resolveLanguage("fr", ["zh-CN"])).toBe("zh");
    expect(resolveLanguage(undefined, ["en"])).toBe("en");
  });
});

describe("速览按语言生成与失效", () => {
  const items: OutlineItem[] = [
    { id: "u1", role: "user", preview: "add login" },
    { id: "a1", role: "assistant", preview: "done" },
  ];

  it("英文提示词与提要不含汉字，中文提要沿用中文标签", () => {
    expect(HAN.test(briefingSystemPrompt("en"))).toBe(false);
    expect(HAN.test(buildDigest(items, { active: false, language: "en" }))).toBe(false);
    expect(buildDigest(items, { active: false, language: "en" })).toContain("1. Request: add login\n   Reply: done");
    expect(buildDigest(items, { active: false, language: "zh" })).toContain("1. 要求：add login");
    expect(briefingSystemPrompt("zh")).toContain("简体中文");
  });

  it("存盘的速览语言和当前语言不一致就算落后；缺语言字段的旧速览按中文算", () => {
    const stored = { version: BRIEFING_VERSION, outlineKey: outlineKey(items), askCount: 1 };
    expect(freshness({ ...stored, language: "en" }, items, "en")).toEqual({ state: "fresh" });
    expect(freshness({ ...stored, language: "en" }, items, "zh")).toEqual({ state: "behind", newAsks: 0 });
    expect(freshness(stored, items, "zh")).toEqual({ state: "fresh" });
    expect(freshness(stored, items, "en")).toEqual({ state: "behind", newAsks: 0 });
  });

  it("英文输出的截短上限更宽，12 个词的一句话不会被截掉", () => {
    const about = "Replace the implicit grant login with OAuth PKCE across the web app";
    const raw = JSON.stringify({ about, stages: [{ title: "Audit current auth flow", state: "done", note: "Implicit grant still used in two places" }], now: "Reviewing refresh retry", waiting: null, next: null });
    expect(parseBriefing(raw, "en")?.about).toBe(about);
    expect(parseBriefing(raw, "zh")?.about.endsWith("…")).toBe(true);
  });
});
