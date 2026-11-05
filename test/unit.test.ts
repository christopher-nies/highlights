import { describe, expect, test } from "bun:test";
import { textHash, localDay } from "../src/model";
import { ReadeckClient, mapAnnotation, mapBookmark, type ReadeckAnnotation } from "../src/readeck";

const ann = (i: number, extra: Partial<ReadeckAnnotation> = {}): ReadeckAnnotation => ({
  id: `a${i}`, text: ` passage ${i} `, created: "2026-07-01T10:00:00Z", color: "yellow",
  bookmark_id: `b${i % 3}`, bookmark_url: `https://ex.com/${i % 3}`, bookmark_title: `T${i % 3}`, bookmark_site_name: "ex.com", ...extra,
});

describe("textHash (C6)", () => {
  test("same passage with different whitespace, quotes and case hashes the same", () => {
    expect(textHash("It’s  a\n“Test”")).toBe(textHash('it\'s a "test"'));
  });
  test("different passages hash differently", () => {
    expect(textHash("one")).not.toBe(textHash("two"));
  });
});

describe("localDay", () => {
  test("uses the given zone, not UTC", () => {
    expect(localDay(new Date("2026-11-05T23:30:00Z"), "Europe/Berlin")).toBe("2026-11-06");
    expect(localDay(new Date("2026-11-05T23:30:00Z"), "UTC")).toBe("2026-11-05");
  });
});

describe("Readeck mapping", () => {
  test("annotation keeps only the passage, trimmed, with a deep link to its bookmark", () => {
    const h = mapAnnotation(ann(1, { note: " why " }), "https://read.example");
    expect(h).toMatchObject({ source_app: "readeck", external_id: "a1", doc_external_id: "b1", text: "passage 1", note: "why", color: "yellow" });
    expect(h.deep_link).toBe("https://read.example/bookmarks/b1#annotation-a1");
  });
  test("bookmark authors win over the site name; a missing bookmark falls back to the annotation's own fields", () => {
    expect(mapBookmark({ id: "b1", authors: ["A", "B"], site_name: "S", published: "2026-01-01T00:00:00Z", lang: "de" }, ann(1)))
      .toMatchObject({ author: "A, B", published_at: "2026-01-01T00:00:00Z", language: "de", kind: "article" });
    expect(mapBookmark(null, ann(1))).toMatchObject({ title: "T1", author: "ex.com", url: "https://ex.com/1" });
  });
});

describe("ReadeckClient (A1, no silent failure)", () => {
  const fakeFetch = (total: number, status = 200) => {
    const calls: { url: string; init: any }[] = [];
    const f = (async (url: string, init: any) => {
      calls.push({ url, init });
      if (status !== 200) return new Response("no", { status });
      const u = new URL(url);
      const off = Number(u.searchParams.get("offset")), lim = Number(u.searchParams.get("limit"));
      return Response.json(Array.from({ length: Math.max(0, Math.min(lim, total - off)) }, (_, i) => ann(off + i)));
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  test("pages until a short page and returns everything", async () => {
    const { f, calls } = fakeFetch(250);
    const all = await new ReadeckClient("https://r.x/", "tok", f).allAnnotations(100);
    expect(all.length).toBe(250);
    expect(calls.length).toBe(3);
  });
  test("sends only GET with the token in the header, never in the URL", async () => {
    const { f, calls } = fakeFetch(5);
    await new ReadeckClient("https://r.x", "secret-tok", f).allAnnotations();
    for (const c of calls) {
      expect(c.init.method ?? "GET").toBe("GET");
      expect(c.url).not.toContain("secret-tok");
      expect(c.init.headers.Authorization).toBe("Bearer secret-tok");
    }
  });
  test("an HTTP error throws instead of looking like zero highlights", async () => {
    const { f } = fakeFetch(5, 401);
    expect(new ReadeckClient("https://r.x", "t", f).allAnnotations()).rejects.toThrow("HTTP 401");
  });
});
