import type { SQL } from "bun";
import { ReadeckClient, mapAnnotation, mapBookmark } from "./readeck";
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
