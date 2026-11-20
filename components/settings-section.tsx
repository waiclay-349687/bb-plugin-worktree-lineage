/**
 * [INPUT]: 依赖 @get-bb/plugin-sdk/app 的 useRpc（读写本插件服务端的设置页 RPC）; 依赖 components/i18n 的 LanguageProvider / useT / useLang / applyLanguageLocally; 依赖 components/prefs 的 applyPrefsLocally; 依赖 lib/settle 的本机搁置存储约定; 依赖 lib/prefs 的范围; 依赖 lib/i18n 的文案、语言名与相对时间
 * [OUTPUT]: 对外提供 SettingsSection: 插件设置页里的完整设置面板——界面（语言、默认视图、悬停卡片开关与延迟）、悬停速览（开关、速览语言、网关地址与模型链、兜底模型、每天上限与清零、自定义提示词与填入 / 恢复默认、运行状态与清冷却）、本机已搁置的对话与“全部取消搁置”
 * [POS]: components 的设置页视图; 消费者: app.tsx（settingsSection 插槽）; 与 bb 声明式设置的边界: 改的是同一份 bb.settings（经 updateSettings RPC），bb plugin config 照常可用；面板覆盖了全部设置项，所以把宿主据 bb.settings 生成的英文表单行藏起来（卸载时还原），并把宿主的“Configuration”标题与插件说明换成当前语言
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { applyLanguageLocally, LanguageProvider, useLang, useT } from "@/components/i18n";
import { applyPrefsLocally } from "@/components/prefs";
import type { serverContract, SettingsPatch, SettingsStatus } from "@/lib/contract";
import { agoText, LANGUAGE_OPTION_LABELS, LANGUAGE_SETTINGS, MESSAGES, relativeTime, SETTINGS_TEXT, type LanguageSetting, type Messages } from "@/lib/i18n";
import { DAILY_LIMIT, PEEK_DELAY, PROMPT_MAX_LENGTH, type DefaultView } from "@/lib/prefs";
import { parseSettledMap, SETTLED_CHANGED_EVENT, SETTLED_STORAGE_KEY } from "@/lib/settle";

/** 状态多久刷新一次：队列、冷却、今日次数都会变，设置页开着时跟着动 */
const REFRESH_MS = 5_000;
/** 宿主据 package.json 显示的插件说明（英文），面板挂载时换成当前语言 */
const PACKAGE_DESCRIPTION = "A sidebar thread list laid out by where the code came from: Conversation and Branch Tree views, hover briefings, Settle and attention jumps.";

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

/**
 * 面板覆盖了全部设置项：藏起宿主据 bb.settings 生成的同名英文表单行（只藏本插件声明的那几项），整张表单卡片空了就连卡片一起藏；
 * 宿主的“Configuration”标题与插件说明换成当前语言。卸载时全部还原（bb plugin config 与设置存储不受影响）。
 */
function useHostSettingsChrome(tx: Messages) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = ref.current;
    const section = panel?.closest("[data-resource-detail-section]");
    if (!panel || !section) return;
    const labels = new Set(Object.values(SETTINGS_TEXT).map((field) => field.label));
    const restore = new Map<Element, () => void>();
    const hide = (el: HTMLElement) => {
      if (restore.has(el)) return;
      const previous = el.style.display;
      el.style.display = "none";
      restore.set(el, () => {
        el.style.display = previous;
      });
    };
    const setText = (el: Element, next: string, original: string) => {
      if (el.textContent === next) return;
      el.textContent = next;
      if (!restore.has(el)) restore.set(el, () => {
        el.textContent = original;
      });
    };
    // 宿主的表单比面板晚渲染（设置值要先取回来），所以套用一次不够：每次 section 里的结构变了都再套一遍（幂等）
    const apply = () => {
      const rows = (Array.from(section.querySelectorAll("[data-settings-anchor]")) as HTMLElement[]).filter((row) => labels.has(row.getAttribute("data-settings-anchor") ?? ""));
      rows.forEach(hide);
      // 表单卡片：包着这些行、又不包着面板的最外一层；里面的行全藏了就把卡片也藏掉
      let card = rows[0]?.parentElement ?? null;
      while (card && card.parentElement && card.parentElement !== section && !card.parentElement.contains(panel)) card = card.parentElement;
      if (card && !card.contains(panel) && (Array.from(card.querySelectorAll("[data-settings-anchor]")) as HTMLElement[]).every((row) => row.style.display === "none")) hide(card);
      const heading = section.querySelector("h2, h3");
      if (heading && (heading.textContent === MESSAGES.en.setConfigurationHeading || heading.textContent === MESSAGES.zh.setConfigurationHeading)) setText(heading, tx.setConfigurationHeading, MESSAGES.en.setConfigurationHeading);
      const detail = section.closest('[data-testid^="plugin-detail"]') ?? section.parentElement?.parentElement;
      const known = new Set([PACKAGE_DESCRIPTION, MESSAGES.en.appDescription, MESSAGES.zh.appDescription]);
      const description = detail ? Array.from(detail.querySelectorAll("p, span")).find((node) => known.has(node.textContent ?? "")) : undefined;
      if (description) setText(description, tx.appDescription, PACKAGE_DESCRIPTION);
    };
    apply();
    // 只看结构变化（不看属性）：自己改 style 不会再触发自己
    const observer = new MutationObserver(apply);
    observer.observe(section.parentElement ?? section, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      Array.from(restore.values()).reverse().forEach((undo) => undo());
    };
  }, [tx]);
  return ref;
}

