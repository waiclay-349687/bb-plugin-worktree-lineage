/**
 * [INPUT]: 依赖 zod; 依赖 lib/search 的 plainSnippet（把大纲预览压成纯文字）
 * [OUTPUT]: 对外提供 toTurns / countAsks（把 bb 的对话大纲切成“一轮要求 + 结论”）、outlineKey / freshness（存盘的速览是否落后于当前大纲）、buildDigest（喂给模型的全程提要）、BRIEFING_SYSTEM_PROMPT、parseBriefing（校验模型输出）、briefingSchema 与 Briefing 类型
 * [POS]: lib 的“全程速览”纯逻辑; 消费者: briefings.ts（服务端生成）、components/peek.tsx（判断速览是否落后）; 与 search.ts 的边界: search 的 buildRecap 是不花 token 的兜底摘要，这里是交给模型写的那一份的输入与输出
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import { z } from "zod";
import { meaningfulItems, plainSnippet, type OutlineItem } from "./search";

/** 提示词或输出结构变了就加一：存盘的旧速览会被视为过期并重写 */
export const BRIEFING_VERSION = 3;

export const briefingSchema = z.object({
  /** 这条对话在做什么，一句话 */
  about: z.string().min(1),
  /** 整条对话按主题归并出的阶段，按时间顺序 */
  stages: z
    .array(
      z.object({
        title: z.string().min(1),
        state: z.enum(["done", "doing", "dropped"]),
        note: z.string(),
      }),
    )
    .min(1)
    .max(8),
  /** 此刻停在哪一步 */
  now: z.string(),
  /** 需要用户做的决定或回复；没有为 null */
  waiting: z.string().nullable(),
  /** 接下来最可能做的一件事；不确定为 null */
  next: z.string().nullable(),
});
export type Briefing = z.infer<typeof briefingSchema>;
export type BriefingStage = Briefing["stages"][number];

/**
 * 存盘的速览。
 * - outlineKey: 写的时候对话大纲的指纹，用来判断之后有没有新消息（新要求、新答复、子对话回报都算）
 * - askCount:   写的时候读到第几条要求，只用来说“落后了几轮”
 */
export const storedBriefingSchema = briefingSchema.extend({
  version: z.number(),
  outlineKey: z.string(),
  askCount: z.number(),
  generatedAt: z.number(),
});
export type StoredBriefing = z.infer<typeof storedBriefingSchema>;

export interface Turn {
  ask: string;
  /** 这一轮里助手的最后一段话（通常是结论）；还没答复时为 null */
  reply: string | null;
}

