/**
 * Snipd podcast snips, read from the API the official Snipd Obsidian plugin uses (api.snipd.com/v1/public/api):
 * GET obsidian/fetch-export-metadata lists every episode with snips, POST obsidian/export-episode-snips renders the
 * chosen episodes through a template and answers with a zip of markdown files. The API is undocumented and may change.
 * The template here puts one field per `@@name` line, so the export parses without guessing at markdown.
 * The token is the one Snipd hands out at app.snipd.com/obsidian/auth (Bearer).
 */
import type { DocInput, HighlightInput } from "./model";
import { unzipText } from "./zip";

const API = "https://api.snipd.com/v1/public/api/obsidian";

const EPISODE_FIELDS = ["episode_title", "show_title", "episode_url", "episode_publish_date"] as const;
const SNIP_FIELDS = [
  "snip_url", "snip_title", "snip_favorite_star", "snip_start_time", "snip_created_time", "snip_tags", "snip_note", "snip_quote",
] as const;
const field = (k: string) => `@@${k}\n{{${k}}}\n`;
export const EPISODE_TEMPLATE = "@@EPISODE\n" + EPISODE_FIELDS.map(field).join("") + "{{snips_section}}";
export const SNIP_TEMPLATE = "@@SNIP\n" + SNIP_FIELDS.map(field).join("") + "@@END\n";

export interface SnipdEpisodeMeta {
  episode_id: string;
  latest_snip_update_ts: string;
  total_snip_count: number;
}
export interface SnipdMetadata {
  episode_batch_count: number;
  episode_batches: { index: number; episodes: SnipdEpisodeMeta[] }[];
}

export type SnipdEpisode = { id: string } & Partial<Record<(typeof EPISODE_FIELDS)[number], string>>;
export type SnipdSnip = Partial<Record<(typeof SNIP_FIELDS)[number], string>>;

export class SnipdClient {
  constructor(
    private token: string,
    private fetcher: typeof fetch = fetch,
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetcher(`${API}/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`snipd ${path} answered ${res.status}`);
    return res;
  }

  metadata(): Promise<SnipdMetadata> {
    return this.call("fetch-export-metadata").then((r) => r.json() as Promise<SnipdMetadata>);
  }

  /** The rendered markdown of these episodes, one file per episode, keyed by its zip path. */
  async exportEpisodes(episodeIds: string[]): Promise<Map<string, string>> {
    const body = JSON.stringify({ episode_ids: episodeIds, episode_template: EPISODE_TEMPLATE, snip_template: SNIP_TEMPLATE });
    return unzipText(await (await this.call("export-episode-snips", { method: "POST", body })).arrayBuffer());
  }
}

/** The `@@name` fields of one block, only names from the template, each value trimmed. */
function fields(block: string, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let key: string | null = null;
  let lines: string[] = [];
  const flush = () => { if (key) out[key] = lines.join("\n").trim(); };
  for (const line of block.split("\n")) {
    const m = /^@@([a-z_]+)$/.exec(line);
    if (m && names.includes(m[1])) { flush(); key = m[1]; lines = []; }
    else if (key) lines.push(line);
  }
  flush();
  return out;
}

/** One exported episode file: the episode fields and its snips. The episode id comes from the file name. */
export function parseEpisodeFile(path: string, md: string): { episode: SnipdEpisode; snips: SnipdSnip[] } | null {
  const id = /([0-9a-f-]{36})_full_content\.md$/.exec(path)?.[1];
  const at = md.search(/^@@EPISODE$/m);
  if (!id || at < 0) return null;
  const [head, ...rest] = md.slice(at).split(/^@@SNIP$/m);
  return {
    episode: { id, ...fields(head, EPISODE_FIELDS) },
    snips: rest.map((b) => fields(b.split(/^@@END$/m)[0], SNIP_FIELDS) as SnipdSnip),
  };
}

/** The speaker's words from the rendered quote: `> ` lines without the `> — Speaker` line, and that speaker. */
export function splitQuote(quote: string | undefined): { text: string; speaker: string | null } {
  let speaker: string | null = null;
  const words: string[] = [];
  for (const raw of (quote ?? "").split("\n")) {
    if (!raw.startsWith(">")) continue; // the line after the quote is Snipd's own one-line context, not his
    const line = raw.replace(/^>\s?/, "");
    const who = /^[—–-]\s*(.+)$/.exec(line.trim());
    if (who) speaker = who[1].trim();
    else words.push(line);
  }
  return { text: words.join("\n").replace(/\n{3,}/g, "\n\n").trim(), speaker };
}

const snipId = (url: string | undefined) => /\/snip\/([0-9a-f-]+)/.exec(url ?? "")?.[1] ?? url ?? null;

/** A snip as a highlight, or null when it carries no words (a bare audio clip). */
export function mapSnip(s: SnipdSnip, episodeId: string): HighlightInput | null {
  const id = snipId(s.snip_url);
  const { text: quote, speaker } = splitQuote(s.snip_quote);
  const ownNote = (s.snip_note ?? "").split("\n").map((l) => l.replace(/^\s*[-*]\s+/, "").trimEnd()).join("\n").trim();
  const text = quote || ownNote;
  if (!id || !text) return null;
  const location = [s.snip_start_time, speaker, s.snip_title].filter((x) => x?.trim()).join(" · ");
  return {
    source_app: "snipd",
    external_id: id,
    doc_external_id: episodeId,
    text,
    note: s.snip_favorite_star?.trim() ? "*" : null,
    color: null,
    location: location || null,
    deep_link: s.snip_url || null,
    highlighted_at: s.snip_created_time || null,
    tags: [...(s.snip_tags ?? "").matchAll(/#([^\s#]+)/g)].map((m) => m[1]),
  };
}

export function mapEpisode(e: SnipdEpisode): DocInput {
  return {
    source_app: "snipd",
    external_id: e.id,
    kind: "podcast",
    title: e.episode_title || null,
    author: e.show_title || null,
    url: e.episode_url || null,
    published_at: /^\d{4}-\d{2}-\d{2}/.test(e.episode_publish_date ?? "") ? e.episode_publish_date! : null,
    language: null,
  };
}
