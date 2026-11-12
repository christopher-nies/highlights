import type { SQL } from "bun";
import { ReadeckClient, mapAnnotation, mapBookmark } from "./readeck";
import { BookOrbitClient, mapAnnotation as mapBookOrbitAnnotation, mapBook } from "./bookorbit";
import { ReadwiseClient, isOwnDocument, mapBook as mapReadwiseBook, mapHighlight as mapReadwiseHighlight } from "./readwise";
import { findDuplicates, knownDocIds, syncSource, type Counters } from "./store";
import type { DocInput, HighlightInput } from "./model";

/** Pull every Readeck annotation and mirror it. Bookmark details are fetched only for documents not stored yet. */
export async function ingestReadeck(sql: SQL, client: ReadeckClient): Promise<Counters> {
  const annotations = (await client.allAnnotations()).filter((a) => a.text?.trim());
  const known = await knownDocIds(sql, "readeck");
  const docs = new Map<string, DocInput>();
  for (const a of annotations) {
    if (known.has(a.bookmark_id) || docs.has(a.bookmark_id)) continue;
    docs.set(a.bookmark_id, mapBookmark(await client.bookmark(a.bookmark_id), a));
  }
  return syncSource(sql, "readeck", docs, annotations.map((a) => mapAnnotation(a, client.baseUrl)));
}

/** Pull every active BookOrbit annotation and mirror it. Book title and author come with each item, so no extra calls. */
export async function ingestBookOrbit(sql: SQL, client: BookOrbitClient): Promise<Counters> {
  const annotations = (await client.allAnnotations()).filter((a) => a.text?.trim());
  const known = await knownDocIds(sql, "bookorbit");
  const docs = new Map<string, DocInput>();
  for (const a of annotations) {
    const id = String(a.bookId);
    if (!known.has(id) && !docs.has(id)) docs.set(id, mapBook(a, client.baseUrl));
  }
  return syncSource(sql, "bookorbit", docs, annotations.map((a) => mapBookOrbitAnnotation(a, client.baseUrl)));
}

/**
 * One-off Readwise backfill (not on the timer: Readwise is a source being left behind). Safe to re-run: rows are keyed by
 * Readwise ids, and passages already stored from Readeck or BookOrbit are skipped (C6). --dry-run writes nothing.
 */
export async function importReadwise(sql: SQL, client: ReadwiseClient, { dryRun = false } = {}) {
  const books = await client.allBooks();
  const skipped = books
    .filter((b) => !isOwnDocument(b))
    .map((b) => ({ title: b.title, category: b.category, source_url: b.source_url, highlights: b.highlights.length }));
  const docs = new Map<string, DocInput>();
  const items: HighlightInput[] = [];
  for (const b of books.filter(isOwnDocument)) {
    const live = b.highlights.filter((h) => !h.is_deleted && !h.is_discard && h.text?.trim());
    if (!live.length) continue;
    docs.set(String(b.user_book_id), mapReadwiseBook(b));
    items.push(...live.map((h) => mapReadwiseHighlight(h, b)));
  }
  const summary = {
    documents: docs.size,
    highlights: items.length,
    gems: items.filter((h) => h.note?.startsWith("*")).length,
    duplicatesOfOtherSources: (await findDuplicates(sql, "readwise", items)).size,
    skippedDocuments: skipped,
  };
  if (dryRun) return { dryRun: true, ...summary };
  return { ...summary, counters: await syncSource(sql, "readwise", docs, items) };
}