/** bb 自动转达的消息（子对话完成通知、别的对话发来的消息）记在 user 角色下，但不是用户说的话 */
const isHuman = (text: string) => !/^\s*\[bb (system|message from)\b/i.test(text);

/** 把大纲切成一轮一轮：一条用户的要求 + 它之后、下一条要求之前助手的最后一段话 */
export function toTurns(items: readonly OutlineItem[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const item of meaningfulItems(items)) {
    const text = plainSnippet(item.preview, 240);
    if (text === "") continue;
    if (item.role === "assistant") {
      if (current) current.reply = text;
      continue;
    }
    if (!isHuman(item.preview)) continue;
    current = { ask: text, reply: null };
    turns.push(current);
  }
  return turns;
}

export function countAsks(items: readonly OutlineItem[]): number {
  return toTurns(items).length;
}

/**
 * 对话大纲的指纹：算数的消息的条数 + 最后一条的标识。任何新内容都会改变它；仅仅打开对话、
 * 或者只敲了一个 /compact 不会（所以不用 thread.updatedAt：读一下它也会变）。
 */
export function outlineKey(all: readonly OutlineItem[]): string {
  const items = meaningfulItems(all);
  const last = items[items.length - 1];
  return `${items.length}:${last?.id ?? ""}`;
}

export type Freshness =
  /** 速览写完之后对话没有任何新消息 */
  | { state: "fresh" }
  /** 之后又有了新消息；newAsks 是其中用户新提的要求数（0 = 只有新答复，比如子对话回报后的续写） */
  | { state: "behind"; newAsks: number };

/** 存盘的速览相对当前大纲是否落后。服务端据此决定要不要重写，卡片据此决定“现在 / 等你 / 下一步”还能不能信 */
export function freshness(stored: Pick<StoredBriefing, "version" | "outlineKey" | "askCount">, items: readonly OutlineItem[]): Freshness {
  if (stored.version === BRIEFING_VERSION && stored.outlineKey === outlineKey(items)) return { state: "fresh" };
  return { state: "behind", newAsks: Math.max(0, countAsks(items) - stored.askCount) };
}

/** 提要总长上限：超过时把较早几轮的答复截短，要求原样保留（要求是主线） */
const DIGEST_BUDGET = 14_000;
const SHORT_REPLY = 80;

/**
 * 喂给模型的全程提要：每一轮的要求 + 答复开头，按时间顺序编号。
 * 读的是整条对话，而不是首尾几条：36 轮的对话也只有几千字。
 */
export function buildDigest(items: readonly OutlineItem[], options: { active: boolean }): string {
  const turns = toTurns(items);
  const render = (shortenBefore: number) =>
    turns
      .map((turn, index) => {
        const reply = turn.reply && index < shortenBefore && turn.reply.length > SHORT_REPLY ? `${turn.reply.slice(0, SHORT_REPLY)}…` : turn.reply;
        return reply ? `${index + 1}. 要求：${turn.ask}\n   答复：${reply}` : `${index + 1}. 要求：${turn.ask}`;
      })
      .join("\n");
  let body = render(0);
  // 最近 6 轮始终保留完整答复：它们决定了“现在停在哪”
  if (body.length > DIGEST_BUDGET) body = render(Math.max(0, turns.length - 6));
  const state = options.active ? "助手正在处理最后一条要求，尚未答完" : "助手已答完最后一条要求，等用户回应";
  return `${body}\n\n（当前状态：${state}）`;
}

export const BRIEFING_SYSTEM_PROMPT = `你为一条 AI 编程对话写“进展速览”，显示在侧边栏的悬停卡片上。读者就是这条对话的用户本人，他同时开着几十条对话，需要 5 秒内想起这条在干什么、到哪了。

输入是整条对话的提要：每一轮用户的要求，以及助手答复的开头。

只输出一个 JSON 对象，不要解释、不要代码围栏：
{
  "about": "这条对话在做什么，一句话，不超过 28 个字",
  "stages": [{"title": "阶段名，不超过 14 个字", "state": "done | doing | dropped", "note": "这一阶段的结果或结论，不超过 32 个字"}],
  "now": "此刻停在哪一步，不超过 36 个字",
  "waiting": "需要读者做的决定或回复，不超过 32 个字；没有就写 null",
  "next": "接下来最可能做的一件事，不超过 28 个字；不确定就写 null"
}

规则：
- stages 把整条对话按主题归并成 1 到 6 个阶段，按时间顺序；只有一两轮的对话写 1 到 2 个阶段即可；闲聊和纯提问不单独成阶段
- 被否决或放弃的方向用 dropped，note 写为什么放弃
- 只写输入里有依据的事实，不猜测结果
- 这是写给读者本人看的：需要提到他时用“你”（例如“等你选方向”），不要写“用户”“用户”
- 用读者使用的语言，用大白话，不堆术语`;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};
/** 模型有时把“没有”写成字符串 */
const orNull = (value: unknown) => (typeof value !== "string" || /^(null|无|没有|none|n\/a)?$/i.test(value.trim()) ? null : value);

/** 校验并收紧模型的输出：容忍代码围栏和前后多余的话；结构不对返回 null（宁可不显示，也不显示半截） */
export function parseBriefing(text: string): Briefing | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const parsed = briefingSchema.safeParse({ ...record, waiting: orNull(record.waiting), next: orNull(record.next) });
  if (!parsed.success) return null;
  const value = parsed.data;
  return {
    about: clip(value.about, 40),
    stages: value.stages.slice(0, 6).map((stage) => ({ title: clip(stage.title, 20), state: stage.state, note: clip(stage.note, 44) })),
    now: clip(value.now, 48),
    waiting: value.waiting ? clip(value.waiting, 44) : null,
    next: value.next ? clip(value.next, 40) : null,
  };
}
