/** Shapes shared by every source. A source maps its own records into these; the store never sees source formats. */

export interface DocInput {
  source_app: string;
  external_id: string;
  kind: "article" | "book" | "podcast" | "video";
  title: string | null;
  author: string | null;
  url: string | null;
  published_at: string | null;
  language: string | null;
}

export interface HighlightInput {
  source_app: string;
  external_id: string;
  doc_external_id: string;
  text: string;
  note: string | null;
  color: string | null;
  location: string | null;
  deep_link: string | null;
  highlighted_at: string | null;
  tags?: string[];
}

/** Same passage from two sources should hash the same: collapse whitespace, unify quotes, lowercase. */
export function textHash(text: string): string {
  const norm = text
    .normalize("NFKC")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return new Bun.CryptoHasher("sha256").update(norm).digest("hex");
}

/** Calendar date (YYYY-MM-DD) in the given time zone. */
export function localDay(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
