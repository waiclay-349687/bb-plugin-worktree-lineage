/**
 * [INPUT]: 无外部依赖
 * [OUTPUT]: 对外提供 matchThreads（按标题 / 分支 / 项目筛选对话）、plainSnippet（把一段 markdown 压成一两句纯文字）、buildRecap / firstSentence（用对话大纲拼出“你问 / 答复”的进展摘要，不花 token）、meaningfulItems（大纲里算数的消息：去掉空白与纯斜杠命令）
 * [POS]: lib 的文本小工具，纯函数; 消费者: components/lineage-list.tsx（快速筛选）、components/peek.tsx（速览缺失或落后时的兜底摘要）、lib/briefing.ts（plainSnippet）
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */

export interface Searchable {
  id: string;
  projectId: string | null;
  displayTitle: string;
  updatedAt: number;
  environment: { branchName: string | null } | null;
}

/**
 * 空格分开的每个词都要命中（标题、分支名、项目名任一处，不分大小写）；结果按最近活动排序。
 * 空查询返回空数组：调用方据此决定显示正常列表还是筛选结果。
 */
export function matchThreads<T extends Searchable>(threads: readonly T[], projectNames: ReadonlyMap<string, string>, query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return threads
    .filter((thread) => {
      const haystack = [thread.displayTitle, thread.environment?.branchName ?? "", thread.projectId ? projectNames.get(thread.projectId) ?? "" : ""]
        .join("\n")
        .toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 去掉代码块、标题符号、强调符号和链接语法，压成一行，超长截断 */
export function plainSnippet(markdown: string, max = 160): string {
  const text = markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export interface OutlineItem {
  /** bb 给每条消息的稳定标识；测试里可以省略 */
  id?: string;
  role: "user" | "assistant";
  preview: string;
}

/**
 * 大纲里“算数”的消息：去掉空白的，以及只有一个斜杠命令的用户消息（/compact、/clear 这类是对工具下的指令，不是对话内容）。
 * 摘要、速览的提要、判断速览是否落后，都只看这些。
 */
export function meaningfulItems(items: readonly OutlineItem[]): OutlineItem[] {
  return items.filter((item) => {
    const text = item.preview.trim();
    return text !== "" && !(item.role === "user" && /^\/[a-z][\w:-]*$/i.test(text));
  });
}

export interface Recap {
  /** 你一共说了几轮（bb 自动转达的消息不算） */
  turns: number;
  /** 最近一次你提的要求，只取第一句；只有一轮时为 null（那一轮就是标题） */
  ask: string | null;
  /** 最近一次要求之后，它的答复的第一句（通常就是结论） */
  reply: string | null;
}

/**
 * 取开头的一两句：从头累加整句，直到至少有 min 个字为止（太短的开场白如“好的。”“报告到了。”说明不了什么，往后再带一句）。
 * 超过 max 截断。只做文字处理，不理解内容。
 */
export function firstSentence(markdown: string, max: number, min = 10): string {
  const text = plainSnippet(markdown, 400);
  const ends = [...text.matchAll(/[。！？!?；]|\.(?=\s|$)/g)].map((m) => m.index! + m[0].length);
  const end = ends.find((index) => index >= min) ?? text.length;
  const sentence = text.slice(0, end).trim();
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/**
 * 用 bb 已有的对话大纲拼出进展摘要：不调用任何模型，不花 token。
 * 大纲里每条消息只有一段开头的预览文字，这里只做挑选和截取：
 *   - 标题已经概括了目标，所以不再重复“目标”
 *   - 答复通常结论先行，所以只取第一句
 */
export function buildRecap(all: readonly OutlineItem[]): Recap {
  const items = meaningfulItems(all);
  // 开头的斜杠命令（/goal 等）不是内容，去掉
  const strip = (text: string) => text.replace(/^\s*\/[a-z][\w-]*\s+/i, "");
  // bb 自动转达的消息（子对话完成通知、别的对话发来的消息）记在 user 角色下，但不是你说的话
  const isHuman = (text: string) => !/^\s*\[bb (system|message from)\b/i.test(text);
  const filled = (item: OutlineItem) => item.preview.trim() !== "";
  const asks = items.filter((item) => item.role === "user" && filled(item) && isHuman(item.preview));
  const last = asks[asks.length - 1];
  const lastIndex = last ? items.lastIndexOf(last) : -1;
  // 只取“最近一次要求之后”的答复：之前的答复回答的是别的问题
  const reply = [...items.slice(lastIndex + 1)].reverse().find((item) => item.role === "assistant" && filled(item));
  return {
    turns: asks.length,
    ask: last && asks.length > 1 ? firstSentence(strip(last.preview), 46) : null,
    // 答复至少凑够二十几个字：第一句常常只是“报告到了”这样的引子，结论在第二句
    reply: reply ? firstSentence(reply.preview, 84, 24) : null,
  };
}
