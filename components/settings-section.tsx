/**
 * [INPUT]: 依赖 @get-bb/plugin-sdk/app 的 useRpc（读写本插件服务端的设置页 RPC）; 依赖 components/i18n 的 LanguageProvider / useT / useLang; 依赖 lib/settle 的本机 Settle 存储约定; 依赖 lib/i18n 的语言名与相对时间
 * [OUTPUT]: 对外提供 SettingsSection: 插件设置页里的面板——界面语言切换（自动 / English / 简体中文）、悬停速览的开关与运行状态（今日次数、通道、速览语言、最近一条、冷却与暂停，一键清冷却）、本机已搁置的对话数与“全部取消搁置”
 * [POS]: components 的设置页视图; 消费者: app.tsx（settingsSection 插槽）; 与 bb 声明式设置的边界: 改的是同一份 bb.settings（经 updateSettings RPC），bb plugin config 照常可用; 搁置记录只在本机浏览器，清掉后经事件通知侧边栏列表重读
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { applyLanguageLocally, LanguageProvider, useLang, useT } from "@/components/i18n";
import type { serverContract, SettingsStatus } from "@/lib/contract";
import { agoText, LANGUAGE_OPTION_LABELS, LANGUAGE_SETTINGS, relativeTime, type LanguageSetting } from "@/lib/i18n";
import { parseSettledMap, SETTLED_CHANGED_EVENT, SETTLED_STORAGE_KEY } from "@/lib/settle";

/** 状态多久刷新一次：队列、冷却、今日次数都会变，设置页开着时跟着动 */
const REFRESH_MS = 5_000;

export function SettingsSection() {
  return (
    <LanguageProvider>
      <SettingsBody />
    </LanguageProvider>
  );
}

function readSettledCount(): number {
  try {
    return Object.keys(parseSettledMap(localStorage.getItem(SETTLED_STORAGE_KEY))).length;
  } catch {
    return 0;
  }
}

