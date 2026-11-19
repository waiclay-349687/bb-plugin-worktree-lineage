/**
 * [INPUT]: 依赖 @get-bb/plugin-sdk/app 的 definePluginApp（threadList 与 settingsSection 插槽）; 依赖 components/settings-section; 导入 styles.css（随插件界面加载与卸载）; 依赖 components/i18n 的 readLanguageSync（注册时同步读界面语言）
 * [OUTPUT]: 默认导出插件前端入口: 注册线程菜单里插件项用的三个具名图标、experimental_threadList 槽位 "lineage" 与插件设置页的 settingsSection "overview"，标题与说明按界面语言
 * [POS]: 前端注册层; 消费者: bb 宿主; 与 components/lineage-list.tsx 的边界: 本文件只注册，不含界面逻辑; 槽位标题在注册时定下，改语言后下次加载界面时跟上（列表本身实时切换）
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import "./styles.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { readLanguageSync } from "@/components/i18n";
import { LineageList } from "@/components/lineage-list";
import { SettingsSection } from "@/components/settings-section";
import { glyphIcon } from "@/components/icons";
import { MENU_ICONS } from "@/lib/row-menu";
import { MESSAGES } from "@/lib/i18n";

export default definePluginApp((app) => {
  const tx = MESSAGES[readLanguageSync()];
  // bb 线程菜单（长按 / 右键 / 更多）里插件追加的项只认图标名：把插件自己的图形注册成具名图标
  app.experimental_icons.register({ name: MENU_ICONS.settle, component: glyphIcon("settle") });
  app.experimental_icons.register({ name: MENU_ICONS.unsettle, component: glyphIcon("unsettle") });
  app.experimental_icons.register({ name: MENU_ICONS.startHere, component: glyphIcon("plus") });
  app.slots.experimental_threadList({
    id: "lineage",
    title: tx.appTitle,
    description: tx.appDescription,
    component: LineageList,
  });
  // 插件设置页上的面板：语言、速览状态与开关、本机搁置记录。
  // 不交给宿主渲染标题：宿主标题在注册时定死，在设置页里切换语言后会和面板混成两种语言；标题由面板自己按当前语言画
  app.slots.settingsSection({ id: "overview", component: SettingsSection });
});