/* ── 小控件 ───────────────────────────────────────────────── */

function Seg<T extends string>({ label, value, options, disabled, onChange }: { label: string; value: T | undefined; options: { value: T; label: string }[]; disabled: boolean; onChange: (next: T) => void }) {
  return (
    <div className="wl-set-seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value} disabled={disabled} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Switch({ label, checked, disabled, onChange, tx }: { label: string; checked: boolean; disabled: boolean; onChange: (next: boolean) => void; tx: Messages }) {
  return (
    <button type="button" role="switch" className="wl-set-switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="wl-set-knob" />
      <span className="wl-set-switch-text">{checked ? tx.setOn : tx.setOff}</span>
    </button>
  );
}

type FieldError = { kind: "required" } | { kind: "range"; min: number; max: number } | null;
const errorText = (tx: Messages, error: FieldError) => (!error ? null : error.kind === "required" ? tx.setRequired : tx.setInvalidNumber(error.min, error.max));

function Row({ label, hint, children, error }: { label: string; hint?: string; children: ReactNode; error?: string | null }) {
  return (
    <div className="wl-set-row">
      <div className="wl-set-row-head">
        <span className="wl-set-label">{label}</span>
        {children}
      </div>
      {error ? <p className="wl-set-field-error">{error}</p> : hint ? <p className="wl-set-hint">{hint}</p> : null}
    </div>
  );
}

/** 文本框：失焦或回车时提交（值变了才提交）；正在编辑时不被定时刷新覆盖 */
function TextField({ label, hint, value, required, disabled, onCommit, tx, mono = false }: { label: string; hint?: string; value: string; required?: boolean; disabled: boolean; onCommit: (next: string) => void; tx: Messages; mono?: boolean }) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<FieldError>(null);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (required && next === "") {
      setError({ kind: "required" });
      setDraft(value);
      return;
    }
    setError(null);
    if (next !== value) onCommit(next);
  };
  return (
    <Row label={label} hint={hint} error={errorText(tx, error)}>
      <input
        className="wl-set-input"
        data-mono={mono || undefined}
        value={draft}
        aria-label={label}
        disabled={disabled}
        spellCheck={false}
        onFocus={() => setEditing(true)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
      />
    </Row>
  );
}

/** 整数框：失焦或回车时校验范围再提交，越界给出提示、不提交 */
function NumberField({ label, hint, value, range, unit, disabled, onCommit, tx, children }: { label: string; hint?: string; value: number; range: { min: number; max: number }; unit?: string; disabled: boolean; onCommit: (next: number) => void; tx: Messages; children?: ReactNode }) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<FieldError>(null);
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);
  const commit = () => {
    setEditing(false);
    const n = Number(draft.trim());
    if (!Number.isInteger(n) || n < range.min || n > range.max) {
      setError({ kind: "range", min: range.min, max: range.max });
      setDraft(String(value));
      return;
    }
    setError(null);
    if (n !== value) onCommit(n);
  };
  return (
    <Row label={label} hint={hint} error={errorText(tx, error)}>
      <span className="wl-set-inline">
        <input
          className="wl-set-input wl-set-number"
          inputMode="numeric"
          value={draft}
          aria-label={label}
          disabled={disabled}
          onFocus={() => setEditing(true)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        {unit ? <span className="wl-set-quiet">{unit}</span> : null}
        {children}
      </span>
    </Row>
  );
}

