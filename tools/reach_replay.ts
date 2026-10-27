/**
 * Local dry run (no network, no D1, nothing posted): replay test-buyer skip events through the real Worker route
 * POST /v1/trust/catalog/reachability against an in-memory catalog, then count results.
 *   npx tsx tools/reach_replay.ts <log files...>
 * Excluded sellers are dropped before replay and asserted absent from the output.
 */
import { createApp } from "../src/app";
import { MemoryCatalogStore, toListing } from "../src/trust/catalog";
import { reachView } from "../src/trust/reachability";
import { isExcludedUrl } from "../src/trust/excluded";
import { readSkips, kindOf, hostOf } from "./reach_lib";

const files = process.argv.slice(2);
const KEY = "r".repeat(52); // local fake owner key for the in-memory app only
const { checks, malformed, excluded } = readSkips(files);
const last = Date.parse(checks[checks.length - 1].checked_at);
const store = new MemoryCatalogStore();
const resources = [...new Set(checks.map((c) => c.resource))];
const ls = resources.map((resource) => toListing({ resource, type: "http", accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "10000", payTo: "0x000000000000000000000000000000000000dEaD" }] })).filter((x) => !!x);
await store.upsert(ls as any, last - 31 * 86_400_000 + 3_600_000);
const app = createApp({ XRPL_NETWORK: "xrpl:1", PAY_TO: "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH", OWNER_MCP_KEY: KEY } as any, { catalogStore: store, now: () => last + 60_000, log: () => {}, fetch: (async () => new Response("offline", { status: 599 })) as any } as any);
const tot: Record<string, number> = {};
for (let i = 0; i < checks.length; i += 200) {
  const r = await app.fetch(new Request("http://lumi.local/v1/trust/catalog/reachability", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ checks: checks.slice(i, i + 200) }) }));
  const b = (await r.json()) as Record<string, number>;
  for (const [k, v] of Object.entries(b)) tot[k] = (tot[k] ?? 0) + v;
}
const group = (pairs: [string, string][]) => {
  const m: Record<string, { count: number; hosts: Set<string> }> = {};
  for (const [k, host] of pairs) { (m[k] ??= { count: 0, hosts: new Set() }).count++; m[k].hosts.add(host); }
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1].count - a[1].count).map(([k, v]) => [k, { count: v.count, examples: [...v.hosts].slice(0, 5) }]));
};
const checkClasses = group(checks.map((c) => [kindOf(c.reason), hostOf(c.resource)]));
const rows = store.rows.filter((r) => r.reach_at != null);
const listingStatus = group(rows.map((r) => [reachView(r)!.status + (reachView(r)!.flag && reachView(r)!.flag !== reachView(r)!.status ? ` / ${reachView(r)!.flag}` : ""), r.domain]));
const strikeDist: Record<string, number> = {};
for (const r of rows) { const k = String(reachView(r)!.failed_checks_in_a_row); strikeDist[k] = (strikeDist[k] ?? 0) + 1; }
const out = {
  files, window: { from: checks[0].checked_at, to: checks[checks.length - 1].checked_at },
  skip_events: checks.length, malformed_lines: malformed, excluded_dropped: excluded, distinct_listings: resources.length,
  route_totals: tot, per_check_class: checkClasses, per_listing_status: listingStatus, failed_in_a_row_distribution: strikeDist,
};
const s = JSON.stringify(out, null, 2);
if (/agentchecklist|9dbe9ae85f9e518d4df0a8b10bbb0c786726d05a/i.test(s) || store.rows.some((r) => isExcludedUrl(r.resource))) throw new Error("excluded seller leaked into replay output");
console.log(s);
