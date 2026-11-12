/**
 * Readwise as a one-off backfill (for leaving Readwise behind): the v2 export API, every book with its highlights.
 * GET https://readwise.io/api/v2/export/ with `Authorization: Token …`, paged by `pageCursor` (readwise.io/api_deets).
 */
import type { DocInput, HighlightInput } from "./model";

export interface ReadwiseHighlight {
  id: number;
  text: string;
  note: string | null;
  color: string | null;
  location: number | null;
  location_type: string | null;
  highlighted_at: string | null;
  created_at: string | null;
  url: string | null;
  readwise_url: string | null;
  tags: { name: string }[] | null;
  is_favorite: boolean;
  is_discard: boolean;
  is_deleted: boolean;
}

export interface ReadwiseBook {
  user_book_id: number;
  title: string | null;
  readable_title: string | null;
  author: string | null;
  category: string;
  source: string;
  source_url: string | null;
  unique_url: string | null;
  readwise_url: string | null;
  is_deleted: boolean;
  highlights: ReadwiseHighlight[];
}

const EXPORT = "https://readwise.io/api/v2/export/";

export class ReadwiseClient {
  constructor(
    private token: string,
    private fetcher: typeof fetch = fetch,
    private sleep: (ms: number) => Promise<unknown> = (ms) => Bun.sleep(ms),
  ) {}

  /** Every book, all pages. A 429 waits for Retry-After and retries (at most 5 times per run). */
  async allBooks(): Promise<ReadwiseBook[]> {
    const out: ReadwiseBook[] = [];
    let cursor: string | null = null;
    let retries = 0;
    for (;;) {
      const url = cursor ? `${EXPORT}?pageCursor=${encodeURIComponent(cursor)}` : EXPORT;
      const res = await this.fetcher(url, { headers: { Authorization: `Token ${this.token}` } });
      if (res.status === 429 && retries++ < 5) {
        await this.sleep(Number(res.headers.get("Retry-After") || 30) * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`readwise export answered ${res.status}`);
      const page = (await res.json()) as { results: ReadwiseBook[]; nextPageCursor: string | null };
      out.push(...page.results);
      cursor = page.nextPageCursor;
      if (!cursor) return out;
    }
  }
}

/** Readwise's own help documents that Reader adds to an account; their highlights are not the reader's own. */
const READWISE_HELP_TITLES = new Set(["Reader: Frequently Asked Questions"]);

/**
 * Only the reader's own highlights come in: supplementals are passages Readwise suggests, and
 * Reader's FAQ is its help text. Not the host: readwise.io also holds the reader's own uploads (PDFs, EPUBs) and every
 * Reader document's unique_url.
 */
export function isOwnDocument(b: ReadwiseBook): boolean {
  if (b.is_deleted) return false;
  if (b.category === "supplementals" || b.source === "supplemental") return false;
  if (READWISE_HELP_TITLES.has((b.title ?? "").trim())) return false;
  return true;
}

const KIND: Record<string, DocInput["kind"]> = { books: "book", podcasts: "podcast" };

export function mapBook(b: ReadwiseBook): DocInput {
  return {
    source_app: "readwise",
    external_id: String(b.user_book_id),
    kind: KIND[b.category] ?? "article",
    title: b.readable_title || b.title || null,
    author: b.author || null,
    url: b.source_url || b.unique_url || null,
    published_at: null,
    language: null,
  };
}

function location(h: ReadwiseHighlight): string | null {
  if (h.location == null) return null;
  if (h.location_type === "page") return `p. ${h.location}`;
  if (h.location_type === "location") return `loc. ${h.location}`;
  if (h.location_type === "time_offset") {
    const s = Math.round(h.location);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  return null; // "order" is only a position in Readwise's list
}

/**
 * A favourite is a gem, written in the gem notation used in notes: a leading `*` in the note (C13).
 * A note that already starts with `*` is an explicit rating and stays as it is.
 */
export function mapHighlight(h: ReadwiseHighlight, b: ReadwiseBook): HighlightInput {
  const note = h.note?.trim() || null;
  const rated = h.is_favorite && !note?.startsWith("*") ? (note ? `* ${note}` : "*") : note;
  return {
    source_app: "readwise",
    external_id: String(h.id),
    doc_external_id: String(b.user_book_id),
    text: h.text.trim(),
    note: rated,
    color: h.color || null,
    location: location(h),
    deep_link: h.url || b.source_url || h.readwise_url || null,
    highlighted_at: h.highlighted_at || h.created_at || null,
    tags: (h.tags ?? []).map((t) => t.name).filter(Boolean),
  };
}
