#!/usr/bin/env bun
/**
 * Highlights service: an ingest on a timer plus a tiny read API.
 *
 *   bun src/main.ts            serve GET /today, /random and /health, ingest at start and every INGEST_MINUTES
 *   bun src/main.ts ingest     one ingest run, prints its counters as JSON, exits
 *   bun src/main.ts today [YYYY-MM-DD]   print that day's highlight as JSON
 *   bun src/main.ts random               print one random live highlight as JSON (not recorded as surfaced)
 *
 * Env: DATABASE_URL, READECK_URL, READECK_TOKEN, INGEST_MINUTES (60), PORT (8790), TZ (Europe/Berlin).
 * ISA: ~/.claude/LIFEOS/USER/MEMORY/WORK/20261105-highlights-db/ISA.md
 */
import { SQL } from "bun";
import { migrate, randomHighlight, today } from "./store";
import { ingestReadeck } from "./ingest";
import { ReadeckClient } from "./readeck";
import { localDay } from "./model";

const env = process.env;
const TZ = env.TZ || "Europe/Berlin";
const sql = new SQL(env.DATABASE_URL!);
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...extra }));

let lastIngest: { at: string; ok: boolean; counters?: unknown; error?: string } | null = null;

async function runIngest() {
  if (!env.READECK_URL || !env.READECK_TOKEN) {
    lastIngest = { at: new Date().toISOString(), ok: false, error: "READECK_URL or READECK_TOKEN not set" };
    log("ingest skipped", { reason: lastIngest.error });
    return lastIngest;
  }
  try {
    const counters = await ingestReadeck(sql, new ReadeckClient(env.READECK_URL, env.READECK_TOKEN));
    lastIngest = { at: new Date().toISOString(), ok: true, counters: { readeck: counters } };
    log("ingest done", { readeck: counters });
  } catch (e: any) {
    lastIngest = { at: new Date().toISOString(), ok: false, error: String(e?.message ?? e) };
    log("ingest failed", { error: lastIngest.error });
  }
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
} else if (cmd === "random") {
  console.log(JSON.stringify(await randomHighlight(sql), null, 1));
} else if (cmd === "today") {
  await migrate(sql);
  console.log(JSON.stringify(await today(sql, process.argv[3] || localDay(new Date(), TZ)), null, 1));
  await sql.close();
} else {
  await serve();
}
