import { describe, expect, it } from "vitest";
import { buildConversations } from "../lib/conversations";
import { isThreadSettled, needsUserAttention, nextAttentionId, orderByVisual, splitSettledConversations, type SettleCheckable } from "../lib/settle";

function makeThread(id: string, overrides: Partial<SettleCheckable> = {}): SettleCheckable {
  return {
    id,
    parentThreadId: null,
    createdAt: 1000,
    updatedAt: 2000,
    latestAttentionAt: 1500,
    indicator: "none",
    isPinned: false,
    ...overrides,
  };
}

describe("isThreadSettled", () => {
  it("空闲或已完成未读（done）且无更新活动时保持软收起", () => {
    expect(isThreadSettled(makeThread("a"), 2000, false)).toBe(true);
    expect(isThreadSettled(makeThread("b", { indicator: "unread-success" }), 2000, false)).toBe(true);
  });

  it("仅打开看一眼（只改 updatedAt 不改 latestAttentionAt）不会误唤醒", () => {
    expect(isThreadSettled(makeThread("a", { latestAttentionAt: 1500, updatedAt: 9999 }), 2000, false)).toBe(true);
  });

  it("运行中、等你回复、出错、草稿或置顶时立刻唤醒", () => {
    expect(isThreadSettled(makeThread("a", { indicator: "runtime" }), 5000, false)).toBe(false);
    expect(isThreadSettled(makeThread("a", { indicator: "waiting-for-input" }), 5000, false)).toBe(false);
    expect(isThreadSettled(makeThread("a", { indicator: "unread-error" }), 5000, false)).toBe(false);
    expect(isThreadSettled(makeThread("a"), 5000, true)).toBe(false);
    expect(isThreadSettled(makeThread("a", { isPinned: true }), 5000, false)).toBe(false);
  });

  it("完结之后又出现新活动（latestAttentionAt > settledAt）自动唤醒", () => {
    expect(isThreadSettled(makeThread("a", { latestAttentionAt: 3000 }), 2000, false)).toBe(false);
  });
});

describe("splitSettledConversations", () => {
  it("父对话完结且子对话也安静时整家收进 settled；子对话有草稿或运行中时整家唤醒", () => {
    const parentQuiet = makeThread("p1", { latestAttentionAt: 1500 });
    const childQuiet = makeThread("c1", { parentThreadId: "p1", latestAttentionAt: 1600 });
    const parentWoken = makeThread("p2", { latestAttentionAt: 1500 });
    const childRunning = makeThread("c2", { parentThreadId: "p2", indicator: "runtime", updatedAt: 3000 });
    const items = buildConversations([parentQuiet, childQuiet, parentWoken, childRunning], (t) => t.indicator === "runtime");

    const { active, settled } = splitSettledConversations(items, { p1: 2000, p2: 2000 }, new Set());
    expect(active.map((c) => c.thread.id)).toEqual(["p2"]);
    expect(settled.map((c) => c.thread.id)).toEqual(["p1"]);
  });
});

describe("needsUserAttention & nextAttentionId", () => {
  it("仅黄草稿、蓝等你/出错、绿完成未读算需要用户处理；运行中与空闲不算", () => {
    expect(needsUserAttention("none", true)).toBe(true);
    expect(needsUserAttention("waiting-for-input", false)).toBe(true);
    expect(needsUserAttention("unread-error", false)).toBe(true);
    expect(needsUserAttention("unread-success", false)).toBe(true);
    expect(needsUserAttention("runtime", false)).toBe(false);
    expect(needsUserAttention("none", false)).toBe(false);
  });

  it("按视觉顺序前后循环跳转", () => {
    const ids = ["t1", "t2", "t3"];
    expect(nextAttentionId([], "t1", 1)).toBeNull();
    expect(nextAttentionId(ids, null, 1)).toBe("t1");
    expect(nextAttentionId(ids, null, -1)).toBe("t3");
    expect(nextAttentionId(ids, "t1", 1)).toBe("t2");
    expect(nextAttentionId(ids, "t3", 1)).toBe("t1");
    expect(nextAttentionId(ids, "t1", -1)).toBe("t3");
    expect(nextAttentionId(ids, "other", 1)).toBe("t1");
  });
});

describe("orderByVisual", () => {
  it("按屏幕上渲染的行序重排待办；重复行（置顶 + 项目里各一行）只算第一次出现", () => {
    expect(orderByVisual(["a", "b", "c"], ["x", "c", null, "a", "c", "b"])).toEqual(["c", "a", "b"]);
  });

  it("没渲染出来的（收起分组里）按原顺序接在后面；不在待办里的行忽略", () => {
    expect(orderByVisual(["a", "b", "c", "d"], ["d", "zz", "b"])).toEqual(["d", "b", "a", "c"]);
    expect(orderByVisual(["a", "b"], [])).toEqual(["a", "b"]);
    expect(orderByVisual([], ["a"])).toEqual([]);
  });
});
