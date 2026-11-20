import { describe, expect, it } from "vitest";
import { BRIEFING_VERSION, briefingSystemPrompt, defaultSystemPrompt, freshness, outlineKey, promptFingerprint } from "../lib/briefing";
import { briefingConfigSchema, briefingConfigToPatch, serverContract, setBriefingConfigSchema, settingsPatchSchema } from "../lib/contract";
import { clampInt, DAILY_LIMIT, normalizeSettings, PEEK_DELAY, PROMPT_MAX_LENGTH, resolveBriefingLanguage } from "../lib/prefs";
import type { OutlineItem } from "../lib/search";

const HAN = /[一-鿿]/;

describe("resolveBriefingLanguage（速览语言独立于界面语言）", () => {
  it("速览语言单独设了就用它：英文界面也能配中文速览", () => {
    expect(resolveBriefingLanguage("zh", "en", "en")).toBe("zh");
    expect(resolveBriefingLanguage("en", "zh", "zh")).toBe("en");
  });

  it("auto 跟随界面语言；界面也是 auto 时用前端报上来的语言", () => {
    expect(resolveBriefingLanguage("auto", "zh", "en")).toBe("zh");
    expect(resolveBriefingLanguage("auto", "en", "zh")).toBe("en");
    expect(resolveBriefingLanguage("auto", "auto", "zh")).toBe("zh");
    expect(resolveBriefingLanguage("auto", "auto", "en")).toBe("en");
  });
});

