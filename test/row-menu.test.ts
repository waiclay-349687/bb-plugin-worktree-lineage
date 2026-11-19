import { describe, expect, it } from "vitest";
import { MESSAGES } from "../lib/i18n";
import { branchMenuItems, MENU_ICONS, settleMode, threadMenuItems } from "../lib/row-menu";

const HAN = /[一-鿿]/;

describe("settleMode（桌面悬停按钮与手机菜单共用的可见规则）", () => {
  it("已搁置架子里始终给“取消搁置”，不论状态与置顶", () => {
    expect(settleMode("unsettle", "running", true)).toBe("unsettle");
    expect(settleMode("unsettle", null, false)).toBe("unsettle");
  });

  it("主列表里只有未置顶、空闲或完成未读的给“搁置”", () => {
    expect(settleMode("settle", null, false)).toBe("settle");
    expect(settleMode("settle", "done", false)).toBe("settle");
    expect(settleMode("settle", null, true)).toBeNull();
    for (const tone of ["running", "attention", "error", "draft"] as const) expect(settleMode("settle", tone, false)).toBeNull();
  });

  it("没传（子对话、分支树里的对话）就都不给", () => {
    expect(settleMode(undefined, null, false)).toBeNull();
  });
});

describe("threadMenuItems（并进 bb 线程菜单的插件项）", () => {
  it("可搁置的对话：在此新建（打开分组）+ 搁置（整理分组），用插件注册的图标", () => {
    const items = threadMenuItems({ settle: "settle", startHere: true }, MESSAGES.en);
    expect(items.map((i) => [i.key, i.group, i.label, i.icon])).toEqual([
      ["worktree-lineage/start-here", "1_open", "New thread in this worktree", MENU_ICONS.startHere],
      ["worktree-lineage/settle", "2_organize", "Settle", MENU_ICONS.settle],
    ]);
  });

  it("已搁置架子里的对话给“取消搁置”；什么都不给时为空（菜单里只剩 bb 自己的操作）", () => {
    expect(threadMenuItems({ settle: "unsettle", startHere: false }, MESSAGES.zh).map((i) => i.label)).toEqual(["取消搁置"]);
    expect(threadMenuItems({ settle: null, startHere: false }, MESSAGES.en)).toEqual([]);
  });

  it("key 带插件前缀，不会和 bb 自己的操作撞名", () => {
    for (const item of threadMenuItems({ settle: "settle", startHere: true }, MESSAGES.en)) expect(item.key.startsWith("worktree-lineage/")).toBe(true);
  });
});

describe("branchMenuItems（手机分支行的 ⋯ 菜单）", () => {
  it("有工作树可开新对话、有清理命令时各一项；命令原样放在第二行", () => {
    const items = branchMenuItems({ startHere: true, cleanupCommand: "git -C /tmp/repo worktree remove /tmp/wt" }, MESSAGES.en);
    expect(items.map((i) => [i.key, i.label, i.detail ?? null])).toEqual([
      ["start-here", "New thread in this worktree", null],
      ["copy-cleanup", "Copy safe cleanup command", "git -C /tmp/repo worktree remove /tmp/wt"],
    ]);
  });

  it("两样都没有时为空（不画 ⋯）", () => {
    expect(branchMenuItems({ startHere: false, cleanupCommand: null }, MESSAGES.en)).toEqual([]);
  });
});

describe("菜单文案零混用", () => {
  const all = (lang: "en" | "zh") => {
    const tx = MESSAGES[lang];
    return [
      ...threadMenuItems({ settle: "settle", startHere: true }, tx),
      ...threadMenuItems({ settle: "unsettle", startHere: false }, tx),
      ...branchMenuItems({ startHere: true, cleanupCommand: null }, tx),
    ].flatMap((i) => [i.label, i.detail ?? ""]).concat(tx.threadMenu, tx.branchMenu, tx.copyCleanup);
  };

  it("英文菜单不含汉字", () => {
    expect(all("en").filter((t) => HAN.test(t))).toEqual([]);
  });

  it("中文菜单不含英文界面词，也不用“已完结”", () => {
    expect(all("zh").flatMap((t) => t.match(/[A-Za-z]+/g) ?? [])).toEqual([]);
    expect(all("zh").join("")).not.toContain("已完结");
    expect([MESSAGES.zh.settle, MESSAGES.zh.unsettle, MESSAGES.zh.threadMenu, MESSAGES.zh.branchMenu]).toEqual(["搁置", "取消搁置", "对话操作", "分支操作"]);
  });
});