/** 自定义提示词：多行编辑，点保存才提交；“填入默认”把当前速览语言的内置提示词放进编辑框，“恢复默认”清空并保存 */
function PromptField({ value, defaultPrompt, disabled, onCommit, tx }: { value: string; defaultPrompt: string; disabled: boolean; onCommit: (next: string) => void; tx: Messages }) {
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(false);
  const dirty = draft !== value;
  useEffect(() => {
    if (!dirty) setDraft(value);
    // 只在服务端值变化时同步；正在改的不覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 1600);
    return () => clearTimeout(timer);
  }, [saved]);
  const save = (next: string) => {
    onCommit(next);
    setSaved(true);
  };
  return (
    <div className="wl-set-row">
      <div className="wl-set-row-head">
        <span className="wl-set-label">{tx.setPrompt}</span>
        <span className="wl-set-inline">
          <button type="button" className="wl-set-btn" disabled={disabled} onClick={() => setDraft(defaultPrompt)}>
            {tx.setPromptFillDefault}
          </button>
          <button type="button" className="wl-set-btn" disabled={disabled || (value === "" && draft === "")} onClick={() => { setDraft(""); save(""); }}>
            {tx.setPromptRestore}
          </button>
        </span>
      </div>
      <textarea
        className="wl-set-textarea"
        value={draft}
        placeholder={tx.setPromptPlaceholder}
        aria-label={tx.setPrompt}
        maxLength={PROMPT_MAX_LENGTH}
        rows={draft === "" ? 3 : 10}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="wl-set-row-head">
        <p className="wl-set-hint">{tx.setPromptHint}</p>
        <span className="wl-set-inline">
          <span className="wl-set-quiet">{saved ? tx.setSaved : tx.setPromptLength(draft.length, PROMPT_MAX_LENGTH)}</span>
          <button type="button" className="wl-set-btn" data-primary={dirty || undefined} disabled={disabled || !dirty} onClick={() => save(draft.trim() === "" ? "" : draft)}>
            {tx.setSave}
          </button>
        </span>
      </div>
    </div>
  );
}

/* ── 面板 ─────────────────────────────────────────────────── */

