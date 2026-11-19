/**
 * [INPUT]: 无外部依赖（内联 SVG，颜色取 currentColor）
 * [OUTPUT]: 对外提供 Glyph: 本插件自绘的一组 16 格线性图标; glyphIcon(name): 把一个图形包成按 className 定尺寸的组件，供 app.tsx 注册成宿主图标（行操作菜单只认图标名）
 * [POS]: components 的图标集; 消费者: components/lineage-list.tsx、components/peek.tsx、app.tsx（注册菜单图标）; 自绘而不用宿主图标表，是因为宿主表不含完整 lucide，缺名会回退成闪电
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import type { ReactNode } from "react";

/** 统一 16×16 视框、1.5 描边、圆头圆角，和 bb 自己的线性图标同一种笔触 */
const PATHS = {
  /** 分支：主干 + 分出的一支 */
  branch: (
    <>
      <circle cx="4.5" cy="3.75" r="1.75" />
      <circle cx="4.5" cy="12.25" r="1.75" />
      <circle cx="11.5" cy="5.25" r="1.75" />
      <path d="M4.5 5.5v5M11.5 7c0 2.6-2.2 3.2-4.4 3.4-1.3.1-2.6.5-2.6 1.6" />
    </>
  ),
  /** 主检出 */
  home: <path d="M2.75 7.4 8 3l5.25 4.4v5.1a.75.75 0 0 1-.75.75h-2.75V9.5h-3.5v3.75H3.5a.75.75 0 0 1-.75-.75z" />,
  /** 分离 HEAD：一个提交点 */
  commit: (
    <>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M1.75 8h3.75M10.5 8h3.75" />
    </>
  ),
  /** 派出了子对话 */
  dispatch: (
    <>
      <circle cx="8" cy="3.5" r="1.6" />
      <circle cx="3.75" cy="12.5" r="1.6" />
      <circle cx="12.25" cy="12.5" r="1.6" />
      <path d="M8 5.1v2.4M3.75 10.9c0-1.9 1.4-3.4 4.25-3.4s4.25 1.5 4.25 3.4" />
    </>
  ),
  /** 上级在别处：指回去 */
  origin: <path d="M12.5 12.5v-4a3 3 0 0 0-3-3h-6M6.5 2.5l-3 3 3 3" />,
  chevron: <path d="m6 3.5 4.5 4.5L6 12.5" />,
  plus: <path d="M8 3.25v9.5M3.25 8h9.5" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.25 10.25 3 3" />
    </>
  ),
  more: (
    <>
      <circle cx="3.5" cy="8" r=".9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r=".9" fill="currentColor" stroke="none" />
    </>
  ),
  refresh: <path d="M13.25 8a5.25 5.25 0 0 1-9.4 3.2M2.75 8a5.25 5.25 0 0 1 9.4-3.2M12.5 2v3h-3M3.5 14v-3h3" />,
  pin: <path d="M9.5 2.25 13.75 6.5l-2 .6-2.3 2.3.2 3.1-1.2 1.2-2.9-2.9-3.3 3.2M5.55 10.45 2.6 7.5l1.2-1.2 3.1.2 2.3-2.3z" />,
  /** 速览里的阶段：做完了 / 放弃了 */
  check: <path d="m3.5 8.6 3 3 6-7" />,
  dash: <path d="M4.5 8h7" />,
  /** 已合回 */
  merged: (
    <>
      <circle cx="4.5" cy="3.75" r="1.75" />
      <circle cx="4.5" cy="12.25" r="1.75" />
      <circle cx="11.5" cy="8.5" r="1.75" />
      <path d="M4.5 5.5v5M4.6 5.5c.3 2 2 3 5.15 3" />
    </>
  ),
  /** Settle：收进 Settled 架子（不归档不删环境） */
  settle: (
    <>
      <path d="M2.75 9.5v2.25a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5V9.5" />
      <path d="m5.5 6.5 2.25 2.25 3.75-4.5" />
    </>
  ),
  /** Unsettle：从 Settled 架子移回主列表 */
  unsettle: (
    <>
      <path d="M2.75 9.5v2.25a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5V9.5" />
      <path d="M8 9.25V3m0 0L5.5 5.5M8 3l2.5 2.5" />
    </>
  ),
  /** 复制安全清理命令 */
  terminal: (
    <>
      <rect x="2.25" y="3" width="11.5" height="10" rx="1.75" />
      <path d="m5.25 6.5 2 1.75-2 1.75M8.75 10h2" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type GlyphName = keyof typeof PATHS;

export function Glyph({ name, size = 14, className }: { name: GlyphName; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={{ flex: "none" }}
    >
      {PATHS[name]}
    </svg>
  );
}

/** 注册给宿主的图标：宿主按 className 定尺寸、用 currentColor 着色（菜单里的项只认图标名） */
export function glyphIcon(name: GlyphName) {
  function RegisteredGlyph({ className }: { className?: string }) {
    return (
      <svg viewBox="0 0 16 16" className={className ?? "size-4"} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {PATHS[name]}
      </svg>
    );
  }
  RegisteredGlyph.displayName = `Glyph(${name})`;
  return RegisteredGlyph;
}
