/**
 * [INPUT]: 依赖 lib/i18n 的 LanguageSetting 与 isLanguageSetting
 * [OUTPUT]: 对外提供插件全部设置项的取值约定：DAILY_LIMIT / PEEK_DELAY（范围与默认值）、DEFAULT_VIEWS、DEFAULT_GATEWAY_URL / DEFAULT_GATEWAY_MODELS / DEFAULT_CLAUDE_MODEL、PROMPT_MAX_LENGTH、clampInt、normalizeSettings（bb.settings 原始值 → 合法值）、resolveBriefingLanguage（速览语言独立解析）、SettingsValues 类型
 * [POS]: lib 的设置取值层，纯函数; 消费者: server.ts（读设置时收紧）、lib/contract.ts（RPC 的范围校验）、components（面板与列表的默认值）; 与 bb.settings 的边界: bb.settings 是唯一的存储，CLI 写进去的值可能越界，读的时候在这里收紧，不在别处各自判断
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import { isLanguageSetting, type Lang, type LanguageSetting } from "./i18n";

export const DAILY_LIMIT = { min: 10, max: 2000, default: 300 } as const;
export const PEEK_DELAY = { min: 100, max: 1500, default: 450 } as const;
export const DEFAULT_VIEWS = ["conversations", "branch-tree"] as const;
export type DefaultView = (typeof DEFAULT_VIEWS)[number];
/** 自定义提示词的长度上限：提示词是给小模型的，再长也没用，还白占额度 */
export const PROMPT_MAX_LENGTH = 8000;

/** 速览优先走本机 Magpie 网关上的模型链，不行再回退本机 claude；付费直连的模型不进默认链 */
export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:3425";
export const DEFAULT_GATEWAY_MODELS = ["workbuddy/deepseek-v4.1-flash", "opencode-zen/deepseek-v4.1-flash-free"];
export const DEFAULT_CLAUDE_MODEL = "haiku";

export interface SettingsValues {
  language: LanguageSetting;
  briefingEnabled: boolean;
  /** 速览语言：auto = 跟随界面语言 */
  briefingLanguage: LanguageSetting;
  briefingGatewayUrl: string;
  briefingGatewayModel: string;
  briefingModel: string;
  briefingSystemPrompt: string;
  briefingDailyLimit: number;
  peekEnabled: boolean;
  peekDelayMs: number;
  defaultView: DefaultView;
}

/** 整数夹进范围；不是有限数字时用默认值 */
export function clampInt(value: unknown, range: { min: number; max: number; default: number }): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return range.default;
  return Math.min(range.max, Math.max(range.min, Math.round(n)));
}

const str = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

/** bb.settings 的原始值 → 合法值：枚举不认识的回默认，数字夹进范围，提示词截到上限 */
export function normalizeSettings(raw: Readonly<Record<string, unknown>>): SettingsValues {
  return {
    language: isLanguageSetting(raw.language) ? raw.language : "auto",
    briefingEnabled: bool(raw.briefingEnabled, true),
    briefingLanguage: isLanguageSetting(raw.briefingLanguage) ? raw.briefingLanguage : "auto",
    briefingGatewayUrl: str(raw.briefingGatewayUrl, DEFAULT_GATEWAY_URL),
    briefingGatewayModel: str(raw.briefingGatewayModel, DEFAULT_GATEWAY_MODELS.join(", ")),
    briefingModel: str(raw.briefingModel, DEFAULT_CLAUDE_MODEL),
    briefingSystemPrompt: str(raw.briefingSystemPrompt, "").slice(0, PROMPT_MAX_LENGTH),
    briefingDailyLimit: clampInt(raw.briefingDailyLimit, DAILY_LIMIT),
    peekEnabled: bool(raw.peekEnabled, true),
    peekDelayMs: clampInt(raw.peekDelayMs, PEEK_DELAY),
    defaultView: (DEFAULT_VIEWS as readonly unknown[]).includes(raw.defaultView) ? (raw.defaultView as DefaultView) : "conversations",
  };
}

/**
 * 速览实际用的语言：速览语言单独设了 en / zh 就用它（例如英文界面配中文速览）；
 * auto 跟随界面语言：界面设了 en / zh 用界面的，界面也是 auto 时用前端报上来的浏览器 / BB 语言。
 */
export function resolveBriefingLanguage(briefing: LanguageSetting, ui: LanguageSetting, reportedUi: Lang): Lang {
  if (briefing === "en" || briefing === "zh") return briefing;
  if (ui === "en" || ui === "zh") return ui;
  return reportedUi;
}
