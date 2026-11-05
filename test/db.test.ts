/**
 * Store tests against a real Postgres. Skipped unless TEST_DATABASE_URL points at a throwaway database:
 * every run drops and recreates the tables.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { migrate, randomHighlight, syncSource, today } from "../src/store";
import type { DocInput, HighlightInput } from "../src/model";

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
    await sql.unsafe("DROP TABLE IF EXISTS surfacings, highlights, documents CASCADE");
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
    expect(await syncSource(sql, "readeck", docs("b1", "b2"), items)).toEqual({ inserted: 3, updated: 0, deleted: 0, unchanged: 0 });
    expect(await syncSource(sql, "readeck", new Map(), items)).toEqual({ inserted: 0, updated: 0, deleted: 0, unchanged: 3 });
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM highlights`;
    expect(n).toBe(3);
  });

  test("C5: an edited note updates the row; a vanished highlight is marked deleted and kept", async () => {
    await syncSource(sql, "readeck", docs("b1"), [hl("a1"), hl("a2")]);
    const before = (await sql`SELECT updated_at FROM highlights WHERE external_id = 'a1'`)[0].updated_at;
    await Bun.sleep(20);
    const c = await syncSource(sql, "readeck", new Map(), [hl("a1", "b1", { note: "my thought" })]);
    expect(c).toEqual({ inserted: 0, updated: 1, deleted: 1, unchanged: 0 });
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

  test("C10: one highlight per day, stable all day, least recently shown first, never a deleted one", async () => {
    await syncSource(sql, "readeck", docs("b1"), [hl("a1"), hl("a2"), hl("a3")]);
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

  test("A3: only the passage is stored; there is no body column", async () => {
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name IN ('documents','highlights') AND column_name IN ('body','content','article','html')`;
    expect(n).toBe(0);
  });
});
