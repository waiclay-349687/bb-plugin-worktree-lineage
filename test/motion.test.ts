import { describe, expect, it } from "vitest";
import {
  computeFlipDeltas,
  finishEntering,
  finishExiting,
  flipDuration,
  parseTranslateOffset,
  reconcilePresence,
  type FlipRect,
  type PresenceEntry,
} from "../lib/motion";

const keyOf = (item: { id: string }) => item.id;
const entry = (id: string, phase: PresenceEntry<{ id: string }>["phase"] = "present"): PresenceEntry<{ id: string }> => ({
  key: id,
  item: { id },
  phase,
});

describe("reconcilePresence", () => {
  it("首屏或关闭动画时直接标为 present，不留退场条目", () => {
    const init = reconcilePresence([], [{ id: "a" }, { id: "b" }], keyOf, { animateEnter: false, animateExit: false });
    expect(init.map((e) => [e.key, e.phase])).toEqual([
      ["a", "present"],
      ["b", "present"],
    ]);

    const switched = reconcilePresence(init, [{ id: "c" }], keyOf, { animateEnter: false, animateExit: false });
    expect(switched.map((e) => [e.key, e.phase])).toEqual([["c", "present"]]);
  });

  it("归档时在原位置保留 exiting，不跳位", () => {
    const prev = [entry("a"), entry("b"), entry("c")];
    const next = reconcilePresence(prev, [{ id: "a" }, { id: "c" }], keyOf, {
      animateEnter: true,
      animateExit: true,
      isRelocated: () => false,
    });
    expect(next.map((e) => [e.key, e.phase])).toEqual([
      ["a", "present"],
      ["b", "exiting"],
      ["c", "present"],
    ]);
  });

  it("第一条被归档时保留在索引 0；连续归档两条各自保留原相对顺序", () => {
    const prev = [entry("a"), entry("b"), entry("c")];
    const afterFirst = reconcilePresence(prev, [{ id: "b" }, { id: "c" }], keyOf, { animateEnter: true, animateExit: true });
    expect(afterFirst.map((e) => [e.key, e.phase])).toEqual([
      ["a", "exiting"],
      ["b", "present"],
      ["c", "present"],
    ]);

    const afterSecond = reconcilePresence(afterFirst, [{ id: "c" }], keyOf, { animateEnter: true, animateExit: true });
    expect(afterSecond.map((e) => [e.key, e.phase])).toEqual([
      ["a", "exiting"],
      ["b", "exiting"],
      ["c", "present"],
    ]);
  });

  it("置顶 / 取消置顶搬去其他分区时（isRelocated = true）立刻移除，不留退场残影", () => {
    const prev = [entry("a"), entry("b"), entry("c")];
    const next = reconcilePresence(prev, [{ id: "a" }, { id: "c" }], keyOf, {
      animateEnter: true,
      animateExit: true,
      isRelocated: (k) => k === "b",
    });
    expect(next.map((e) => [e.key, e.phase])).toEqual([
      ["a", "present"],
      ["c", "present"],
    ]);
  });

  it("全新对话标为 entering，从别区迁入（isNewGlobal = false）直接 present 交由 FLIP", () => {
    const prev = [entry("a")];
    const next = reconcilePresence(prev, [{ id: "new1" }, { id: "moved1" }, { id: "a" }], keyOf, {
      animateEnter: true,
      animateExit: true,
      isNewGlobal: (k) => k === "new1",
    });
    expect(next.map((e) => [e.key, e.phase])).toEqual([
      ["new1", "entering"],
      ["moved1", "present"],
      ["a", "present"],
    ]);
  });

  it("退场完成前重新出现（取消归档）立刻恢复为 present 且不重复", () => {
    const prev = [entry("a"), entry("b", "exiting"), entry("c")];
    const next = reconcilePresence(prev, [{ id: "a" }, { id: "b" }, { id: "c" }], keyOf, {
      animateEnter: true,
      animateExit: true,
    });
    expect(next.map((e) => [e.key, e.phase])).toEqual([
      ["a", "present"],
      ["b", "present"],
      ["c", "present"],
    ]);
  });

  it("finishEntering 和 finishExiting 仅更新目标键并在无变化时保持引用稳定", () => {
    const list = [entry("a", "entering"), entry("b", "exiting"), entry("c", "present")];
    expect(finishEntering(list, new Set(["nope"]))).toBe(list);
    expect(finishExiting(list, new Set(["nope"]))).toBe(list);

    const settled = finishEntering(list, new Set(["a"]));
    expect(settled.map((e) => [e.key, e.phase])).toEqual([
      ["a", "present"],
      ["b", "exiting"],
      ["c", "present"],
    ]);

    const cleaned = finishExiting(settled, new Set(["b"]));
    expect(cleaned.map((e) => [e.key, e.phase])).toEqual([
      ["a", "present"],
      ["c", "present"],
    ]);
  });
});

