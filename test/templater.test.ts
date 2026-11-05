/** C11: the Templater user script renders a callout when the service answers and stays silent when it does not. */
import { describe, expect, test } from "bun:test";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const daily = require("../obsidian/daily_highlight.js");

const sample = {
  date: "2026-11-05", id: 7, text: "The map is not\nthe territory.", note: "Applies to BIM models too",
  color: "yellow", title: "On [maps]", author: "A. Korzybski", url: "https://ex.com/maps",
  deep_link: "https://readeck.example.test/bookmarks/b1#annotation-a1", source_app: "readeck", kind: "article", highlighted_at: null,
};

const BASE = "http://highlights.example.test:8790/";
const tpWith = (requestUrl: (o: any) => Promise<any>, title = "2026-11-05") => ({ file: { title }, obsidian: { requestUrl } });

describe("daily_highlight Templater script (C11)", () => {
  test("service up: a quote callout with text, note and a linked source; asks for the note's own date", async () => {
    let asked = "";
    const out = await daily(tpWith(async (o) => ((asked = o.url), { status: 200, json: sample })), BASE);
    expect(asked).toBe("http://highlights.example.test:8790/today?date=2026-11-05");
    expect(out).toBe(
      [
        "> [!quote] From your highlights",
        "> The map is not",
        "> the territory.",
        ">",
        "> 💭 Applies to BIM models too",
        ">",
        "> — A. Korzybski, [On maps](https://readeck.example.test/bookmarks/b1#annotation-a1)",
      ].join("\n"),
    );
  });

  test("empty store (204): nothing is written", async () => {
    expect(await daily(tpWith(async () => ({ status: 204, json: null })), BASE)).toBe("");
  });

  test("service down (network error): nothing is written and nothing throws", async () => {
    expect(await daily(tpWith(async () => { throw new Error("net::ERR_CONNECTION_REFUSED"); }), BASE)).toBe("");
  });

  test("service hangs (away from home): gives up after the timeout and writes nothing", async () => {
    const t0 = Date.now();
    expect(await daily(tpWith(() => new Promise(() => {})), BASE)).toBe("");
    expect(Date.now() - t0).toBeLessThan(6000);
  }, 8000);

  test("no address passed: nothing is fetched and nothing is written", async () => {
    let called = false;
    expect(await daily(tpWith(async () => ((called = true), { status: 200, json: sample })))).toBe("");
    expect(called).toBe(false);
  });

  test("a note whose title is not a date asks for today", async () => {
    let asked = "";
    await daily(tpWith(async (o) => ((asked = o.url), { status: 204 }), "Some note"), BASE);
    expect(asked).toBe("http://highlights.example.test:8790/today");
  });
});
