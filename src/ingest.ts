import type { SQL } from "bun";
import { ReadeckClient, mapAnnotation, mapBookmark } from "./readeck";
import { BookOrbitClient, mapAnnotation as mapBookOrbitAnnotation, mapBook } from "./bookorbit";
import { ReadwiseClient, isOwnDocument, mapBook as mapReadwiseBook, mapHighlight as mapReadwiseHighlight } from "./readwise";
import { SnipdClient, mapEpisode, mapSnip, parseEpisodeFile } from "./snipd";
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

/**
 * Mirror every Snipd snip (C19). The full list is exported each run, one metadata call plus one export per batch of
 * episodes, so edits and deletions show up the way they do for the other sources. A snip without words is skipped.
 * The run also reports what Snipd itself says: its snip total and newest snip, so a stale copy is never mistaken for it.
 */
export async function ingestSnipd(sql: SQL, client: SnipdClient) {
  const meta = await client.metadata();
  const episodes = meta.episode_batches.flatMap((b) => b.episodes);
  const docs = new Map<string, DocInput>();
  const items: HighlightInput[] = [];
  let snips = 0;
  for (const batch of meta.episode_batches) {
    if (!batch.episodes.length) continue;
    for (const [path, md] of await client.exportEpisodes(batch.episodes.map((e) => e.episode_id))) {
      const parsed = parseEpisodeFile(path, md);
      if (!parsed) continue;
      snips += parsed.snips.length;
      const mapped = parsed.snips.map((s) => mapSnip(s, parsed.episode.id)).filter((h): h is HighlightInput => h !== null);
      if (!mapped.length) continue;
      docs.set(parsed.episode.id, mapEpisode(parsed.episode));
      items.push(...mapped);
    }
  }
  const total = episodes.reduce((n, e) => n + e.total_snip_count, 0);
  if (snips !== total) throw new Error(`snipd exported ${snips} snips but its metadata lists ${total}; not mirroring a partial export`);
  const counters = await syncSource(sql, "snipd", docs, items);
  const newest = episodes.map((e) => e.latest_snip_update_ts).sort().at(-1) ?? null;
  return { ...counters, snipd: { episodes: episodes.length, snips: total, withoutWords: total - items.length, newest } };
}
