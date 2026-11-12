import { describe, expect, test } from "bun:test";
import { ReadwiseClient, isOwnDocument, mapBook, mapHighlight, type ReadwiseBook, type ReadwiseHighlight } from "../src/readwise";

const hl = (id: number, extra: Partial<ReadwiseHighlight> = {}): ReadwiseHighlight => ({
  id, text: ` Passage ${id} `, note: null, color: null, location: 3, location_type: "order", highlighted_at: "2023-01-02T03:04:05Z",
  created_at: "2023-01-02T03:04:05Z", url: null, readwise_url: `https://readwise.io/open/${id}`, tags: [], is_favorite: false,
  is_discard: false, is_deleted: false, ...extra,
});
const book = (extra: Partial<ReadwiseBook> = {}): ReadwiseBook => ({
  user_book_id: 7, title: "T", readable_title: "Readable T", author: "A", category: "articles", source: "reader",
  source_url: "https://ex.com/post", unique_url: null, readwise_url: "https://readwise.io/bookreview/7", is_deleted: false,
  highlights: [hl(1)], ...extra,
});

describe("Readwise: only the reader's own highlights", () => {
  test("supplementals and Reader's FAQ are skipped; his own readwise.io uploads and Reader documents are kept", () => {
    expect(isOwnDocument(book())).toBe(true);
    expect(isOwnDocument(book({ category: "podcasts", source: "airr", source_url: null }))).toBe(true);
    expect(isOwnDocument(book({ category: "supplementals", source: "supplemental" }))).toBe(false);
    expect(isOwnDocument(book({ title: "Reader: Frequently Asked Questions", source_url: "https://blog.readwise.io/p/f8c0/" }))).toBe(false);
    expect(isOwnDocument(book({ category: "books", source_url: "https://readwise.io/reader/document_raw_content/46635824" }))).toBe(true);
    expect(isOwnDocument(book({ unique_url: "https://read.readwise.io/read/01abc" }))).toBe(true);
    expect(isOwnDocument(book({ title: "How to Actually Use What You Read with Readwise", source_url: "https://blog.readwise.io/reading-workflow-part-1/" }))).toBe(true);
    expect(isOwnDocument(book({ is_deleted: true }))).toBe(false);
  });
});

describe("Readwise mapping", () => {
  test("book maps to a document with its kind and original url", () => {
    expect(mapBook(book())).toMatchObject({ source_app: "readwise", external_id: "7", kind: "article", title: "Readable T", url: "https://ex.com/post" });
    expect(mapBook(book({ category: "books" })).kind).toBe("book");
    expect(mapBook(book({ category: "podcasts" })).kind).toBe("podcast");
  });

  test("highlight keeps passage, note, tags; links to the original page before Readwise", () => {
    const h = mapHighlight(hl(1, { note: " why ", tags: [{ name: "bim" }] }), book());
    expect(h).toMatchObject({ source_app: "readwise", external_id: "1", doc_external_id: "7", text: "Passage 1", note: "why", tags: ["bim"] });
    expect(h.deep_link).toBe("https://ex.com/post");
    expect(mapHighlight(hl(2, { url: "https://ex.com/post#h2" }), book()).deep_link).toBe("https://ex.com/post#h2");
    expect(mapHighlight(hl(3), book({ source_url: null })).deep_link).toBe("https://readwise.io/open/3");
  });

  test("a favourite becomes a gem in the note notation; an explicit rating stays", () => {
    expect(mapHighlight(hl(1, { is_favorite: true }), book()).note).toBe("*");
    expect(mapHighlight(hl(1, { is_favorite: true, note: "why" }), book()).note).toBe("* why");
    expect(mapHighlight(hl(1, { is_favorite: true, note: "*3 meh" }), book()).note).toBe("*3 meh");
    expect(mapHighlight(hl(1, { note: "plain" }), book()).note).toBe("plain");
  });

  test("locations: page, Kindle location, podcast time; list order is dropped", () => {
    expect(mapHighlight(hl(1, { location: 12, location_type: "page" }), book()).location).toBe("p. 12");
    expect(mapHighlight(hl(1, { location: 345, location_type: "location" }), book()).location).toBe("loc. 345");
    expect(mapHighlight(hl(1, { location: 125, location_type: "time_offset" }), book()).location).toBe("2:05");
    expect(mapHighlight(hl(1), book()).location).toBeNull();
  });
});

describe("Readwise client", () => {
  test("follows pageCursor, sends the token as a header only, waits on 429", async () => {
    const calls: string[] = [];
    const slept: number[] = [];
    const pages = [
      new Response("", { status: 429, headers: { "Retry-After": "2" } }),
      Response.json({ results: [book()], nextPageCursor: "c2" }),
      Response.json({ results: [book({ user_book_id: 8 })], nextPageCursor: null }),
    ];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push(url);
      expect((init.headers as Record<string, string>).Authorization).toBe("Token tok");
      return pages.shift()!;
    }) as unknown as typeof fetch;
    const books = await new ReadwiseClient("tok", fetcher, async (ms) => slept.push(ms)).allBooks();
    expect(books.map((b) => b.user_book_id)).toEqual([7, 8]);
    expect(slept).toEqual([2000]);
    expect(calls.every((u) => !u.includes("tok"))).toBe(true);
    expect(calls[2]).toBe("https://readwise.io/api/v2/export/?pageCursor=c2");
  });

  test("a non-OK answer fails the run instead of importing a partial list", async () => {
    const fetcher = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    expect(new ReadwiseClient("bad", fetcher).allBooks()).rejects.toThrow("401");
  });
});
