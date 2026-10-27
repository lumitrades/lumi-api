/** Shared by reach_import.ts / reach_replay.ts: read test-buyer skip events (log.jsonl lines) as reachability checks. */
import { readFileSync } from "node:fs";
import { isExcludedUrl } from "../src/trust/excluded";
import { classifySkipReason } from "../src/trust/reachability";

export interface SkipCheck { resource: string; reason: string; checked_at: string }

/**
 * Import progress as the pair (timestamp, resource): `ts` is the newest checked_at already posted and `resources` are the
 * resources already posted AT that timestamp. Events sharing a timestamp across a 200-check batch boundary are therefore
 * not dropped (the old `ts <= since` rule skipped the unposted rest of that timestamp). A legacy cursor (string, or no
 * `resources`) keeps the old meaning: everything at or before `ts` was posted (it was only written after a whole run).
 */
export interface ReachCursor { ts: string; resources?: string[] }
export function cursorFrom(raw: unknown): ReachCursor | undefined {
  if (typeof raw === "string") return { ts: raw };
  const o = raw as any;
  if (!o || typeof o.last_ts !== "string") return undefined;
  return Array.isArray(o.last_resources) ? { ts: o.last_ts, resources: o.last_resources.filter((r: unknown) => typeof r === "string") } : { ts: o.last_ts };
}
export function alreadyPosted(c: ReachCursor | undefined, ts: string, resource: string): boolean {
  if (!c) return false;
  if (ts < c.ts) return true;
  if (ts > c.ts) return false;
  return c.resources ? c.resources.includes(resource) : true; // legacy cursor: ts == since counted as posted
}
/** Cursor after posting `posted` (sorted by (ts, resource)) on top of `prev`. */
export function advanceCursor(prev: ReachCursor | undefined, posted: SkipCheck[]): ReachCursor | undefined {
  if (!posted.length) return prev;
  const ts = posted[posted.length - 1].checked_at;
  const here = posted.filter((c) => c.checked_at === ts).map((c) => c.resource);
  const carried = prev && prev.ts === ts ? (prev.resources ?? []) : [];
  return { ts, resources: [...new Set([...carried, ...here])] };
}
const byTsRes = (a: SkipCheck, b: SkipCheck) => a.checked_at.localeCompare(b.checked_at) || a.resource.localeCompare(b.resource);

/** Skip events with a resource, oldest first (by timestamp, then resource), deduped by (ts, resource), excluding those the
 * cursor says were already posted. Excluded sellers are dropped here, before anything else. */
export function readSkips(files: string[], since?: string | ReachCursor): { checks: SkipCheck[]; malformed: number; excluded: number } {
  const cur: ReachCursor | undefined = typeof since === "string" ? { ts: since } : since;
  const seen = new Set<string>();
  const checks: SkipCheck[] = [];
  let malformed = 0, excluded = 0;
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e: any;
      try { e = JSON.parse(line); } catch { malformed++; continue; }
      if (e?.event !== "skip" || typeof e.resource !== "string" || typeof e.ts !== "string") continue;
      if (alreadyPosted(cur, e.ts, e.resource)) continue;
      if (isExcludedUrl(e.resource)) { excluded++; continue; }
      const k = e.ts + " " + e.resource;
      if (seen.has(k)) continue;
      seen.add(k);
      checks.push({ resource: e.resource, reason: String(e.reason ?? "").slice(0, 300), checked_at: e.ts });
    }
  }
  checks.sort(byTsRes);
  return { checks, malformed, excluded };
}

export const kindOf = (reason: string) => classifySkipReason(reason)?.kind ?? "not_recorded";
export const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return "?"; } };