describe("自定义提示词", () => {
  it("留空（或只有空白）用内置提示词，指纹为空串", () => {
    expect(briefingSystemPrompt("en", "")).toBe(defaultSystemPrompt("en"));
    expect(briefingSystemPrompt("zh", "   \n")).toBe(defaultSystemPrompt("zh"));
    expect(promptFingerprint("  ")).toBe("");
  });

  it("有自定义时用用户的话，后面一定接上 JSON 输出约束（字段名与语言要求都在）", () => {
    for (const lang of ["en", "zh"] as const) {
      const prompt = briefingSystemPrompt(lang, "Be terse.");
      expect(prompt.startsWith("Be terse.\n\n")).toBe(true);
      for (const field of ['"about"', '"stages"', '"state"', '"done" | "doing" | "dropped"', '"now"', '"waiting"', '"next"']) expect(prompt).toContain(field);
    }
    expect(HAN.test(briefingSystemPrompt("en", "Be terse."))).toBe(false);
    expect(briefingSystemPrompt("zh", "简短一点")).toContain("简体中文");
  });

  it("指纹稳定、首尾空白不算变化，内容一变指纹就变", () => {
    expect(promptFingerprint("Be terse.")).toBe(promptFingerprint("  Be terse.\n"));
    expect(promptFingerprint("Be terse.")).not.toBe(promptFingerprint("Be terser."));
    expect(promptFingerprint("Be terse.")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("换了提示词（或从自定义换回内置）存盘的速览就算落后，要按新提示词重写", () => {
    const items: OutlineItem[] = [
      { id: "u1", role: "user", preview: "add login" },
      { id: "a1", role: "assistant", preview: "done" },
    ];
    const stored = { version: BRIEFING_VERSION, outlineKey: outlineKey(items), askCount: 1, language: "en" as const };
    const key = promptFingerprint("Be terse.");
    expect(freshness({ ...stored, promptKey: key }, items, "en", key)).toEqual({ state: "fresh" });
    expect(freshness({ ...stored, promptKey: key }, items, "en", promptFingerprint("Other"))).toEqual({ state: "behind", newAsks: 0 });
    expect(freshness({ ...stored, promptKey: key }, items, "en", "")).toEqual({ state: "behind", newAsks: 0 });
    // 加这个字段之前写的速览（没有 promptKey）在内置提示词下仍是新的
    expect(freshness(stored, items, "en", "")).toEqual({ state: "fresh" });
  });
});

describe("设置取值收紧（normalizeSettings / clampInt）", () => {
  it("全部缺省时给默认值", () => {
    expect(normalizeSettings({})).toEqual({
      language: "auto",
      briefingEnabled: true,
      briefingLanguage: "auto",
      briefingGatewayUrl: "http://127.0.0.1:3425",
      briefingGatewayModel: "workbuddy/deepseek-v4.1-flash, opencode-zen/deepseek-v4.1-flash-free",
      briefingModel: "haiku",
      briefingSystemPrompt: "",
      briefingDailyLimit: 300,
      peekEnabled: true,
      peekDelayMs: 450,
      defaultView: "conversations",
    });
  });

  it("CLI 写进去的越界值与坏值被收紧：数字夹进范围，枚举回默认，提示词截到上限", () => {
    const values = normalizeSettings({ briefingDailyLimit: 99999, peekDelayMs: 5, language: "fr", briefingLanguage: 3, defaultView: "grid", briefingSystemPrompt: "x".repeat(PROMPT_MAX_LENGTH + 50) });
    expect(values.briefingDailyLimit).toBe(DAILY_LIMIT.max);
    expect(values.peekDelayMs).toBe(PEEK_DELAY.min);
    expect([values.language, values.briefingLanguage, values.defaultView]).toEqual(["auto", "auto", "conversations"]);
    expect(values.briefingSystemPrompt).toHaveLength(PROMPT_MAX_LENGTH);
  });

  it("clampInt：字符串数字可用、小数四舍五入、非数字回默认", () => {
    expect(clampInt("120", DAILY_LIMIT)).toBe(120);
    expect(clampInt(450.6, PEEK_DELAY)).toBe(451);
    expect(clampInt("abc", DAILY_LIMIT)).toBe(DAILY_LIMIT.default);
    expect(clampInt(undefined, PEEK_DELAY)).toBe(PEEK_DELAY.default);
  });
});

describe("设置页补丁的边界校验（updateSettings）", () => {
  it("范围内的值通过", () => {
    expect(settingsPatchSchema.safeParse({ briefingDailyLimit: 10, peekDelayMs: 1500, defaultView: "branch-tree", briefingLanguage: "zh", peekEnabled: false }).success).toBe(true);
  });

  it("越界、小数、空的兜底模型、超长提示词、未知视图一律拒绝", () => {
    for (const bad of [{ briefingDailyLimit: 9 }, { briefingDailyLimit: 2001 }, { briefingDailyLimit: 12.5 }, { peekDelayMs: 99 }, { peekDelayMs: 1501 }, { briefingModel: "  " }, { briefingSystemPrompt: "x".repeat(PROMPT_MAX_LENGTH + 1) }, { defaultView: "grid" }, { briefingLanguage: "fr" }]) {
      expect(settingsPatchSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("给 session-cockpit 的跨插件契约", () => {
  const config = {
    enabled: true,
    language: "auto" as const,
    gatewayUrl: "http://127.0.0.1:3425",
    gatewayModel: "a/model, b/model",
    fallbackModel: "haiku",
    systemPrompt: "",
    defaultSystemPromptEn: "en prompt",
    defaultSystemPromptZh: "zh prompt",
    dailyLimit: 300,
    todayCount: 12,
    resolvedLanguage: "zh" as const,
  };

  it("briefingConfig：输入可省略，输出字段与约定一致", () => {
    expect(serverContract.briefingConfig.input.safeParse(undefined).success).toBe(true);
    expect(serverContract.briefingConfig.input.safeParse({}).success).toBe(true);
    expect(briefingConfigSchema.parse(config)).toEqual(config);
    expect(Object.keys(briefingConfigSchema.shape).sort()).toEqual(Object.keys(config).sort());
    expect(serverContract.setBriefingConfig.output).toBe(briefingConfigSchema);
  });

  it("setBriefingConfig：字段都可省略，越界拒绝，映射到同一份设置", () => {
    expect(setBriefingConfigSchema.safeParse({}).success).toBe(true);
    expect(setBriefingConfigSchema.safeParse({ dailyLimit: 5 }).success).toBe(false);
    expect(setBriefingConfigSchema.safeParse({ language: "jp" }).success).toBe(false);
    expect(
      briefingConfigToPatch({ enabled: false, language: "zh", gatewayUrl: "", gatewayModel: "m", fallbackModel: "sonnet", systemPrompt: "p", dailyLimit: 50, resetTodayCount: true, clearCooldowns: true }),
    ).toEqual({
      briefingEnabled: false,
      briefingLanguage: "zh",
      briefingGatewayUrl: "",
      briefingGatewayModel: "m",
      briefingModel: "sonnet",
      briefingSystemPrompt: "p",
      briefingDailyLimit: 50,
      resetTodayCount: true,
      clearCooldowns: true,
    });
    expect(briefingConfigToPatch({})).toEqual({});
  });

  it("briefing 输出里的速览对象可带 language 字段", () => {
    const view = serverContract.briefing.output.safeParse({
      briefing: { about: "a", stages: [{ title: "t", state: "done", note: "n" }], now: "x", waiting: null, next: null, version: BRIEFING_VERSION, language: "zh", outlineKey: "1:a", askCount: 1, generatedAt: 1 },
      freshness: { state: "fresh" },
      recap: { turns: 1, ask: null, reply: null },
      enabled: true,
    });
    expect(view.success && view.data.briefing?.language).toBe("zh");
  });
});
