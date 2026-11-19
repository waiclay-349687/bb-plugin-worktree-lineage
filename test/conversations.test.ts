import { describe, expect, it } from "vitest";
import { activityOf, buildConversations, countDescendants, type ConversationLike } from "../lib/conversations";

const t = (id: string, over: Partial<ConversationLike> = {}): ConversationLike => ({
  id,
  parentThreadId: null,
  createdAt: 100,
  updatedAt: 100,
  latestAttentionAt: 100,
  ...over,
});
const idle = () => false;
const ids = (nodes: { thread: { id: string } }[]) => nodes.map((n) => n.thread.id);

describe("activityOf", () => {
  it("空闲的对话用“上一次轮到用户”的时间，点开看一眼（updatedAt 变了）不算活动", () => {
    expect(activityOf(t("a", { updatedAt: 900, latestAttentionAt: 300 }), false)).toBe(300);
  });

  it("正在跑的对话用 updatedAt", () => {
    expect(activityOf(t("a", { updatedAt: 900, latestAttentionAt: 300 }), true)).toBe(900);
  });

  it("还没轮到过用户的新对话用创建时间", () => {
    expect(activityOf(t("a", { createdAt: 500, latestAttentionAt: null }), false)).toBe(500);
  });
});

describe("buildConversations", () => {
  it("顶层按最近活动排序", () => {
    const view = buildConversations([t("old", { latestAttentionAt: 200 }), t("new", { latestAttentionAt: 800 })], idle);
    expect(ids(view)).toEqual(["new", "old"]);
  });

  it("只是被点开过的对话不会跳到前面", () => {
    const view = buildConversations([t("opened", { updatedAt: 999, latestAttentionAt: 200 }), t("worked", { updatedAt: 500, latestAttentionAt: 500 })], idle);
    expect(ids(view)).toEqual(["worked", "opened"]);
  });

  it("被派出的对话挂在派它的对话下面，新派的在上", () => {
    const view = buildConversations(
      [t("boss"), t("first", { parentThreadId: "boss", createdAt: 110 }), t("second", { parentThreadId: "boss", createdAt: 120 })],
      idle,
    );
    expect(ids(view)).toEqual(["boss"]);
    expect(ids(view[0]!.children)).toEqual(["second", "first"]);
    expect(countDescendants(view[0]!)).toBe(2);
  });

  it("下级刚动过，这一家跟着靠前", () => {
    const view = buildConversations(
      [t("quiet-boss", { latestAttentionAt: 100 }), t("busy-child", { parentThreadId: "quiet-boss", latestAttentionAt: 900 }), t("other", { latestAttentionAt: 500 })],
      idle,
    );
    expect(ids(view)).toEqual(["quiet-boss", "other"]);
    expect(view[0]!.activityAt).toBe(900);
  });

  it("上级不在这个项目里时，它自己就是顶层", () => {
    const view = buildConversations([t("orphan", { parentThreadId: "elsewhere" })], idle);
    expect(ids(view)).toEqual(["orphan"]);
  });

  it("数据成环时不丢对话，也不死循环", () => {
    const view = buildConversations([t("a", { parentThreadId: "b" }), t("b", { parentThreadId: "a" })], idle);
    const all = (nodes: typeof view): string[] => nodes.flatMap((n) => [n.thread.id, ...all(n.children)]);
    expect(all(view).sort()).toEqual(["a", "b"]);
  });

  it("多层派出照样嵌套", () => {
    const view = buildConversations([t("a"), t("b", { parentThreadId: "a" }), t("c", { parentThreadId: "b" })], idle);
    expect(view[0]!.children[0]!.children[0]!.thread.id).toBe("c");
    expect(countDescendants(view[0]!)).toBe(2);
  });
});
