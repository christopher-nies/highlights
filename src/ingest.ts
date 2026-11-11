import type { SQL } from "bun";
import { ReadeckClient, mapAnnotation, mapBookmark } from "./readeck";
import { BookOrbitClient, mapAnnotation as mapBookOrbitAnnotation, mapBook } from "./bookorbit";
import { knownDocIds, syncSource, type Counters } from "./store";
import type { DocInput } from "./model";

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
