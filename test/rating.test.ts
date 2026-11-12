import { describe, expect, test } from "bun:test";
import { noteRating, pickWeighted, scoreWeight } from "../src/model";

describe("C13: the reader's rating marker", () => {
  test("`*`, `*3 why`, `* why` rate; `why *` and `*8` do not; the marker is stripped from the note", () => {
    expect(noteRating("*")).toEqual({ score: 7, text: null });
    expect(noteRating("*3 why")).toEqual({ score: 3, text: "why" });
    expect(noteRating("* why")).toEqual({ score: 7, text: "why" });
    expect(noteRating("why *")).toEqual({ score: null, text: "why *" });
    expect(noteRating("*8")).toEqual({ score: null, text: "*8" });
    expect(noteRating("**bold** idea")).toEqual({ score: null, text: "**bold** idea" });
    expect(noteRating("  *1\n second line ")).toEqual({ score: 1, text: "second line" });
    expect(noteRating(null)).toEqual({ score: null, text: null });
  });
});

describe("C15: weighted daily pick", () => {
  // a small seeded generator, so the 1,000 days are the same on every run
  const seeded = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

  test("over 1,000 simulated days gems beat 5s, 5s beat 1s, and every row shows at least once", () => {
    const rows = [...Array(20)].map((_, i) => ({ id: i, score: i < 2 ? 7 : i < 4 ? 5 : i < 6 ? 1 : null, lastDay: null as string | null }));
    const shown = new Array(20).fill(0);
    const rng = seeded(7);
    for (let k = 0; k < 1000; k++) {
      const day = new Date(Date.UTC(2027, 0, 1 + k)).toISOString().slice(0, 10);
      const id = pickWeighted(rows, day, rng)!;
      shown[id]++;
      rows[id].lastDay = day;
    }
    const avg = (a: number, b: number) => (shown.slice(a, b).reduce((x, y) => x + y, 0) / (b - a));
    expect(avg(0, 2)).toBeGreaterThan(avg(2, 4));
    expect(avg(2, 4)).toBeGreaterThan(avg(6, 20)); // a 5 beats an unrated 4
    expect(avg(6, 20)).toBeGreaterThan(avg(4, 6));
    expect(Math.min(...shown)).toBeGreaterThan(0);
  });

  test("an even draw goes to the highest weight, a tie to the one shown longest ago; nothing has zero chance", () => {
    const even = () => 0.5;
    expect(pickWeighted([{ id: 1, score: 4, lastDay: null }, { id: 2, score: 7, lastDay: null }], "2027-01-01", even)).toBe(2);
    expect(pickWeighted([{ id: 1, score: 4, lastDay: "2026-12-01" }, { id: 2, score: 4, lastDay: "2026-12-01" }, { id: 3, score: 4, lastDay: "2026-06-01" }], "2027-01-01", even)).toBe(3);
    expect(pickWeighted([{ id: 9, score: 1, lastDay: "2026-12-31" }], "2027-01-01", even)).toBe(9);
    expect(pickWeighted([], "2027-01-01")).toBeNull();
    expect(scoreWeight(7) / scoreWeight(4)).toBe(8);
  });
});
