import { describe, expect, test } from "bun:test";
import { join } from "path";
import { EPISODE_TEMPLATE, SNIP_TEMPLATE, SnipdClient, mapEpisode, mapSnip, parseEpisodeFile, splitQuote } from "../src/snipd";
import { unzipText } from "../src/zip";

const fixture = (name: string) => Bun.file(join(import.meta.dir, "fixtures", name)).arrayBuffer();
const EPISODE = "11111111-2222-4333-8444-555555555555";
const PATH = `episodes/${EPISODE}_full_content.md`;

describe("zip", () => {
  test("reads deflated and stored entries alike, skipping directories", async () => {
    const deflated = unzipText(await fixture("snipd-export.zip"));
    const stored = unzipText(await fixture("snipd-export-stored.zip"));
    expect([...deflated.keys()].sort()).toEqual([PATH, "metadata.json"]);
    expect(deflated.get(PATH)).toBe(stored.get(PATH)!);
    expect(deflated.get(PATH)).toContain("@@EPISODE");
  });

  test("refuses something that is not a zip", () => {
    expect(() => unzipText(new TextEncoder().encode("not a zip at all, just text"))).toThrow("not a zip");
  });
});

describe("Snipd export parsing (C19)", () => {
  const load = async () => parseEpisodeFile(PATH, unzipText(await fixture("snipd-export.zip")).get(PATH)!)!;

  test("episode fields come from the template block, the id from the file name", async () => {
    const { episode, snips } = await load();
    expect(snips).toHaveLength(4);
    expect(mapEpisode(episode)).toEqual({
      source_app: "snipd", external_id: EPISODE, kind: "podcast", title: "A Test Episode", author: "The Test Show",
      url: `https://share.snipd.com/episode/${EPISODE}`, published_at: "2025-10-17", language: null,
    });
  });

  test("the quote is the text, without the speaker line or Snipd's context line; AI bullets never reach the note", async () => {
    const { snips } = await load();
    expect(mapSnip(snips[0], EPISODE)).toEqual({
      source_app: "snipd", external_id: "aaaaaaaa-0000-4000-8000-000000000001", doc_external_id: EPISODE,
      text: "First line of what was said.\n\nSecond paragraph of it.", note: null, color: null,
      location: "00:10 · Some Speaker · Quote With Context",
      deep_link: "https://share.snipd.com/snip/aaaaaaaa-0000-4000-8000-000000000001",
      highlighted_at: "2026-11-06T18:42:01Z", tags: [],
    });
  });

  test("a snip without a quote uses its own note; one with neither is skipped", async () => {
    const { snips } = await load();
    expect(mapSnip(snips[1], EPISODE)).toMatchObject({ text: "Lens of curiosity: not about failing or succeeding", note: null, location: "12:03 · His Own Note" });
    expect(mapSnip(snips[2], EPISODE)).toBeNull();
  });

  test("a starred snip is a gem; tags are read; a `* ` bullet note does not make a gem", async () => {
    const { snips } = await load();
    expect(mapSnip(snips[3], EPISODE)).toMatchObject({ text: "Picture the moments before they happen.", note: "*", tags: ["bim", "ai"] });
    const unstarred = mapSnip({ ...snips[3], snip_favorite_star: "", snip_quote: "" }, EPISODE)!;
    expect(unstarred.note).toBeNull();
    expect(unstarred.text).toBe("Imagine the day beforehand.\nWalk through it step by step.");
  });

  test("splitQuote handles en dash and hyphen attributions and no quote", () => {
    expect(splitQuote("> Words.\n> – Someone")).toEqual({ text: "Words.", speaker: "Someone" });
    expect(splitQuote("> Words.\n> - Someone")).toEqual({ text: "Words.", speaker: "Someone" });
    expect(splitQuote(undefined)).toEqual({ text: "", speaker: null });
  });
});

describe("Snipd client", () => {
  test("lists with GET, exports with POST carrying the ids and both templates, Bearer token on each", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const zip = await fixture("snipd-export.zip");
    const fake = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url.endsWith("/fetch-export-metadata")) {
        return Response.json({ episode_batch_count: 1, episode_batches: [{ index: 0, episodes: [{ episode_id: EPISODE, latest_snip_update_ts: "2026-11-07T09:00:00Z", total_snip_count: 4 }] }] });
      }
      return new Response(zip, { headers: { "content-type": "application/zip" } });
    }) as unknown as typeof fetch;
    const client = new SnipdClient("tok", fake);
    const meta = await client.metadata();
    const files = await client.exportEpisodes(meta.episode_batches[0].episodes.map((e) => e.episode_id));
    expect(files.has(PATH)).toBe(true);
    expect(calls.map((c) => c.init.method ?? "GET")).toEqual(["GET", "POST"]);
    for (const c of calls) expect((c.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ episode_ids: [EPISODE], episode_template: EPISODE_TEMPLATE, snip_template: SNIP_TEMPLATE });
  });

  test("a failed call throws with its status", async () => {
    const client = new SnipdClient("bad", (async () => new Response("no", { status: 401 })) as unknown as typeof fetch);
    expect(client.metadata()).rejects.toThrow("401");
  });
});
