import type { DocInput, HighlightInput } from "./model";

/** One item of Readeck's GET /api/bookmarks/annotations (fields as the obsidian-readeck-importer reads them). */
export interface ReadeckAnnotation {
  id: string;
  text: string;
  created?: string;
  updated?: string;
  color?: string;
  note?: string;
  bookmark_id: string;
  bookmark_url?: string;
  bookmark_title?: string;
  bookmark_site_name?: string;
}

/** The subset of GET /api/bookmarks/{id} we keep. */
export interface ReadeckBookmark {
  id: string;
  title?: string;
  url?: string;
  site_name?: string;
  authors?: string[] | null;
  published?: string | null;
  lang?: string | null;
}

export function mapAnnotation(a: ReadeckAnnotation, base: string): HighlightInput {
  return {
    source_app: "readeck",
    external_id: a.id,
    doc_external_id: a.bookmark_id,
    text: a.text.trim(),
    note: a.note?.trim() || null,
    color: a.color || null,
    location: null,
    deep_link: `${base}/bookmarks/${a.bookmark_id}#annotation-${a.id}`,
    highlighted_at: a.created ?? null,
  };
}

export function mapBookmark(b: ReadeckBookmark | null, a: ReadeckAnnotation): DocInput {
  const authors = (b?.authors ?? []).filter(Boolean);
  return {
    source_app: "readeck",
    external_id: a.bookmark_id,
    kind: "article",
    title: b?.title ?? a.bookmark_title ?? null,
    author: authors.length ? authors.join(", ") : (b?.site_name ?? a.bookmark_site_name ?? null),
    url: b?.url ?? a.bookmark_url ?? null,
    published_at: b?.published ?? null,
    language: b?.lang ?? null,
  };
}

export class ReadeckClient {
  constructor(private base: string, private token: string, private fetcher: typeof fetch = fetch) {
    this.base = base.replace(/\/$/, "");
  }

  get baseUrl() {
    return this.base;
  }

  private async get(path: string): Promise<Response> {
    // GET only (ISA A1). The token travels in the header, never in the URL.
    const res = await this.fetcher(`${this.base}${path}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Readeck ${path.split("?")[0]} answered HTTP ${res.status}`);
    return res;
  }

  /** Every annotation, paged until a short page. Throws on any HTTP error so a failure is never read as "no highlights". */
  async allAnnotations(pageSize = 100): Promise<ReadeckAnnotation[]> {
    const out: ReadeckAnnotation[] = [];
    for (let offset = 0; offset < 100_000; offset += pageSize) {
      const page = (await (await this.get(`/api/bookmarks/annotations?limit=${pageSize}&offset=${offset}`)).json()) as ReadeckAnnotation[];
      out.push(...page);
      if (page.length < pageSize) break;
    }
    return out;
  }

  async bookmark(id: string): Promise<ReadeckBookmark | null> {
    try {
      return (await (await this.get(`/api/bookmarks/${encodeURIComponent(id)}`)).json()) as ReadeckBookmark;
    } catch {
      return null; // a deleted bookmark still leaves the annotation's own title and URL
    }
  }
}
