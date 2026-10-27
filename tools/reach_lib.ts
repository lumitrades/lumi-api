/** Shared by reach_import.ts / reach_replay.ts: read test-buyer skip events (log.jsonl lines) as reachability checks. */
import { readFileSync } from "node:fs";
import { isExcludedUrl } from "../src/trust/excluded";
import { classifySkipReason } from "../src/trust/reachability";

export interface SkipCheck { resource: string; reason: string; checked_at: string }

/** Skip events with a resource, oldest first, deduped by (ts, resource). Excluded sellers are dropped here, before anything else. */
export function readSkips(files: string[], sinceIso?: string): { checks: SkipCheck[]; malformed: number; excluded: number } {
  const seen = new Set<string>();
  const checks: SkipCheck[] = [];
  let malformed = 0, excluded = 0;
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e: any;
      try { e = JSON.parse(line); } catch { malformed++; continue; }
      if (e?.event !== "skip" || typeof e.resource !== "string" || typeof e.ts !== "string") continue;
      if (sinceIso && e.ts <= sinceIso) continue;
      if (isExcludedUrl(e.resource)) { excluded++; continue; }
      const k = e.ts + " " + e.resource;
      if (seen.has(k)) continue;
      seen.add(k);
      checks.push({ resource: e.resource, reason: String(e.reason ?? "").slice(0, 300), checked_at: e.ts });
    }
  }
  checks.sort((a, b) => a.checked_at.localeCompare(b.checked_at));
  return { checks, malformed, excluded };
}

export const kindOf = (reason: string) => classifySkipReason(reason)?.kind ?? "not_recorded";
export const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return "?"; } };
