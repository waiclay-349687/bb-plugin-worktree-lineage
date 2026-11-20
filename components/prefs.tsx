/**
 * [INPUT]: 依赖 @get-bb/plugin-sdk/app 的 useSettings（插件设置值，页面加载时取得）; 依赖 lib/prefs 的取值约定与 normalizeSettings
 * [OUTPUT]: 对外提供 usePluginPrefs（侧边栏行为：悬停卡片开关、悬停延迟、默认视图）、applyPrefsLocally（设置面板改完后让同一页面立即生效）、PREFS_STORAGE_KEY、PREFS_CHANGED_EVENT、ListPrefs 类型
 * [POS]: components 的侧边栏行为偏好层; 消费者: components/lineage-list.tsx（读）、components/settings-section.tsx（写后通知）; 与 components/i18n 的边界: 语言单独走 LanguageProvider，这里只管列表行为
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import { useEffect, useState } from "react";
import { useSettings } from "@get-bb/plugin-sdk/app";
import { normalizeSettings, type DefaultView } from "@/lib/prefs";

export interface ListPrefs {
  peekEnabled: boolean;
  peekDelayMs: number;
  defaultView: DefaultView;
}

/** 本机镜像：挂载时同步读，第一帧就是对的；useSettings 不会实时推送，设置面板改完靠事件通知 */
export const PREFS_STORAGE_KEY = "worktree-lineage.prefs";
export const PREFS_CHANGED_EVENT = "worktree-lineage:prefs-changed";

const pick = (raw: Readonly<Record<string, unknown>>): ListPrefs => {
  const values = normalizeSettings(raw);
  return { peekEnabled: values.peekEnabled, peekDelayMs: values.peekDelayMs, defaultView: values.defaultView };
};

function readMirror(): ListPrefs {
  try {
    return pick(JSON.parse(localStorage.getItem(PREFS_STORAGE_KEY) ?? "{}") as Record<string, unknown>);
  } catch {
    return pick({});
  }
}

function writeMirror(prefs: ListPrefs): void {
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // 隐私模式或存储满时忽略
  }
}

/** 设置面板改完侧边栏行为后调用：写镜像并通知同一页面（随后再写进 bb.settings） */
export function applyPrefsLocally(patch: Partial<ListPrefs>): void {
  writeMirror({ ...readMirror(), ...patch });
  window.dispatchEvent(new Event(PREFS_CHANGED_EVENT));
}

/** 侧边栏行为偏好：bb.settings 的值变了（页面加载、CLI）写进镜像；设置面板改了经事件跟上；别的标签页经 storage 事件跟上 */
export function usePluginPrefs(): ListPrefs {
  const settings = useSettings();
  const values = settings.values;
  const [prefs, setPrefs] = useState<ListPrefs>(() => (values ? pick(values) : readMirror()));
  const signature = values ? JSON.stringify(pick(values)) : null;
  useEffect(() => {
    if (!signature) return;
    const next = JSON.parse(signature) as ListPrefs;
    writeMirror(next);
    setPrefs(next);
  }, [signature]);
  useEffect(() => {
    const reload = () => setPrefs(readMirror());
    const onStorage = (event: StorageEvent) => {
      if (event.key === PREFS_STORAGE_KEY) reload();
    };
    window.addEventListener(PREFS_CHANGED_EVENT, reload);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(PREFS_CHANGED_EVENT, reload);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return prefs;
}