function SettingsBody() {
  const tx = useT();
  const lang = useLang();
  const rpc = useRpc<typeof serverContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [failure, setFailure] = useState<"load" | "save" | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [settled, setSettled] = useState(readSettledCount);

  useEffect(() => {
    let alive = true;
    const load = () =>
      rpcRef.current.call("settingsStatus", {}).then(
        (next) => {
          if (!alive) return;
          setStatus(next);
          setNow(Date.now());
          setFailure((f) => (f === "load" ? null : f));
        },
        () => alive && setFailure("load"),
      );
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const reload = () => setSettled(readSettledCount());
    window.addEventListener(SETTLED_CHANGED_EVENT, reload);
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener(SETTLED_CHANGED_EVENT, reload);
      window.removeEventListener("storage", reload);
    };
  }, []);

  const act = useCallback(async (call: () => Promise<SettingsStatus>) => {
    setBusy(true);
    try {
      setStatus(await call());
      setNow(Date.now());
      setFailure(null);
    } catch {
      setFailure("save");
    } finally {
      setBusy(false);
    }
  }, []);

  const chooseLanguage = (language: LanguageSetting) => {
    // 先在本机生效（面板与侧边栏立即重画），再写进 bb.settings（与声明式设置、CLI 同一份）
    applyLanguageLocally(language);
    void act(() => rpcRef.current.call("updateSettings", { language }));
  };

  const unsettleAll = () => {
    try {
      localStorage.removeItem(SETTLED_STORAGE_KEY);
    } catch {
      // 读写不了本地存储时没有可清的
    }
    window.dispatchEvent(new Event(SETTLED_CHANGED_EVENT));
    setSettled(0);
  };

  const languageLabel = (option: LanguageSetting) => (option === "auto" ? tx.languageAuto : LANGUAGE_OPTION_LABELS[option]);
  const brief = status?.briefing;
  const last = brief?.last ?? null;
  const lastText = !last
    ? tx.lastNone
    : last.status === "failed"
      ? tx.lastFailed(agoText(last.at, now, lang))
      : last.via === "gateway"
        ? tx.lastGateway(last.model, agoText(last.at, now, lang))
        : tx.lastClaude(last.model, agoText(last.at, now, lang));
  const limitReached = brief ? brief.spentToday >= brief.dailyLimit : false;
  const stuck = brief ? brief.cooldowns.length > 0 || brief.retryWaiting > 0 || brief.pausedAt !== null : false;

  return (
    <div className="wl-set" data-busy={busy || undefined}>
      <header className="wl-set-intro">
        <h3 className="wl-set-heading">{tx.settingsTitle}</h3>
        <p className="wl-set-hint">{tx.settingsDescription}</p>
      </header>
      <section className="wl-set-block">
        <div className="wl-set-head">
          <span className="wl-set-title">{tx.setLanguage}</span>
          <div className="wl-set-seg" role="radiogroup" aria-label={tx.setLanguage}>
            {LANGUAGE_SETTINGS.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={status?.language === option}
                disabled={busy || status === null}
                onClick={() => chooseLanguage(option)}
              >
                {languageLabel(option)}
              </button>
            ))}
          </div>
        </div>
        <p className="wl-set-hint">{tx.setLanguageHint}</p>
      </section>

      <section className="wl-set-block">
        <div className="wl-set-head">
          <span className="wl-set-title">{tx.setBriefings}</span>
          <button
            type="button"
            role="switch"
            className="wl-set-switch"
            aria-checked={status?.briefingEnabled ?? false}
            aria-label={tx.setBriefingsSwitch}
            disabled={busy || status === null}
            onClick={() => status && void act(() => rpcRef.current.call("updateSettings", { briefingEnabled: !status.briefingEnabled }))}
          >
            <span className="wl-set-knob" />
            <span className="wl-set-switch-text">{status?.briefingEnabled ? tx.setOn : tx.setOff}</span>
          </button>
        </div>
        <p className="wl-set-hint">{tx.setBriefingsHint}</p>
        {status && brief ? (
          <dl className="wl-set-facts" data-off={!status.briefingEnabled || undefined}>
            <dt>{tx.setRoute}</dt>
            <dd>{status.gateway ? tx.routeGateway(status.gateway.models.join(" → ")) : tx.routeClaudeOnly(status.claudeModel)}</dd>
            <dt>{tx.setBriefingLanguage}</dt>
            <dd>{status.briefingLanguage === "en" ? tx.briefingLanguageEn : tx.briefingLanguageZh}</dd>
            <dt>{tx.setLast}</dt>
            <dd>
              {lastText}
              <span className="wl-set-quiet"> · {tx.setToday(brief.spentToday, brief.dailyLimit)}</span>
              {brief.queued > 0 ? <span className="wl-set-quiet"> · {tx.setQueue(brief.queued)}</span> : null}
            </dd>
            {limitReached ? (
              <>
                <dt />
                <dd className="wl-set-warn">{tx.setLimitReached}</dd>
              </>
            ) : null}
            {stuck ? (
              <>
                <dt>{tx.setCooling}</dt>
                <dd>
                  <ul className="wl-set-list">
                    {brief.cooldowns.map((cool) => (
                      <li key={cool.model ?? "*"}>
                        <span className="wl-set-mono">{cool.model ?? tx.coolingGateway}</span>
                        <span className="wl-set-quiet"> · {tx.coolingLeft(relativeTime(now, Math.max(cool.until, now + 60_000), lang))}</span>
                      </li>
                    ))}
                    {brief.retryWaiting > 0 ? <li>{tx.setRetry(brief.retryWaiting)}</li> : null}
                    {brief.pausedAt !== null ? <li>{tx.setPaused}</li> : null}
                  </ul>
                  <button type="button" className="wl-set-btn" disabled={busy} onClick={() => void act(() => rpcRef.current.call("resetBriefingCooldowns", {}))}>
                    {tx.setReset}
                  </button>
                </dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="wl-set-hint">{failure === "load" ? tx.setLoadFailed : tx.setLoading}</p>
        )}
      </section>

      <section className="wl-set-block">
        <div className="wl-set-head">
          <span className="wl-set-title">{tx.setSettled}</span>
          {settled > 0 ? (
            <button type="button" className="wl-set-btn" onClick={unsettleAll}>
              {tx.unsettleAll}
            </button>
          ) : null}
        </div>
        <p className="wl-set-hint">
          {settled > 0 ? tx.settledCount(settled) : tx.settledNone} · {tx.setSettledHint}
        </p>
      </section>

      {failure === "save" ? (
        <p className="wl-set-error" role="alert">
          {tx.setSaveFailed}
        </p>
      ) : null}
    </div>
  );
}
