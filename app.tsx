/**
 * [INPUT]: 依赖 @get-bb/plugin-sdk/app 的 definePluginApp; 导入 styles.css（随插件界面加载与卸载）; 依赖 components/i18n 的 readLanguageSync（注册时同步读界面语言）
 * [OUTPUT]: 默认导出插件前端入口: 注册 experimental_threadList 槽位 "lineage"，标题与说明按界面语言
 * [POS]: 前端注册层; 消费者: bb 宿主; 与 components/lineage-list.tsx 的边界: 本文件只注册，不含界面逻辑; 槽位标题在注册时定下，改语言后下次加载界面时跟上（列表本身实时切换）
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import "./styles.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { readLanguageSync } from "@/components/i18n";
import { LineageList } from "@/components/lineage-list";
import { MESSAGES } from "@/lib/i18n";

export default definePluginApp((app) => {
  const tx = MESSAGES[readLanguageSync()];
  app.slots.experimental_threadList({
    id: "lineage",
    title: tx.appTitle,
    description: tx.appDescription,
    component: LineageList,
  });
});
