import { describe, expect, test } from "bun:test";
import { BookOrbitClient, mapAnnotation, mapBook, readerLink, type BookOrbitAnnotation } from "../src/bookorbit";

const ann = (i: number, extra: Partial<BookOrbitAnnotation> = {}): BookOrbitAnnotation => ({
  id: i, bookId: 10 + (i % 3), cfi: `epubcfi(/6/4!/4/${i})`, text: ` passage ${i} `, color: "#facc15", style: "highlight",
  note: null, chapterTitle: "Chapter 1", origin: "web", highlightedAt: "2024-04-29T19:38:00Z", createdAt: "2026-10-25T10:00:00Z",
  bookTitle: `Book ${10 + (i % 3)}`, author: "Someone", deletedAt: null, jumpFileId: 500 + (i % 3), jumpFileFormat: "epub",
  pageno: 10 + i, starredAt: null, ...extra,
});

describe("BookOrbit mapping", () => {
  test("keeps the passage trimmed, chapter and page as location, the original highlight time", () => {
    const h = mapAnnotation(ann(1, { note: " why " }), "https://b.x");
    expect(h).toMatchObject({
      source_app: "bookorbit", external_id: "1", doc_external_id: "11", text: "passage 1", note: "why",
      color: "#facc15", location: "Chapter 1 · p. 11", highlighted_at: "2024-04-29T19:38:00Z",
    });
  });
  test("C8: deep link opens the reader at the CFI, falls back to the page, then to the book's annotation list", () => {
    expect(readerLink(ann(1), "https://b.x")).toBe("https://b.x/read/11/501?format=epub&cfi=epubcfi%28%2F6%2F4%21%2F4%2F1%29");
    expect(readerLink(ann(1, { cfi: null, jumpFileFormat: "pdf" }), "https://b.x")).toBe("https://b.x/read/11/501?format=pdf&page=11");
    expect(mapAnnotation(ann(1, { jumpFileId: null }), "https://b.x").deep_link).toBe("https://b.x/annotations?bookId=11");
  });
  test("no chapter and no page gives no location; a missing source time falls back to createdAt", () => {
    expect(mapAnnotation(ann(1, { chapterTitle: null, pageno: null, highlightedAt: null }), "https://b.x"))
      .toMatchObject({ location: null, highlighted_at: "2026-10-25T10:00:00Z" });
  });
  test("a book document carries title and author from the hub item", () => {
    expect(mapBook(ann(1), "https://b.x")).toMatchObject({ source_app: "bookorbit", external_id: "11", kind: "book", title: "Book 11", author: "Someone" });
  });
});

describe("BookOrbitClient (A1, no silent failure)", () => {
  const fakeFetch = (total: number, opts: { reportTotal?: number; status?: number; loginStatus?: number; throttleOnce?: boolean } = {}) => {
    const calls: { url: string; init: any }[] = [];
    let throttled = false;
    const f = (async (url: string, init: any = {}) => {
      calls.push({ url, init });
      if (url.endsWith("/api/v1/auth/login")) {
        return opts.loginStatus ? new Response("no", { status: opts.loginStatus }) : Response.json({ accessToken: "jwt-abc" });
      }
      if (opts.throttleOnce && !throttled) {
        throttled = true;
        return new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } });
      }
      if (opts.status) return new Response("no", { status: opts.status });
      const u = new URL(url);
      const page = Number(u.searchParams.get("page")), size = Number(u.searchParams.get("pageSize"));
      const off = (page - 1) * size;
      const items = Array.from({ length: Math.max(0, Math.min(size, total - off)) }, (_, i) => ann(off + i + 1));
      return Response.json({ items, total: opts.reportTotal ?? total, page, pageSize: size });
    }) as unknown as typeof fetch;
    return { f, calls };
  };
  const client = (f: typeof fetch) => new BookOrbitClient("https://b.x/", "reader", "pw-secret", f, 0);

  test("pages through the active list and returns everything", async () => {
    const { f, calls } = fakeFetch(250);
    expect((await client(f).allAnnotations(100)).length).toBe(250);
    expect(calls.filter((c) => c.url.includes("/annotations?")).length).toBe(3);
    expect(calls.every((c) => !c.url.includes("/annotations?") || c.url.includes("status=active"))).toBe(true);
  });
  test("logs in once with POST, then sends only GET with the token in the header; no secret in any URL", async () => {
    const { f, calls } = fakeFetch(5);
    await client(f).allAnnotations();
    const posts = calls.filter((c) => (c.init.method ?? "GET") !== "GET");
    expect(posts.map((c) => c.url)).toEqual(["https://b.x/api/v1/auth/login"]);
    for (const c of calls.slice(1)) expect(c.init.headers.Authorization).toBe("Bearer jwt-abc");
    expect(calls.some((c) => c.url.includes("jwt-abc") || c.url.includes("pw-secret"))).toBe(false);
  });
  test("a listing short of the reported total throws instead of looking like deletions", async () => {
    const { f } = fakeFetch(40, { reportTotal: 45 });
    await expect(client(f).allAnnotations(100)).rejects.toThrow(/listed 40 .* reports 45/);
  });
  test("HTTP errors and a failed login throw, without echoing the password", async () => {
    await expect(client(fakeFetch(5, { status: 502 }).f).allAnnotations()).rejects.toThrow(/HTTP 502/);
    const err = await client(fakeFetch(5, { loginStatus: 401 }).f).allAnnotations().catch((e) => e);
    expect(String(err)).toMatch(/login answered HTTP 401/);
    expect(String(err)).not.toContain("pw-secret");
  });
  test("a 429 is waited out and retried", async () => {
    const { f } = fakeFetch(5, { throttleOnce: true });
    expect((await client(f).allAnnotations()).length).toBe(5);
  });
});
