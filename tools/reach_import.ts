/**
 * Nightly import of test-buyer skip events into listing reachability (dead-listing flags). Box-side; NOT scheduled yet.
 * Reads /workspace/notes/vendor_research/base_buys/log.jsonl skip events newer than the cursor and POSTs them, at most
 * 200 per request, to the owner-only POST /v1/trust/catalog/reachability. It never buys, signs or moves money, and the
 * test-buyer (catalog_buys.ts) is unchanged: its caps and buy logic stay as they are.
 *
 *   npx tsx tools/reach_import.ts --dry      # classify and count locally, post nothing
 *   npx tsx tools/reach_import.ts            # post (needs the Worker route deployed + migration 0031 applied)
 *
 * The owner key is read from a file and never printed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readSkips, kindOf, cursorFrom, advanceCursor, type ReachCursor } from "./reach_lib";

// The owner key may only ever go to production: a LUMI_API override is accepted only if it IS the production origin
// (security review 2026-10-27); anything else refuses to run before the key is read.
export const PROD_API = "https://api.lumitrades.io";
export function apiBase(override: string | undefined): string {
  if (override === undefined || override === PROD_API) return PROD_API;
  throw new Error(`LUMI_API override refused: only ${PROD_API} is allowed (owner key is never sent elsewhere)`);
}
let API = PROD_API;
const DIR = "/workspace/notes/vendor_research/base_buys";
const LOG = process.env.REACH_LOG ?? `${DIR}/log.jsonl`;
const CURSOR = `${DIR}/reach_import_cursor.json`;
const OWNER_KEY_FILE = "/workspace/secrets/lumi_owner_mcp_key.txt";
const DRY = process.argv.includes("--dry");
const MAX = 200;

async function main() {
  API = apiBase(process.env.LUMI_API);
  const since: ReachCursor | undefined = existsSync(CURSOR) ? cursorFrom(JSON.parse(readFileSync(CURSOR, "utf8"))) : undefined;
  const { checks, malformed, excluded } = readSkips([LOG], since);
  const byKind: Record<string, number> = {};
  for (const c of checks) byKind[kindOf(c.reason)] = (byKind[kindOf(c.reason)] ?? 0) + 1;
  if (DRY || !checks.length) { console.log(JSON.stringify({ mode: DRY ? "dry" : "nothing_new", since: since?.ts ?? null, checks: checks.length, malformed, excluded, by_kind: byKind })); return; }
  const key = readFileSync(OWNER_KEY_FILE, "utf8").trim();
  const tot = { recorded: 0, unknown: 0, ignored: 0, excluded: 0, written: 0 };
  let last = since;
  for (let i = 0; i < checks.length; i += MAX) {
    const part = checks.slice(i, i + MAX);
    const r = await fetch(`${API}/v1/trust/catalog/reachability`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": "lumi-reach-import" },
      body: JSON.stringify({ checks: part }), signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!r || r.status !== 200) { console.log(JSON.stringify({ event: "reach_import_stopped", http: r?.status ?? 0, posted_batches: i / MAX })); break; }
    const b = (await r.json()) as Record<string, number>;
    for (const k of Object.keys(tot) as (keyof typeof tot)[]) tot[k] += b[k] ?? 0;
    last = advanceCursor(last, part);
    writeFileSync(CURSOR, JSON.stringify({ last_ts: last!.ts, last_resources: last!.resources, at: new Date().toISOString() }));
  }
  console.log(JSON.stringify({ event: "reach_import", checks: checks.length, malformed, excluded_local: excluded, ...tot, cursor: last?.ts ?? null }));
}
if (!process.env.VITEST) main().catch((e) => { console.error("reach_import failed:", String(e?.message ?? e).slice(0, 200)); process.exitCode = 1; });
