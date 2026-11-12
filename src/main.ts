#!/usr/bin/env bun
/**
 * Highlights service: an ingest on a timer plus a tiny read API.
 *
 *   bun src/main.ts            serve GET /today, /random and /health, ingest at start and every INGEST_MINUTES
 *   bun src/main.ts ingest     one ingest run, prints its counters as JSON, exits
 *   bun src/main.ts today [YYYY-MM-DD]   print that day's highlight as JSON
 *   bun src/main.ts random               print one random live highlight as JSON (not recorded as surfaced)
 *   bun src/main.ts import-readwise [--dry-run]   one-off Readwise backfill (needs READWISE_TOKEN), prints a summary
 *
 * Env: DATABASE_URL, READECK_URL, READECK_TOKEN, BOOKORBIT_URL, BOOKORBIT_USERNAME, BOOKORBIT_PASSWORD,
 *      INGEST_MINUTES (60), PORT (8790), TZ (Europe/Berlin). A source runs only when all its variables are set.
 * ISA: ~/.claude/LIFEOS/USER/MEMORY/WORK/20261105-highlights-db/ISA.md
 */
import { SQL } from "bun";
import { migrate, randomHighlight, today, type Counters } from "./store";
import { importReadwise, ingestBookOrbit, ingestReadeck } from "./ingest";
import { ReadwiseClient } from "./readwise";
import { ReadeckClient } from "./readeck";
import { BookOrbitClient } from "./bookorbit";
import { localDay } from "./model";

const env = process.env;
const TZ = env.TZ || "Europe/Berlin";
const sql = new SQL(env.DATABASE_URL!);
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...extra }));

type SourceResult = { ok: boolean; counters?: Counters; error?: string };
let lastIngest: { at: string; ok: boolean; sources: Record<string, SourceResult> } | null = null;

/** Each configured source runs on its own: one source failing never stops or rolls back another. */
const sources: { name: string; configured: () => boolean; run: () => Promise<Counters> }[] = [
  {
    name: "readeck",
    configured: () => Boolean(env.READECK_URL && env.READECK_TOKEN),
    run: () => ingestReadeck(sql, new ReadeckClient(env.READECK_URL!, env.READECK_TOKEN!)),
  },
  {
    name: "bookorbit",
    configured: () => Boolean(env.BOOKORBIT_URL && env.BOOKORBIT_USERNAME && env.BOOKORBIT_PASSWORD),
    run: () => ingestBookOrbit(sql, new BookOrbitClient(env.BOOKORBIT_URL!, env.BOOKORBIT_USERNAME!, env.BOOKORBIT_PASSWORD!)),
  },
];

async function runIngest() {
  const results: Record<string, SourceResult> = {};
  for (const s of sources) {
    if (!s.configured()) continue;
    try {
      results[s.name] = { ok: true, counters: await s.run() };
    } catch (e: any) {
      results[s.name] = { ok: false, error: String(e?.message ?? e) };
    }
  }
  const names = Object.keys(results);
  const ok = names.length > 0 && names.every((n) => results[n].ok);
  lastIngest = { at: new Date().toISOString(), ok, sources: results };
  log(names.length ? (ok ? "ingest done" : "ingest failed") : "ingest skipped: no source configured", { sources: results });
  return lastIngest;
}

const cors = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });

async function serve() {
  await migrate(sql);
  const port = Number(env.PORT || 8790);
  Bun.serve({
    port,
    hostname: "0.0.0.0",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "GET") return json({ error: "read-only" }, 405);
      if (url.pathname === "/health") {
        const [{ live }] = await sql`SELECT count(*)::int AS live FROM highlights WHERE deleted_at IS NULL`;
        return json({ ok: true, live, lastIngest });
      }
      if (url.pathname === "/today") {
        const q = url.searchParams.get("date");
        const day = q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : localDay(new Date(), TZ);
        const h = await today(sql, day);
        return h ? json(h) : new Response(null, { status: 204, headers: cors });
      }
      if (url.pathname === "/random") {
        const h = await randomHighlight(sql);
        return h ? json(h) : new Response(null, { status: 204, headers: cors });
      }
      return json({ error: "not found" }, 404);
    },
  });
  log("listening", { port });
  await runIngest();
  const minutes = Math.max(5, Number(env.INGEST_MINUTES || 60));
  setInterval(runIngest, minutes * 60_000);
}

const cmd = process.argv[2];
if (cmd === "ingest") {
  await migrate(sql);
  const r = await runIngest();
  await sql.close();
  process.exit(r?.ok ? 0 : 1);
} else if (cmd === "import-readwise") {
  if (!env.READWISE_TOKEN) {
    console.error("READWISE_TOKEN is not set");
    process.exit(2);
  }
  await migrate(sql);
  const r = await importReadwise(sql, new ReadwiseClient(env.READWISE_TOKEN), { dryRun: process.argv.includes("--dry-run") });
  console.log(JSON.stringify(r, null, 1));
  await sql.close();
  process.exit(0);
} else if (cmd === "random") {
  console.log(JSON.stringify(await randomHighlight(sql), null, 1));
} else if (cmd === "today") {
  await migrate(sql);
  console.log(JSON.stringify(await today(sql, process.argv[3] || localDay(new Date(), TZ)), null, 1));
  await sql.close();
} else {
  await serve();
}
