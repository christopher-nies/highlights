import { SQL } from "bun";
import { join } from "path";
import { readFileSync } from "fs";
import { textHash, type DocInput, type HighlightInput } from "./model";

export type Counters = { inserted: number; updated: number; deleted: number; unchanged: number };

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
  const c: Counters = { inserted: 0, updated: 0, deleted: 0, unchanged: 0 };
  const [{ live }] = await sql`SELECT count(*)::int AS live FROM highlights WHERE source_app = ${sourceApp} AND deleted_at IS NULL`;
  if (items.length === 0 && live > 10) {
    throw new Error(`${sourceApp} listed 0 highlights while ${live} are live; refusing to mark them deleted`);
  }

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
      if (!old) {
        await tx`
          INSERT INTO highlights (document_id, source_app, external_id, text, note, color, location, deep_link, highlighted_at, text_hash)
          VALUES (${await lookupDoc(h.doc_external_id)}, ${sourceApp}, ${h.external_id}, ${h.text}, ${h.note}, ${h.color},
                  ${h.location}, ${h.deep_link}, ${h.highlighted_at}, ${textHash(h.text)})`;
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
  date: string;
  id: number;
  text: string;
  note: string | null;
  color: string | null;
  title: string | null;
  author: string | null;
  url: string | null;
  deep_link: string | null;
  source_app: string;
  kind: string;
  highlighted_at: string | null;
}

async function readToday(sql: SQL, day: string): Promise<TodayHighlight | null> {
  const [row] = await sql`
    SELECT s.day::text AS date, h.id, h.text, h.note, h.color, d.title, d.author, d.url, h.deep_link,
           h.source_app, d.kind, h.highlighted_at
    FROM surfacings s JOIN highlights h ON h.id = s.highlight_id JOIN documents d ON d.id = h.document_id
    WHERE s.day = ${day} AND h.deleted_at IS NULL`;
  return row ? { ...row, highlighted_at: row.highlighted_at ? new Date(row.highlighted_at).toISOString() : null } : null;
}

/**
 * The day's highlight: the same one all day; on first ask, the live highlight shown least recently (never shown first).
 * If the day's pick was deleted upstream since, a new one replaces it.
 */
export async function today(sql: SQL, day: string): Promise<TodayHighlight | null> {
  const hit = await readToday(sql, day);
  if (hit) return hit;
  const [pick] = await sql`
    SELECT h.id FROM highlights h
    LEFT JOIN (SELECT highlight_id, max(day) AS last FROM surfacings GROUP BY highlight_id) s ON s.highlight_id = h.id
    WHERE h.deleted_at IS NULL
    ORDER BY s.last ASC NULLS FIRST, random()
    LIMIT 1`;
  if (!pick) return null;
  await sql`
    INSERT INTO surfacings (day, highlight_id) VALUES (${day}, ${pick.id})
    ON CONFLICT (day) DO UPDATE SET highlight_id = EXCLUDED.highlight_id, chosen_at = now()
    WHERE NOT EXISTS (SELECT 1 FROM highlights x WHERE x.id = surfacings.highlight_id AND x.deleted_at IS NULL)`;
  return readToday(sql, day);
}

/** Any live highlight, uniformly at random. Read-only: it is not recorded as surfaced, so the daily rotation is untouched. */
export async function randomHighlight(sql: SQL): Promise<TodayHighlight | null> {
  const [row] = await sql`
    SELECT NULL::text AS date, h.id, h.text, h.note, h.color, d.title, d.author, d.url, h.deep_link,
           h.source_app, d.kind, h.highlighted_at
    FROM highlights h JOIN documents d ON d.id = h.document_id
    WHERE h.deleted_at IS NULL
    ORDER BY random() LIMIT 1`;
  return row ? { ...row, highlighted_at: row.highlighted_at ? new Date(row.highlighted_at).toISOString() : null } : null;
}
