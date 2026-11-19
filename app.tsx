/**
 * [INPUT]: 依赖 @get-bb/plugin-sdk/app 的 definePluginApp; 导入 styles.css（随插件界面加载与卸载）
 * [OUTPUT]: 默认导出插件前端入口: 注册 experimental_threadList 槽位 "lineage"
 * [POS]: 前端注册层; 消费者: bb 宿主; 与 components/lineage-list.tsx 的边界: 本文件只注册，不含界面逻辑
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import "./styles.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { LineageList } from "@/components/lineage-list";

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "lineage",
    title: "Worktree 血缘",
    description: "按“代码从哪来”排列：分支树为主干，对话挂在所在 worktree 下，标注谁派的、是否已合回。",
    component: LineageList,
  });
});
