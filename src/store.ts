import { SQL } from "bun";
import { join } from "path";
import { readFileSync } from "fs";
import { noteRating, pickWeighted, textHash, type DocInput, type HighlightInput } from "./model";

export type Counters = { inserted: number; updated: number; deleted: number; unchanged: number; duplicates: number };

const MIN_CONTAINED = 30;
const norm = (t: string) => t.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * C6: new highlights of this source that repeat a live passage already stored from another source, by the same text
 * (textHash) or one passage containing the other (word-bounded, at least MIN_CONTAINED characters). The first source
 * keeps the passage; a duplicate is not stored, and comes in on a later run if the original is deleted.
 */
export async function findDuplicates(sql: SQL, sourceApp: string, items: HighlightInput[]): Promise<Set<string>> {
  const mine = new Set((await sql`SELECT external_id FROM highlights WHERE source_app = ${sourceApp}`).map((r: any) => r.external_id as string));
  const fresh = items.filter((h) => !mine.has(h.external_id));
  const dup = new Set<string>();
  if (!fresh.length) return dup;
  const others = await sql`SELECT text, text_hash FROM highlights WHERE source_app <> ${sourceApp} AND deleted_at IS NULL`;
  const hashes = new Set(others.map((r: any) => r.text_hash as string));
  const long = others.map((r: any) => ` ${norm(r.text)} `).filter((n: string) => n.length >= MIN_CONTAINED + 2);
  for (const h of fresh) {
    if (hashes.has(textHash(h.text))) { dup.add(h.external_id); continue; }
    const n = ` ${norm(h.text)} `;
    if (n.length < MIN_CONTAINED + 2) continue;
    if (long.some((o: string) => o.includes(n) || n.includes(o))) dup.add(h.external_id);
  }
  return dup;
}

export async function migrate(sql: SQL) {
  await sql.unsafe(readFileSync(join(import.meta.dir, "..", "schema.sql"), "utf8"));
}

/** External ids of the documents a source already has, so the ingest only asks the source about new ones. */
export async function knownDocIds(sql: SQL, sourceApp: string): Promise<Set<string>> {
  const rows = await sql`SELECT external_id FROM documents WHERE source_app = ${sourceApp}`;
  return new Set(rows.map((r: any) => r.external_id as string));
}

/**
 * Mirror one source's complete listing into the database.
 * New highlights are inserted, changed ones updated, ones missing from the listing get deleted_at (rows are kept).
 * An empty listing against a non-trivial live set is refused: that is an outage, not a mass deletion.
 */