describe("computeFlipDeltas", () => {
  it("同列表重排算出精确反向位移，忽略亚像素抖动", () => {
    const prev = new Map<string, FlipRect>([
      ["a", { top: 10, left: 0 }],
      ["b", { top: 40, left: 0 }],
      ["c", { top: 70, left: 0 }],
    ]);
    const next = new Map<string, FlipRect>([
      ["b", { top: 10, left: 0 }],
      ["a", { top: 40, left: 0 }],
      ["c", { top: 70.2, left: 0 }],
    ]);
    const deltas = computeFlipDeltas(prev, next, new Map());
    expect(deltas.get("b")).toEqual({ dx: 0, dy: 30, distance: 30 });
    expect(deltas.get("a")).toEqual({ dx: 0, dy: -30, distance: 30 });
    expect(deltas.has("c")).toBe(false);
  });

  it("父分区整体下移时，子行扣除父位移，避免双倍位移；同区补位行只算相对差值", () => {
    // 场景：置顶区刚出现（高 60px），把 Project A 从 40 推到 100；同时把 Project A 里的 x 置顶到 top=70，y 补位从 100 变 130
    const prev = new Map<string, FlipRect>([
      ["sec:A", { top: 40, left: 0 }],
      ["t:x", { top: 70, left: 0 }],
      ["t:y", { top: 100, left: 0 }],
    ]);
    const next = new Map<string, FlipRect>([
      ["sec:pinned", { top: 40, left: 0 }],
      ["t:x", { top: 70, left: 0 }],
      ["sec:A", { top: 100, left: 0 }],
      ["t:y", { top: 130, left: 0 }],
    ]);
    const parentOf = new Map<string, string | null>([
      ["sec:pinned", null],
      ["t:x", "sec:pinned"],
      ["sec:A", null],
      ["t:y", "sec:A"],
    ]);
    // t:y 实际从 100 -> 130 (rawDy=-30)，sec:A 从 40 -> 100 (rawDy=-60)，所以 t:y 在 sec:A 内部向上滑 +30 补位，总视觉位移 -60+30=-30（精确！）
    const deltas = computeFlipDeltas(prev, next, parentOf);
    expect(deltas.get("sec:A")).toEqual({ dx: 0, dy: -60, distance: 60 });
    expect(deltas.get("t:y")).toEqual({ dx: 0, dy: 30, distance: 30 });
    expect(deltas.has("t:x")).toBe(false);
  });

  it("置顶到新出现的置顶区时，置顶行直接算出完整跨区飞跃距离", () => {
    const prev = new Map<string, FlipRect>([
      ["sec:A", { top: 40, left: 0 }],
      ["t:first", { top: 70, left: 0 }],
      ["t:target", { top: 220, left: 0 }],
    ]);
    const next = new Map<string, FlipRect>([
      ["sec:pinned", { top: 40, left: 0 }],
      ["t:target", { top: 70, left: 0 }],
      ["sec:A", { top: 110, left: 0 }],
      ["t:first", { top: 140, left: 0 }],
    ]);
    const parentOf = new Map<string, string | null>([
      ["sec:pinned", null],
      ["t:target", "sec:pinned"],
      ["sec:A", null],
      ["t:first", "sec:A"],
    ]);
    const deltas = computeFlipDeltas(prev, next, parentOf);
    expect(deltas.get("t:target")).toEqual({ dx: 0, dy: 150, distance: 150 });
    expect(deltas.get("sec:A")).toEqual({ dx: 0, dy: -70, distance: 70 });
    // t:first 跟着 sec:A 一起下移了 70px，自身局部偏移为 0
    expect(deltas.has("t:first")).toBe(false);
  });
});

describe("flipDuration & parseTranslateOffset", () => {
  it("按位移距离夹在 190ms–280ms 之间", () => {
    expect(flipDuration(0)).toBe(190);
    expect(flipDuration(30)).toBeGreaterThanOrEqual(190);
    expect(flipDuration(30)).toBeLessThan(230);
    expect(flipDuration(600)).toBe(280);
  });

  it("解析 none / matrix / matrix3d 的位移分量", () => {
    expect(parseTranslateOffset("none")).toEqual({ x: 0, y: 0 });
    expect(parseTranslateOffset("matrix(1, 0, 0, 1, -4.5, 42.25)")).toEqual({ x: -4.5, y: 42.25 });
    expect(parseTranslateOffset("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, -18, 0, 1)")).toEqual({ x: 3, y: -18 });
  });
});
