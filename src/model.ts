/** Shapes shared by every source. A source maps its own records into these; the store never sees source formats. */

export interface DocInput {
  source_app: string;
  external_id: string;
  kind: "article" | "book" | "podcast" | "video";
  title: string | null;
  author: string | null;
  url: string | null;
  published_at: string | null;
  language: string | null;
}

export interface HighlightInput {
  source_app: string;
  external_id: string;
  doc_external_id: string;
  text: string;
  note: string | null;
  color: string | null;
  location: string | null;
  deep_link: string | null;
  highlighted_at: string | null;
  tags?: string[];
}

/** Same passage from two sources should hash the same: collapse whitespace, unify quotes, lowercase. */
export function textHash(text: string): string {
  const norm = text
    .normalize("NFKC")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return new Bun.CryptoHasher("sha256").update(norm).digest("hex");
}

/** Calendar date (YYYY-MM-DD) in the given time zone. */
export function localDay(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/**
 * The reader's own rating, written at the start of a note (C13): `*` alone or `* why` is a gem (7), `*1` to `*7` an
 * explicit score on the 1–7 scale (7 perfect … 4 passable … 1 evil). Anything else (`why *`, `*8`, `**bold**`) is no
 * rating. `text` is the note without the marker, null when nothing is left.
 */
export function noteRating(note: string | null | undefined): { score: number | null; text: string | null } {
  const trimmed = (note ?? "").trim();
  const m = /^\*([1-7])?(?=\s|$)\s*([\s\S]*)$/.exec(trimmed);
  if (!m) return { score: null, text: trimmed || null };
  return { score: m[1] ? Number(m[1]) : 7, text: m[2].trim() || null };
}

/** Pick weight of a 1–7 score: each step doubles, so a gem (7) is 8 times as likely as an unrated passage (4). */
export const scoreWeight = (score: number) => 2 ** (score - 4);
export const UNRATED_SCORE = 4;

/**
 * The day's pick among live highlights (C15). Each candidate's chance is its score weight times how long it has been
 * since it was last shown (a year or never counts in full, yesterday counts 1/365), so gems come back more often,
 * nothing ever drops to zero, and a passage just shown rests. Weighted draw by exponential race; ties go to the one
 * shown least recently. `rng` is injectable so the rotation can be simulated.
 */
export function pickWeighted(
  cands: { id: number; score: number | null; lastDay: string | null }[],
  day: string,
  rng: () => number = Math.random,
): number | null {
  const t = Date.parse(`${day}T00:00:00Z`);
  let best: { id: number; key: number; last: number } | null = null;
  for (const c of cands) {
    const last = c.lastDay ? Date.parse(`${c.lastDay}T00:00:00Z`) : -Infinity;
    const days = c.lastDay ? Math.max(0, (t - last) / 86_400_000) : 365;
    const weight = scoreWeight(c.score ?? UNRATED_SCORE) * Math.max(1, Math.min(days, 365)) / 365;
    const key = -Math.log(1 - rng()) / weight;
    if (!best || key < best.key || (key === best.key && last < best.last)) best = { id: c.id, key, last };
  }
  return best?.id ?? null;
}
