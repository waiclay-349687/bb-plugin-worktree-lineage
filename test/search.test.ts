import { describe, expect, it } from "vitest";
import { buildRecap, firstSentence, matchThreads, plainSnippet } from "../lib/search";

const t = (id: string, title: string, branch: string | null, projectId: string, at: number) => ({
  id,
  projectId,
  displayTitle: title,
  updatedAt: at,
  environment: branch ? { branchName: branch } : null,
});
const projects = new Map([
  ["p1", "reader"],
  ["p2", "acme-dashboard"],
]);
const threads = [
  t("a", "D2c 阅读页线收尾接手", "mobile/d2c", "p1", 10),
  t("b", "V5-B 后端主链", "bb/v5-b-thr_x", "p2", 30),
  t("c", "看板 v4 指挥官", "main", "p2", 20),
  t("d", "没有环境的对话", null, "p1", 5),
];

describe("matchThreads", () => {
  it("空查询返回空数组", () => {
    expect(matchThreads(threads, projects, "   ")).toEqual([]);
  });
  it("标题、分支、项目名都能命中，不分大小写", () => {
    expect(matchThreads(threads, projects, "阅读").map((x) => x.id)).toEqual(["a"]);
    expect(matchThreads(threads, projects, "V5-b").map((x) => x.id)).toEqual(["b"]);
    expect(matchThreads(threads, projects, "READER").map((x) => x.id)).toEqual(["a", "d"]);
  });
  it("多个词都要命中，结果按最近活动排序", () => {
    expect(matchThreads(threads, projects, "acme").map((x) => x.id)).toEqual(["b", "c"]);
    expect(matchThreads(threads, projects, "acme main").map((x) => x.id)).toEqual(["c"]);
  });
});

describe("plainSnippet", () => {
  it("去掉代码块与 markdown 符号", () => {
    const md = "**v5 全部完成**：打开 [页面](http://x) 就能看。\n\n```ui\nCard(\"x\")\n```\n\n## 下一步\n- 部署";
    expect(plainSnippet(md)).toBe("v5 全部完成：打开 页面 就能看。 下一步 部署");
  });
  it("超长截断并加省略号", () => {
    const out = plainSnippet("字".repeat(300), 20);
    expect(out.length).toBe(20);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("buildRecap", () => {
  const u = (preview: string) => ({ role: "user" as const, preview });
  const a = (preview: string) => ({ role: "assistant" as const, preview });

  it("取最近一次要求和它之后答复的第一句", () => {
    const recap = buildRecap([u("把移动端适配做完"), a("好的，先看现状"), u("先修列表页。顺便看看首页"), a("**列表页已修，共两处改动。** 首页没有问题，详情如下")]);
    expect(recap).toEqual({ turns: 2, ask: "先修列表页。顺便看看首页", reply: "列表页已修，共两处改动。 首页没有问题，详情如下" });
  });
  it("只有一轮时不写要求（标题已经说了）", () => {
    const recap = buildRecap([u("查一下运行环境"), a("当前是 macOS，Node 22。其他细节见下")]);
    expect(recap.ask).toBeNull();
    expect(recap.reply).toBe("当前是 macOS，Node 22。其他细节见下");
  });
  it("最近的要求还没有答复时，不拿更早的答复充数", () => {
    const recap = buildRecap([u("第一件事"), a("做完了"), u("第二件事")]);
    expect(recap.ask).toBe("第二件事");
    expect(recap.reply).toBeNull();
  });
  it("bb 自动转达的消息不算你的要求，斜杠命令前缀去掉", () => {
    const recap = buildRecap([u("/goal 把适配做完"), a("开始"), u("[bb system] @thread:thr_x completed: 跑完了"), a("报告到了。十三项里绝大多数通过，但有三处副作用需要处理。已派出修复线，预计很快回来")]);
    expect(recap.turns).toBe(1);
    expect(recap.ask).toBeNull();
    // 第一句只是引子，带上第二句才有结论；第三句不要
    expect(recap.reply).toBe("报告到了。十三项里绝大多数通过，但有三处副作用需要处理。");
  });
  it("空大纲", () => {
    expect(buildRecap([])).toEqual({ turns: 0, ask: null, reply: null });
  });
});

describe("firstSentence", () => {
  it("太短的开场白不算一句，往后再带一句", () => {
    expect(firstSentence("好的。我先检查了三处配置，都没有问题。然后", 60)).toBe("好的。我先检查了三处配置，都没有问题。");
  });
  it("没有句末标点时整段截断", () => {
    expect(firstSentence("一".repeat(100), 20)).toBe(`${"一".repeat(19)}…`);
  });
  it("英文句号后面要有空格才算句末（不切版本号）", () => {
    expect(firstSentence("Upgraded to v2.3.1 and all tests pass. Next step", 80)).toBe("Upgraded to v2.3.1 and all tests pass.");
  });
});
