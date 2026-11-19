import { describe, expect, it } from "vitest";
import { BRIEFING_VERSION, buildDigest, countAsks, freshness, outlineKey, parseBriefing, toTurns } from "../lib/briefing";
import type { OutlineItem } from "../lib/search";

const user = (preview: string): OutlineItem => ({ role: "user", preview });
const assistant = (preview: string): OutlineItem => ({ role: "assistant", preview });

describe("toTurns", () => {
  it("一轮 = 一条要求 + 它之后助手的最后一段话", () => {
    const turns = toTurns([user("做一个登录页"), assistant("正在看现有代码"), assistant("登录页做好了，已通过测试"), user("加上记住我")]);
    expect(turns).toEqual([
      { ask: "做一个登录页", reply: "登录页做好了，已通过测试" },
      { ask: "加上记住我", reply: null },
    ]);
  });

  it("bb 自动转达的消息不算要求，但它之后的答复仍归到上一轮", () => {
    const items = [user("派两个子对话去查"), assistant("已派出"), user("[bb system] 子对话完成"), assistant("两个都查完了，结论是 A")];
    expect(countAsks(items)).toBe(1);
    expect(toTurns(items)[0]?.reply).toBe("两个都查完了，结论是 A");
  });

  it("开头没有要求的助手消息被忽略", () => {
    expect(toTurns([assistant("你好"), user("开始吧")])).toEqual([{ ask: "开始吧", reply: null }]);
  });
});

describe("buildDigest", () => {
  it("按时间编号列出每一轮，并写明当前状态", () => {
    const digest = buildDigest([user("第一件事"), assistant("做完了"), user("第二件事")], { active: false });
    expect(digest).toContain("1. 要求：第一件事\n   答复：做完了");
    expect(digest).toContain("2. 要求：第二件事");
    expect(digest).toContain("等用户回应");
  });

  it("太长时截短较早几轮的答复，要求和最近 6 轮的答复保持完整", () => {
    const long = "结论".repeat(110);
    const items = Array.from({ length: 80 }, (_, i) => [user(`要求 ${i + 1}`), assistant(long)]).flat();
    const digest = buildDigest(items, { active: true });
    const turns = toTurns(items);
    expect(digest).toContain("80. 要求：要求 80");
    expect(digest).toContain(`1. 要求：要求 1\n   答复：${turns[0]!.reply!.slice(0, 80)}…`);
    expect(digest).toContain(`80. 要求：要求 80\n   答复：${turns[79]!.reply}`);
    expect(digest.length).toBeLessThan(14_000);
  });
});

describe("parseBriefing", () => {
  const valid = {
    about: "给侧边栏做 worktree 分组",
    stages: [
      { title: "试用 Nest", state: "dropped", note: "子对话挂错位置" },
      { title: "自研列表", state: "doing", note: "卡片样式已定" },
    ],
    now: "在改悬停卡片",
    waiting: null,
    next: "截图验证",
  };

  it("接受合法输出", () => {
    expect(parseBriefing(JSON.stringify(valid))).toEqual(valid);
  });

  it("容忍代码围栏和前后多余的话", () => {
    expect(parseBriefing(`好的，结果如下：\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\n`)).toEqual(valid);
  });

  it("把写成字符串的“没有”收成 null", () => {
    expect(parseBriefing(JSON.stringify({ ...valid, waiting: "null", next: "无" }))).toMatchObject({ waiting: null, next: null });
  });

  it("结构不对返回 null", () => {
    expect(parseBriefing("抱歉，我无法完成")).toBeNull();
    expect(parseBriefing(JSON.stringify({ ...valid, stages: [] }))).toBeNull();
    expect(parseBriefing(JSON.stringify({ ...valid, stages: [{ title: "x", state: "maybe", note: "" }] }))).toBeNull();
  });

  it("超长的字段被截断，阶段最多 6 个", () => {
    const many = { ...valid, about: "字".repeat(100), stages: Array.from({ length: 8 }, () => valid.stages[0]) };
    const parsed = parseBriefing(JSON.stringify(many));
    expect(parsed?.about.length).toBe(40);
    expect(parsed?.stages).toHaveLength(6);
  });
});

describe("freshness", () => {
  const item = (id: string, role: "user" | "assistant", preview: string): OutlineItem => ({ id, role, preview });
  const base = [item("a", "user", "做登录页"), item("b", "assistant", "做好了")];
  const stored = { version: BRIEFING_VERSION, outlineKey: outlineKey(base), askCount: 1 };

  it("大纲没有新消息 = 没落后", () => {
    expect(freshness(stored, base)).toEqual({ state: "fresh" });
  });

  it("有了新要求 = 落后，并数出新要求的轮数", () => {
    const items = [...base, item("c", "user", "加上记住我"), item("d", "assistant", "加好了"), item("e", "user", "再加验证码")];
    expect(freshness(stored, items)).toEqual({ state: "behind", newAsks: 2 });
  });

  it("没有新要求、只有新答复（子对话回报后的续写）也算落后", () => {
    const items = [...base, item("c", "user", "[bb system] 子对话完成"), item("d", "assistant", "子对话的结论是 A")];
    expect(freshness(stored, items)).toEqual({ state: "behind", newAsks: 0 });
  });

  it("只敲了一个 /compact 不算新进展，也不算一轮要求", () => {
    const items = [...base, item("c", "user", "/compact")];
    expect(freshness(stored, items)).toEqual({ state: "fresh" });
    expect(countAsks(items)).toBe(1);
  });

  it("提示词版本变了 = 落后", () => {
    expect(freshness({ ...stored, version: BRIEFING_VERSION - 1 }, base)).toEqual({ state: "behind", newAsks: 0 });
  });
});