function SettingsBody() {
  const tx = useT();
  const lang = useLang();
  const chrome = useHostSettingsChrome(tx);
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

  /** 所有改动都走这一个入口：写进 bb.settings（与声明式设置、CLI 同一份），返回最新状态 */
  const update = useCallback(async (patch: SettingsPatch) => {
    setBusy(true);
    try {
      setStatus(await rpcRef.current.call("updateSettings", patch));
      setNow(Date.now());
      setFailure(null);
    } catch {
      setFailure("save");
    } finally {
      setBusy(false);
    }
  }, []);

  const values = status?.values;
  const brief = status?.briefing;
  const disabled = busy || status === null;

  const chooseLanguage = (language: LanguageSetting) => {
    // 先在本机生效（面板与侧边栏立即重画），再写进 bb.settings
    applyLanguageLocally(language);
    void update({ language });
  };
  const setPrefs = (patch: { peekEnabled?: boolean; peekDelayMs?: number; defaultView?: DefaultView }) => {
    applyPrefsLocally(patch);
    void update(patch);
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

  const languageOptions = (auto: string) => LANGUAGE_SETTINGS.map((value) => ({ value, label: value === "auto" ? auto : LANGUAGE_OPTION_LABELS[value] }));
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
    <div className="wl-set" ref={chrome} data-busy={busy || undefined}>
      <header className="wl-set-intro">
        <h3 className="wl-set-heading">{tx.settingsTitle}</h3>
        <p className="wl-set-hint">{tx.settingsDescription}</p>
      </header>

      <section className="wl-set-block">
        <span className="wl-set-title">{tx.setInterface}</span>
        <Row label={tx.setLanguage} hint={tx.setLanguageHint}>
          <Seg label={tx.setLanguage} value={values?.language} options={languageOptions(tx.languageAuto)} disabled={disabled} onChange={chooseLanguage} />
        </Row>
        <Row label={tx.setDefaultView}>
          <Seg<DefaultView>
            label={tx.setDefaultView}
            value={values?.defaultView}
            options={[
              { value: "conversations", label: tx.viewConversations },
              { value: "branch-tree", label: tx.viewTree },
            ]}
            disabled={disabled}
            onChange={(defaultView) => setPrefs({ defaultView })}
          />
        </Row>
        <Row label={tx.setPeek} hint={tx.setPeekHint}>
          <Switch label={tx.setPeek} checked={values?.peekEnabled ?? true} disabled={disabled} onChange={(peekEnabled) => setPrefs({ peekEnabled })} tx={tx} />
        </Row>
        {values ? (
          <NumberField label={tx.setPeekDelay} value={values.peekDelayMs} range={PEEK_DELAY} unit={tx.msUnit} disabled={disabled || !values.peekEnabled} onCommit={(peekDelayMs) => setPrefs({ peekDelayMs })} tx={tx} />
        ) : null}
      </section>

      <section className="wl-set-block">
        <div className="wl-set-head">
          <span className="wl-set-title">{tx.setBriefings}</span>
          <Switch label={tx.setBriefingsSwitch} checked={values?.briefingEnabled ?? false} disabled={disabled} onChange={(briefingEnabled) => void update({ briefingEnabled })} tx={tx} />
        </div>
        <p className="wl-set-hint">{tx.setBriefingsHint}</p>
        {status && values && brief ? (
          <>
            <Row label={tx.setBriefingLanguage} hint={tx.setBriefingLanguageHint}>
              <Seg label={tx.setBriefingLanguage} value={values.briefingLanguage} options={languageOptions(tx.languageAutoInterface)} disabled={disabled} onChange={(briefingLanguage) => void update({ briefingLanguage })} />
            </Row>
            <TextField label={tx.setGatewayUrl} hint={tx.setGatewayUrlHint} value={values.briefingGatewayUrl} disabled={disabled} mono onCommit={(briefingGatewayUrl) => void update({ briefingGatewayUrl })} tx={tx} />
            <TextField label={tx.setGatewayModels} hint={tx.setGatewayModelsHint} value={values.briefingGatewayModel} disabled={disabled} mono onCommit={(briefingGatewayModel) => void update({ briefingGatewayModel })} tx={tx} />
            <TextField label={tx.setFallbackModel} value={values.briefingModel} required disabled={disabled} mono onCommit={(briefingModel) => void update({ briefingModel })} tx={tx} />
            <NumberField label={tx.setDailyLimit} value={values.briefingDailyLimit} range={DAILY_LIMIT} disabled={disabled} onCommit={(briefingDailyLimit) => void update({ briefingDailyLimit })} tx={tx}>
              <span className="wl-set-quiet">{tx.setToday(brief.spentToday, brief.dailyLimit)}</span>
              <button type="button" className="wl-set-btn" disabled={disabled || brief.spentToday === 0} onClick={() => void update({ resetTodayCount: true })}>
                {tx.setResetCount}
              </button>
            </NumberField>
            <PromptField value={values.briefingSystemPrompt} defaultPrompt={status.defaultPrompts[status.briefingLanguage]} disabled={disabled} onCommit={(briefingSystemPrompt) => void update({ briefingSystemPrompt })} tx={tx} />

            <dl className="wl-set-facts" data-off={!status.briefingEnabled || undefined}>
              <dt>{tx.setRoute}</dt>
              <dd>{status.gateway ? tx.routeGateway(status.gateway.models.join(" → ")) : tx.routeClaudeOnly(status.claudeModel)}</dd>
              <dt>{tx.setBriefingLanguage}</dt>
              <dd>{status.briefingLanguage === "en" ? tx.briefingLanguageEn : tx.briefingLanguageZh}</dd>
              <dt>{tx.setLast}</dt>
              <dd>
                {lastText}
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
                    <button type="button" className="wl-set-btn" disabled={disabled} onClick={() => void update({ clearCooldowns: true })}>
                      {tx.setReset}
                    </button>
                  </dd>
                </>
              ) : null}
            </dl>
          </>
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
