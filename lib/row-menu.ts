/**
 * [INPUT]: 依赖 lib/i18n 的 Messages（菜单文案）; 依赖 lib/view 的 RowTone
 * [OUTPUT]: 对外提供 MENU_ICONS（插件注册给宿主的图标名）、settleMode（这一行该给 Settle、Unsettle 还是都不给）、threadMenuItems（并进 bb 线程菜单的插件项：长按 / 右键菜单与桌面“更多”菜单共用）、MenuItemSpec 类型
 * [POS]: lib 的行操作菜单纯逻辑; 消费者: components/lineage-list.tsx（桌面悬停按钮与长按 / 右键菜单共用同一条可见规则）、app.tsx（注册图标）; 与 bb 线程菜单的边界: bb 自己的操作（置顶、标记未读、重命名、重新生成标题、归档…）由宿主菜单给出，这里只组装插件追加的项
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import type { Messages } from "./i18n";
import type { RowTone } from "./view";

/** 插件在 app.tsx 里注册给宿主的图标名：宿主菜单的项只认图标名，不收组件 */
export const MENU_ICONS = {
  settle: "worktree-lineage-settle",
  unsettle: "worktree-lineage-unsettle",
  startHere: "worktree-lineage-plus",
} as const;

/** 宿主菜单的分组（与 experimental_THREAD_ACTION_GROUPS 同名）：在此新建归“打开”，搁置归“整理” */
const GROUP_OPEN = "1_open";
const GROUP_ORGANIZE = "2_organize";

export interface MenuItemSpec {
  key: string;
  group: string;
  label: string;
  /** 菜单项下面一行灰字 */
  detail?: string;
  icon: string;
}

/**
 * 一行对话该给哪个搁置操作：已搁置架子里的始终给 Unsettle；主列表里只有未置顶、空闲或完成未读的给 Settle
 * （运行中、等你、出错、有草稿的放进架子也会立刻被唤醒，给了也没意义）。桌面悬停按钮与长按 / 右键菜单共用这一条规则。
 */
export function settleMode(requested: "settle" | "unsettle" | undefined, tone: RowTone | null, pinned: boolean): "settle" | "unsettle" | null {
  if (requested === "unsettle") return "unsettle";
  if (requested === "settle" && !pinned && (tone === null || tone === "done")) return "settle";
  return null;
}

/** 并进 bb 线程菜单的插件项（排在宿主自己的操作所在分组的末尾） */
export function threadMenuItems(options: { settle: "settle" | "unsettle" | null; startHere: boolean }, tx: Messages): MenuItemSpec[] {
  const items: MenuItemSpec[] = [];
  if (options.startHere) items.push({ key: "worktree-lineage/start-here", group: GROUP_OPEN, label: tx.startHere, icon: MENU_ICONS.startHere });
  if (options.settle === "settle") {
    items.push({ key: "worktree-lineage/settle", group: GROUP_ORGANIZE, label: tx.settle, detail: tx.settleDetail, icon: MENU_ICONS.settle });
  } else if (options.settle === "unsettle") {
    items.push({ key: "worktree-lineage/unsettle", group: GROUP_ORGANIZE, label: tx.unsettle, detail: tx.unsettleDetail, icon: MENU_ICONS.unsettle });
  }
  return items;
}
