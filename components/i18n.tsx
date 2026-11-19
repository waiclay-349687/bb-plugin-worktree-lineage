/**
 * [INPUT]: 依赖 @get-bb/plugin-sdk/app 的 useSettings（插件设置的实时值）与 useRpc（向服务端报告解析出的语言）; 依赖 lib/i18n 的 resolveLanguage / MESSAGES
 * [OUTPUT]: 对外提供 LanguageProvider（在列表根部解析一次语言并向下提供）、useT（当前语言的界面词典）、useLang（当前语言 en | zh）、readLanguageSync（挂载前同步读语言，给 app.tsx 的槽位标题用）、applyLanguageLocally / LANGUAGE_CHANGED_EVENT（设置面板切换后让同一页面立即重画）
 * [POS]: components 的语言层; 消费者: components/lineage-list.tsx、components/peek.tsx（悬停卡片经 portal 渲染，仍在 Provider 之内）、app.tsx; 与 lib/i18n 的边界: 文案与解析规则在 lib（纯函数、可单测），这里只接 React 与宿主
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { serverContract } from "@/lib/contract";
import { isLanguageSetting, LANGUAGE_STORAGE_KEY, MESSAGES, resolveLanguage, type Lang, type LanguageSetting, type Messages } from "@/lib/i18n";

/**
 * 宿主语言：先看 BB 界面自己的语言（<html lang>），为空时才看浏览器语言。
 * “自动”跟的是 BB 界面而不是操作系统：英文 BB 里就是英文，与同系列的 usage-rings、session-cockpit 一致；
 * 想在英文 BB 里用中文，在设置里选 zh。
 */
function hostLanguages(): string[] {
  const html = typeof document !== "undefined" ? document.documentElement.lang : "";
  const browser = typeof navigator !== "undefined" ? [navigator.language, ...(navigator.languages ?? [])] : [];
  return [html, ...browser];
}

function readMirror(): LanguageSetting {
  try {
    const value = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguageSetting(value) ? value : "auto";
  } catch {
    return "auto";
  }
}

/** 设置面板切换语言后派发：同一页面里的列表与面板立即按新语言重画 */
export const LANGUAGE_CHANGED_EVENT = "worktree-lineage:language-changed";

/** 写镜像并通知同一页面：设置面板切换语言时调用（随后再写进 bb.settings） */
export function applyLanguageLocally(setting: LanguageSetting): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, setting);
  } catch {
    // 隐私模式或存储满时忽略
  }
  window.dispatchEvent(new Event(LANGUAGE_CHANGED_EVENT));
}

/** 不经 React 同步读出语言：设置值用 localStorage 里的镜像（上次运行时写下的） */
export function readLanguageSync(): Lang {
  return resolveLanguage(readMirror(), hostLanguages());
}

const LangContext = createContext<Lang>("en");

/**
 * 在列表根部解析一次语言：插件设置的实时值优先（设置页改完立刻生效），还没取到时用 localStorage 镜像，
 * 两者都是 auto 时按宿主语言（BB 界面的 <html lang> 优先，为空才看浏览器）。解析结果报给服务端（auto 模式下速览用哪种语言只有前端知道）。
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const settings = useSettings();
  const raw = settings.values?.language;
  /*
   * 渲染以本机镜像为准，两个来源都会更新它：
   * - bb.settings 的值变了（页面加载、CLI、声明式设置）：写进镜像
   * - 设置面板点了切换器：面板写镜像并派发 LANGUAGE_CHANGED_EVENT（useSettings 不会实时推送，实测点完后不变）
   * 别的标签页改了镜像时经 storage 事件跟上
   */
  const [setting, setSetting] = useState<LanguageSetting>(() => (isLanguageSetting(raw) ? raw : readMirror()));
  useEffect(() => {
    if (!isLanguageSetting(raw)) return;
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, raw);
    } catch {
      // 隐私模式或存储满时忽略
    }
    setSetting(raw);
  }, [raw]);
  useEffect(() => {
    const reload = () => setSetting(readMirror());
    const onStorage = (event: StorageEvent) => {
      if (event.key === LANGUAGE_STORAGE_KEY) reload();
    };
    window.addEventListener(LANGUAGE_CHANGED_EVENT, reload);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(LANGUAGE_CHANGED_EVENT, reload);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  const lang = resolveLanguage(setting, hostLanguages());

  // 报告给服务端：挂载时、语言变化时、窗口重新获得焦点时（开着几个语言不同的窗口时，正在用的那个说了算）
  const rpc = useRpc<typeof serverContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  useEffect(() => {
    const report = () => void rpcRef.current.call("reportLanguage", { language: lang }).catch(() => undefined);
    report();
    window.addEventListener("focus", report);
    return () => window.removeEventListener("focus", report);
  }, [lang]);

  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>;
}

export function useLang(): Lang {
  return useContext(LangContext);
}

export function useT(): Messages {
  const lang = useLang();
  return useMemo(() => MESSAGES[lang], [lang]);
}
