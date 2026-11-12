/**
 * Store tests against a real Postgres. Skipped unless TEST_DATABASE_URL points at a throwaway database:
 * every run drops and recreates the tables.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { importModelRatings, migrate, randomHighlight, syncReaderRatings, syncSource, today, today as todayPick, unratedHighlights } from "../src/store";
import { pickWeighted } from "../src/model";
import dailyHighlight from "../obsidian/daily_highlight.js";
import type { DocInput, HighlightInput } from "../src/model";
import { ingestSnipd } from "../src/ingest";
import type { SnipdClient } from "../src/snipd";
import { unzipText } from "../src/zip";
import { join } from "path";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const sql = url ? new SQL(url) : (null as unknown as SQL);

const doc = (id: string): DocInput => ({
  source_app: "readeck", external_id: id, kind: "article", title: `Title ${id}`, author: "Someone", url: `https://ex.com/${id}`, published_at: null, language: "en",
});
const hl = (id: string, docId = "b1", extra: Partial<HighlightInput> = {}): HighlightInput => ({
  source_app: "readeck", external_id: id, doc_external_id: docId, text: `Passage ${id}`, note: null, color: "yellow",
  location: null, deep_link: `https://r.x/bookmarks/${docId}#annotation-${id}`, highlighted_at: "2026-07-01T10:00:00Z", ...extra,
});
const docs = (...ids: string[]) => new Map(ids.map((i) => [i, doc(i)]));

d("store against Postgres", () => {
  beforeEach(async () => {
    await sql.unsafe("DROP VIEW IF EXISTS current_ratings; DROP TABLE IF EXISTS ratings, surfacings, highlights, documents CASCADE");
    await migrate(sql);
  });
  afterAll(async () => sql?.close());

  test("C1: schema has both tables with the agreed columns", async () => {
    const cols = async (t: string) =>
      (await sql`SELECT column_name FROM information_schema.columns WHERE table_name = ${t}`).map((r: any) => r.column_name).sort();
    expect(await cols("documents")).toEqual(["author", "external_id", "id", "kind", "language", "published_at", "source_app", "title", "url"]);
    expect(await cols("highlights")).toEqual([
      "color", "deep_link", "deleted_at", "document_id", "external_id", "highlighted_at", "id", "imported_at",
      "location", "note", "source_app", "tags", "text", "text_hash", "updated_at",
    ]);
  });

  test("C2/C4: a backfill stores every highlight once, and a second run changes nothing", async () => {
    const items = [hl("a1"), hl("a2"), hl("a3", "b2")];
    expect(await syncSource(sql, "readeck", docs("b1", "b2"), items)).toEqual({ inserted: 3, updated: 0, deleted: 0, unchanged: 0, duplicates: 0 });
    expect(await syncSource(sql, "readeck", new Map(), items)).toEqual({ inserted: 0, updated: 0, deleted: 0, unchanged: 3, duplicates: 0 });
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM highlights`;
    expect(n).toBe(3);
  });

  test("C5: an edited note updates the row; a vanished highlight is marked deleted and kept", async () => {
    await syncSource(sql, "readeck", docs("b1"), [hl("a1"), hl("a2")]);
    const before = (await sql`SELECT updated_at FROM highlights WHERE external_id = 'a1'`)[0].updated_at;
    await Bun.sleep(20);
    const c = await syncSource(sql, "readeck", new Map(), [hl("a1", "b1", { note: "my thought" })]);
    expect(c).toEqual({ inserted: 0, updated: 1, deleted: 1, unchanged: 0, duplicates: 0 });
    const [a1] = await sql`SELECT note, updated_at FROM highlights WHERE external_id = 'a1'`;
    expect(a1.note).toBe("my thought");
    expect(new Date(a1.updated_at).getTime()).toBeGreaterThan(new Date(before).getTime());
    const [a2] = await sql`SELECT deleted_at FROM highlights WHERE external_id = 'a2'`;
    expect(a2.deleted_at).not.toBeNull();
  });

  test("an empty listing against a live set is refused, not read as mass deletion", async () => {
    await syncSource(sql, "readeck", docs("b1"), Array.from({ length: 12 }, (_, i) => hl(`a${i}`)));
    expect(syncSource(sql, "readeck", new Map(), [])).rejects.toThrow("refusing");
    const [{ live }] = await sql`SELECT count(*)::int AS live FROM highlights WHERE deleted_at IS NULL`;
    expect(live).toBe(12);
  });

  test("C10: one highlight per day, stable all day, the longest-rested first when the draw is even, never a deleted one", async () => {
    await syncSource(sql, "readeck", docs("b1"), [hl("a1"), hl("a2"), hl("a3")]);
    const even = () => 0.5; // a constant draw makes the weighted pick deterministic: the highest weight wins
    const today = (s: SQL, day: string) => todayPick(s, day, even);
    const d1 = await today(sql, "2026-11-01");
    expect((await today(sql, "2026-11-01"))!.id).toBe(d1!.id);
    expect(d1).toMatchObject({ date: "2026-11-01", title: "Title b1", author: "Someone", kind: "article" });
    const d2 = await today(sql, "2026-11-02");
    const d3 = await today(sql, "2026-11-03");
    expect(new Set([d1!.id, d2!.id, d3!.id]).size).toBe(3);
    // the 4th day repeats the one shown longest ago
    expect((await today(sql, "2026-11-04"))!.id).toBe(d1!.id);

    // delete the 5th day's pick upstream: the same day then gets a live replacement
    const d5 = await today(sql, "2026-11-05");
    const live = [hl("a1"), hl("a2"), hl("a3")].filter((h) => h.text !== d5!.text);
    await syncSource(sql, "readeck", new Map(), live);
    const again = await today(sql, "2026-11-05");
    expect(again!.id).not.toBe(d5!.id);
    expect(live.map((h) => h.text)).toContain(again!.text);
  });

  test("C10: an empty store yields no highlight", async () => {
    expect(await today(sql, "2026-11-01")).toBeNull();
  });

  test("C16: /random returns a live highlight, never a deleted one, and leaves the daily rotation untouched", async () => {
    expect(await randomHighlight(sql)).toBeNull();
    await syncSource(sql, "readeck", docs("b1"), [hl("a1"), hl("a2")]);
    await syncSource(sql, "readeck", new Map(), [hl("a1")]);
    for (let i = 0; i < 20; i++) expect((await randomHighlight(sql))!.text).toBe("Passage a1");
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM surfacings`;
    expect(n).toBe(0);
  });

  test("C6: a passage already stored from another source is skipped, by same text or containment, and a re-run stays clean", async () => {
    await syncSource(sql, "readeck", docs("b1"), [
      hl("r1", "b1", { text: "Habits are the compound interest of self-improvement." }),
      hl("r2", "b1", { text: "Short one." }),
    ]);
    const rw = (id: string, text: string): HighlightInput => ({ ...hl(id, "w1"), source_app: "readwise", text, tags: ["t1"] });
    const rdocs = new Map([["w1", { ...doc("w1"), source_app: "readwise" }]]);
    const items = [
      rw("x1", "habits are the compound   interest of self-improvement."),
      rw("x2", "As Clear says: habits are the compound interest of self-improvement. Think about it."),
      rw("x3", "Short one."),
      rw("x4", "A brand new passage that nobody stored before."),
    ];
    expect(await syncSource(sql, "readwise", rdocs, items)).toEqual({ inserted: 1, updated: 0, deleted: 0, unchanged: 0, duplicates: 3 });
    expect(await syncSource(sql, "readwise", new Map(), items)).toEqual({ inserted: 0, updated: 0, deleted: 0, unchanged: 1, duplicates: 3 });
    const [row] = await sql`SELECT tags FROM highlights WHERE source_app = ${"readwise"}`;
    expect(row.tags).toEqual(["t1"]);
    await syncSource(sql, "readeck", new Map(), [hl("r2", "b1", { text: "Short one." })]);
    expect((await syncSource(sql, "readwise", new Map(), items)).inserted).toBe(2); // r1 deleted upstream: x1 and x2 come in
  });

  test("C19: Snipd mirrors snips with words, reports Snipd's own total and newest, refuses a partial export, re-runs clean", async () => {
    const files = unzipText(await Bun.file(join(import.meta.dir, "fixtures", "snipd-export.zip")).arrayBuffer());
    const ep = "11111111-2222-4333-8444-555555555555";
    const client = (total: number) => ({
      metadata: async () => ({ episode_batch_count: 1, episode_batches: [{ index: 0, episodes: [{ episode_id: ep, latest_snip_update_ts: "2026-11-07T09:00:00.000Z", total_snip_count: total }] }] }),
      exportEpisodes: async () => files,
    }) as unknown as SnipdClient;
    const first = await ingestSnipd(sql, client(4));
    expect(first).toMatchObject({ inserted: 3, duplicates: 0, snipd: { episodes: 1, snips: 4, withoutWords: 1, newest: "2026-11-07T09:00:00.000Z" } });
    expect(await ingestSnipd(sql, client(4))).toMatchObject({ inserted: 0, updated: 0, deleted: 0, unchanged: 3 });
    expect(ingestSnipd(sql, client(5))).rejects.toThrow("not mirroring a partial export");
    const [{ gems }] = await sql`SELECT count(*)::int AS gems FROM highlights WHERE source_app = ${"snipd"} AND note = ${"*"}`;
    expect(gems).toBe(1);
  });

  test("C13/C14: note markers become reader ratings as history; the daily note shows the note without the marker", async () => {
    await syncSource(sql, "readeck", docs("b1"), [hl("a1", "b1", { note: "*3 why" }), hl("a2", "b1", { note: "* why" }), hl("a3", "b1", { note: "why *" }), hl("a4", "b1", { note: "*8" })]);
    expect(await syncReaderRatings(sql)).toEqual({ changed: 2 });
    expect(await syncReaderRatings(sql)).toEqual({ changed: 0 }); // unchanged notes write nothing
    const rating = async (ext: string) => (await sql`SELECT cr.score, cr.rated_by FROM current_ratings cr JOIN highlights h ON h.id = cr.highlight_id WHERE h.external_id = ${ext}`)[0];
    expect(await rating("a1")).toEqual({ score: 3, rated_by: "reader" });
    expect(await rating("a2")).toEqual({ score: 7, rated_by: "reader" });
    expect(await rating("a3")).toEqual({ score: null, rated_by: null });
    expect(await rating("a4")).toEqual({ score: null, rated_by: null });

    // a model rating never beats his; once his marker is removed, the model rating is in force
    const [{ id: a1 }] = await sql`SELECT id FROM highlights WHERE external_id = ${"a1"}`;
    expect(await importModelRatings(sql, [{ highlight_id: a1, score: 6, reason: "r", model: "m", rubric_version: "v1" }])).toEqual({ inserted: 1, rejected: 0 });
    expect(await rating("a1")).toEqual({ score: 3, rated_by: "reader" });
    await syncSource(sql, "readeck", new Map(), [hl("a1", "b1", { note: "*5 why" }), hl("a2", "b1", { note: "why" }), hl("a3", "b1", { note: "why *" }), hl("a4", "b1", { note: "*8" })]);
    expect(await syncReaderRatings(sql)).toEqual({ changed: 2 }); // a1 changed to 5, a2 marker removed
    expect(await rating("a1")).toEqual({ score: 5, rated_by: "reader" });
    expect(await rating("a2")).toEqual({ score: null, rated_by: null });
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM ratings WHERE rater = ${"reader"}`;
    expect(n).toBe(4); // a1: 3 then 5; a2: 7 then removed

    // the API strips the marker, and the daily note prints only the words
    const pick = await todayPick(sql, "2026-11-01", () => 0.5);
    expect(pick!.id).toBe(a1); // the highest rating wins an even draw
    expect(pick).toMatchObject({ note: "why", rating: 5, rated_by: "reader" });
    expect(dailyHighlight.render(pick)).toContain("💭 why");
    expect(dailyHighlight.render(pick)).not.toContain("*5");
  });

  test("C14: model ratings are validated, and unrated lists only live highlights with no rating in force", async () => {
    await syncSource(sql, "readeck", docs("b1"), [hl("a1"), hl("a2", "b1", { note: "*" }), hl("a3")]);
    await syncReaderRatings(sql);
    const ids = Object.fromEntries((await sql`SELECT external_id, id FROM highlights`).map((r: any) => [r.external_id, r.id]));
    expect((await unratedHighlights(sql, 10)).map((h) => h.id).sort()).toEqual([ids.a1, ids.a3].sort());
    const bad = [
      { highlight_id: ids.a1, score: 8, reason: "r", model: "m", rubric_version: "v1" },
      { highlight_id: ids.a1, score: 4.5, reason: "r", model: "m", rubric_version: "v1" },
      { highlight_id: ids.a1, score: 5, reason: " ", model: "m", rubric_version: "v1" },
      { highlight_id: 999999, score: 5, reason: "r", model: "m", rubric_version: "v1" },
    ];
    expect(await importModelRatings(sql, [...bad, { highlight_id: ids.a1, score: 5, reason: "r", model: "m", rubric_version: "v1" }])).toEqual({ inserted: 1, rejected: 4 });
    expect((await unratedHighlights(sql, 10)).map((h) => h.id)).toEqual([ids.a3]);
  });

  test("C15: the daily pick draws from the database by rating; a deleted gem is never drawn", async () => {
    await syncSource(sql, "readeck", docs("b1"), [hl("g1", "b1", { note: "*" }), hl("u1"), hl("g2", "b1", { note: "*" })]);
    await syncSource(sql, "readeck", new Map(), [hl("g1", "b1", { note: "*" }), hl("u1")]);
    await syncReaderRatings(sql);
    let gems = 0;
    for (let k = 0; k < 40; k++) {
      const day = new Date(Date.UTC(2027, 0, 1 + k)).toISOString().slice(0, 10);
      const p = (await todayPick(sql, day))!;
      expect(p.text).not.toBe("Passage g2");
      if (p.text === "Passage g1") gems++;
    }
    expect(gems).toBeGreaterThan(18); // weight 8 against 1, even with rest: the gem takes most days (about 30 of 40)
  });

  test("A3: only the passage is stored; there is no body column", async () => {
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name IN ('documents','highlights') AND column_name IN ('body','content','article','html')`;
    expect(n).toBe(0);
  });
});
