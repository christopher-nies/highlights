import type { DocInput, HighlightInput } from "./model";

/**
 * One item of BookOrbit's annotation hub, GET /api/v1/annotations (AnnotationHubItem in the BookOrbit server,
 * server/src/modules/annotation/annotation-hub.service.ts toHubItem). The hub lists the logged-in user's own
 * annotations only, so the ingest logs in as the reader whose highlights it collects.
 */
export interface BookOrbitAnnotation {
  id: number;
  bookId: number;
  cfi: string | null;
  text: string | null;
  color: string | null;
  style: string | null;
  note: string | null;
  chapterTitle: string | null;
  origin: string | null;
  highlightedAt: string | null;
  createdAt: string;
  bookTitle: string | null;
  author: string | null;
  deletedAt: string | null;
  jumpFileId: number | null;
  jumpFileFormat: string | null;
  pageno: number | null;
  starredAt: string | null;
}

interface HubPage {
  items: BookOrbitAnnotation[];
  total: number;
  page: number;
  pageSize: number;
}

/** The reader opened at the highlight, the same route BookOrbit's own client builds (annotationReaderRoute). */
export function readerLink(a: BookOrbitAnnotation, base: string): string | null {
  if (!a.jumpFileId || !a.jumpFileFormat) return null;
  const params = new URLSearchParams({ format: a.jumpFileFormat });
  if (a.cfi) params.set("cfi", a.cfi);
  else if (a.pageno != null) params.set("page", String(a.pageno));
  else return null;
  return `${base}/read/${a.bookId}/${a.jumpFileId}?${params}`;
}

export function mapAnnotation(a: BookOrbitAnnotation, base: string): HighlightInput {
  const location = [a.chapterTitle?.trim() || null, a.pageno != null ? `p. ${a.pageno}` : null].filter(Boolean).join(" · ");
  return {
    source_app: "bookorbit",
    external_id: String(a.id),
    doc_external_id: String(a.bookId),
    text: (a.text ?? "").trim(),
    note: a.note?.trim() || null,
    color: a.color || null,
    location: location || null,
    deep_link: readerLink(a, base) ?? `${base}/annotations?bookId=${a.bookId}`,
    highlighted_at: a.highlightedAt ?? a.createdAt ?? null,
  };
}

export function mapBook(a: BookOrbitAnnotation, base: string): DocInput {
  return {
    source_app: "bookorbit",
    external_id: String(a.bookId),
    kind: "book",
    title: a.bookTitle ?? null,
    author: a.author ?? null,
    url: `${base}/annotations?bookId=${a.bookId}`,
    published_at: null,
    language: null,
  };
}

export class BookOrbitClient {
  private token: string | null = null;
  private lastRequestAt = 0;

  constructor(
    private base: string,
    private username: string,
    private password: string,
    private fetcher: typeof fetch = fetch,
    // BookOrbit throttles at 120 requests/minute; stay near 100.
    private minIntervalMs = 600,
  ) {
    this.base = base.replace(/\/$/, "");
  }

  get baseUrl() {
    return this.base;
  }

  /** The one non-GET request (ISA A1): password login for a short-lived access token. */
  private async login() {
    const res = await this.fetcher(`${this.base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username: this.username, password: this.password }),
    });
    if (!res.ok) throw new Error(`BookOrbit login answered HTTP ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { accessToken?: string };
    const cookie = res.headers.getSetCookie?.().find((c) => c.startsWith("access_token="));
    this.token = body.accessToken ?? cookie?.split(";")[0].split("=")[1] ?? null;
    if (!this.token) throw new Error("BookOrbit login succeeded but returned no access token");
  }

  private async get(path: string): Promise<Response> {
    if (!this.token) await this.login();
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await Bun.sleep(wait);
      this.lastRequestAt = Date.now();
      const res = await this.fetcher(`${this.base}/api/v1${path}`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
      });
      if (res.status === 429 && attempt < 3) {
        await Bun.sleep(Number(res.headers.get("retry-after")) * 1000 || 30_000);
        continue;
      }
      if (!res.ok) throw new Error(`BookOrbit ${path.split("?")[0]} answered HTTP ${res.status}`);
      return res;
    }
  }

  /**
   * Every active (not trashed) annotation. The hub has no "changed since" filter and no updatedAt, so mirroring
   * edits and deletions needs the whole active list each run. A listing that ends short of the hub's own total
   * throws, so a partial read is never mistaken for deletions.
   */
  async allAnnotations(pageSize = 100): Promise<BookOrbitAnnotation[]> {
    const out: BookOrbitAnnotation[] = [];
    let total = 0;
    for (let page = 1; page <= 1000; page++) {
      const q = `page=${page}&pageSize=${pageSize}&status=active&sortBy=createdAt&sortDir=asc`;
      const body = (await (await this.get(`/annotations?${q}`)).json()) as HubPage;
      total = body.total;
      out.push(...body.items);
      if (body.items.length < pageSize || out.length >= total) break;
    }
    if (out.length !== total) throw new Error(`BookOrbit listed ${out.length} annotations but reports ${total}; skipping this run`);
    return out;
  }
}