export async function syncSource(
  sql: SQL,
  sourceApp: string,
  docs: Map<string, DocInput>,
  items: HighlightInput[],
): Promise<Counters> {
  const c: Counters = { inserted: 0, updated: 0, deleted: 0, unchanged: 0, duplicates: 0 };
  const [{ live }] = await sql`SELECT count(*)::int AS live FROM highlights WHERE source_app = ${sourceApp} AND deleted_at IS NULL`;
  if (items.length === 0 && live > 10) {
    throw new Error(`${sourceApp} listed 0 highlights while ${live} are live; refusing to mark them deleted`);
  }
  const duplicates = await findDuplicates(sql, sourceApp, items);

  await sql.begin(async (tx) => {
    const docId = new Map<string, number>();
    for (const d of docs.values()) {
      const [row] = await tx`
        INSERT INTO documents (source_app, external_id, kind, title, author, url, published_at, language)
        VALUES (${d.source_app}, ${d.external_id}, ${d.kind}, ${d.title}, ${d.author}, ${d.url}, ${d.published_at}, ${d.language})
        ON CONFLICT (source_app, external_id) DO UPDATE SET external_id = EXCLUDED.external_id
        RETURNING id`;
      docId.set(d.external_id, row.id);
    }
    const lookupDoc = async (ext: string) => {
      if (docId.has(ext)) return docId.get(ext)!;
      const [row] = await tx`SELECT id FROM documents WHERE source_app = ${sourceApp} AND external_id = ${ext}`;
      if (!row) throw new Error(`${sourceApp} highlight points at unknown document ${ext}`);
      docId.set(ext, row.id);
      return row.id as number;
    };

    const existing = new Map<string, any>();
    for (const r of await tx`SELECT id, external_id, text, note, color, deep_link, deleted_at FROM highlights WHERE source_app = ${sourceApp}`) {
      existing.set(r.external_id, r);
    }

    const seen = new Set<string>();
    for (const h of items) {
      seen.add(h.external_id);
      const old = existing.get(h.external_id);
      if (!old && duplicates.has(h.external_id)) {
        c.duplicates++;
      } else if (!old) {
        await tx`
          INSERT INTO highlights (document_id, source_app, external_id, text, note, color, location, deep_link, highlighted_at, text_hash, tags)
          VALUES (${await lookupDoc(h.doc_external_id)}, ${sourceApp}, ${h.external_id}, ${h.text}, ${h.note}, ${h.color},
                  ${h.location}, ${h.deep_link}, ${h.highlighted_at}, ${textHash(h.text)},
                  ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(h.tags ?? [])}::text::jsonb)))`;
        c.inserted++;
      } else if (old.text !== h.text || old.note !== h.note || old.color !== h.color || old.deep_link !== h.deep_link || old.deleted_at) {
        await tx`
          UPDATE highlights SET text = ${h.text}, note = ${h.note}, color = ${h.color}, deep_link = ${h.deep_link},
                 text_hash = ${textHash(h.text)}, updated_at = now(), deleted_at = NULL
          WHERE id = ${old.id}`;
        c.updated++;
      } else {
        c.unchanged++;
      }
    }

    for (const [ext, old] of existing) {
      if (!seen.has(ext) && !old.deleted_at) {
        await tx`UPDATE highlights SET deleted_at = now(), updated_at = now() WHERE id = ${old.id}`;
        c.deleted++;
      }
    }
  });
  return c;
}

export interface TodayHighlight {
  date: string | null;
  id: number;
  text: string;
  /** The note without the reader's rating marker (C13). */
  note: string | null;
  color: string | null;
  title: string | null;
  author: string | null;
  url: string | null;
  deep_link: string | null;
  source_app: string;
  kind: string;
  highlighted_at: string | null;
  /** The rating in force, 1–7, and who gave it; null when nobody has rated it. */
  rating: number | null;
  rated_by: "reader" | "model" | null;
}

const shape = (row: any): TodayHighlight => ({
  ...row,
  note: noteRating(row.note).text,
  rating: row.rating ?? null,
  rated_by: row.rated_by ?? null,
  highlighted_at: row.highlighted_at ? new Date(row.highlighted_at).toISOString() : null,
});

async function readToday(sql: SQL, day: string): Promise<TodayHighlight | null> {
  const [row] = await sql`
    SELECT s.day::text AS date, h.id, h.text, h.note, h.color, d.title, d.author, d.url, h.deep_link,
           h.source_app, d.kind, h.highlighted_at, cr.score AS rating, cr.rated_by
    FROM surfacings s JOIN highlights h ON h.id = s.highlight_id JOIN documents d ON d.id = h.document_id
    JOIN current_ratings cr ON cr.highlight_id = h.id
    WHERE s.day = ${day} AND h.deleted_at IS NULL`;
  return row ? shape(row) : null;
}

/**
 * The day's highlight: the same one all day. On first ask it is drawn by rating and rest (pickWeighted, C15): gems
 * more often, unrated as a 4, nothing ever at zero. If the day's pick was deleted upstream since, a new one replaces it.
 */
export async function today(sql: SQL, day: string, rng: () => number = Math.random): Promise<TodayHighlight | null> {
  const hit = await readToday(sql, day);
  if (hit) return hit;
  const cands = await sql`
    SELECT h.id, cr.score, s.last::text AS "lastDay"
    FROM highlights h JOIN current_ratings cr ON cr.highlight_id = h.id
    LEFT JOIN (SELECT highlight_id, max(day) AS last FROM surfacings WHERE day < ${day} GROUP BY highlight_id) s ON s.highlight_id = h.id
    WHERE h.deleted_at IS NULL`;
  const id = pickWeighted(cands, day, rng);
  if (id == null) return null;
  await sql`
    INSERT INTO surfacings (day, highlight_id) VALUES (${day}, ${id})
    ON CONFLICT (day) DO UPDATE SET highlight_id = EXCLUDED.highlight_id, chosen_at = now()
    WHERE NOT EXISTS (SELECT 1 FROM highlights x WHERE x.id = surfacings.highlight_id AND x.deleted_at IS NULL)`;
  return readToday(sql, day);
}

/** Any live highlight, uniformly at random. Read-only: it is not recorded as surfaced, so the daily rotation is untouched. */
export async function randomHighlight(sql: SQL): Promise<TodayHighlight | null> {
  const [row] = await sql`
    SELECT NULL::text AS date, h.id, h.text, h.note, h.color, d.title, d.author, d.url, h.deep_link,
           h.source_app, d.kind, h.highlighted_at, cr.score AS rating, cr.rated_by
    FROM highlights h JOIN documents d ON d.id = h.document_id JOIN current_ratings cr ON cr.highlight_id = h.id
    WHERE h.deleted_at IS NULL
    ORDER BY random() LIMIT 1`;
  return row ? shape(row) : null;
}

/**
 * Record the reader's note markers as ratings (C13, C14): a new row only where the marker's score differs from the
 * reader's newest rating, so history is kept and an unchanged note writes nothing. A removed marker writes score NULL.
 */
export async function syncReaderRatings(sql: SQL): Promise<{ changed: number }> {
  const rows = await sql`
    SELECT h.id, h.note, r.score AS current, r.id IS NOT NULL AS has_row
    FROM highlights h
    LEFT JOIN LATERAL (SELECT id, score FROM ratings WHERE highlight_id = h.id AND rater = ${"reader"} ORDER BY id DESC LIMIT 1) r ON true
    WHERE h.deleted_at IS NULL`;
  let changed = 0;
  for (const r of rows) {
    const score = noteRating(r.note).score;
    if (score === (r.has_row ? r.current : null)) continue;
    await sql`INSERT INTO ratings (highlight_id, rater, score) VALUES (${r.id}, ${"reader"}, ${score})`;
    changed++;
  }
  return { changed };
}

export interface UnratedHighlight { id: number; text: string; note: string | null; title: string | null; author: string | null; kind: string; source_app: string }

/** Live highlights with no rating in force, oldest first: the rating job's input. */
export async function unratedHighlights(sql: SQL, limit: number): Promise<UnratedHighlight[]> {
  const rows = await sql`
    SELECT h.id, h.text, h.note, d.title, d.author, d.kind, h.source_app
    FROM highlights h JOIN documents d ON d.id = h.document_id JOIN current_ratings cr ON cr.highlight_id = h.id
    WHERE h.deleted_at IS NULL AND cr.score IS NULL
    ORDER BY h.id LIMIT ${limit}`;
  return rows.map((r: any) => ({ ...r, note: noteRating(r.note).text }));
}

export interface ModelRating { highlight_id: number; score: number; reason: string; model: string; rubric_version: string }

/** Store the rating job's answers as model ratings. Each must name a live highlight and a whole score 1–7. */
export async function importModelRatings(sql: SQL, items: ModelRating[]): Promise<{ inserted: number; rejected: number }> {
  let inserted = 0, rejected = 0;
  await sql.begin(async (tx) => {
    for (const r of items) {
      const ok = Number.isInteger(r.score) && r.score >= 1 && r.score <= 7 && r.reason?.trim() && r.model?.trim() && r.rubric_version?.trim();
      const [live] = ok ? await tx`SELECT 1 FROM highlights WHERE id = ${r.highlight_id} AND deleted_at IS NULL` : [];
      if (!live) { rejected++; continue; }
      await tx`INSERT INTO ratings (highlight_id, rater, score, reason, model, rubric_version)
               VALUES (${r.highlight_id}, ${"model"}, ${r.score}, ${r.reason.trim()}, ${r.model.trim()}, ${r.rubric_version.trim()})`;
      inserted++;
    }
  });
  return { inserted, rejected };
}
