/**
 * Lumi API traffic summary (owner-only): daily counts, top paths, user agents, referrers, 402s vs paid.
 *   npx tsx tools/traffic_summary.ts            # last 7 days, human-readable
 *   TRAFFIC_DAYS=30 npx tsx tools/traffic_summary.ts
 *   TRAFFIC_JSON=1 npx tsx tools/traffic_summary.ts
 * Owner key: LUMI_OWNER_KEY env var, or the file named by LUMI_OWNER_KEY_FILE. It is never printed.
 * Calls GET /v1/owner/traffic?days=N. The log stores no raw IPs (daily-rotating keyed hashes only).
 */
import { readFileSync } from "node:fs";

async function main() {
  const API = process.env.LUMI_API_URL ?? "https://api.lumitrades.io";
  const key = (process.env.LUMI_OWNER_KEY ?? (process.env.LUMI_OWNER_KEY_FILE ? readFileSync(process.env.LUMI_OWNER_KEY_FILE, "utf8") : "")).trim();
  if (!key) {
    console.error("Set LUMI_OWNER_KEY or LUMI_OWNER_KEY_FILE.");
    process.exit(2);
  }
  const days = process.env.TRAFFIC_DAYS ?? "7";
  const r = await fetch(`${API}/v1/owner/traffic?days=${encodeURIComponent(days)}`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
  if (!r.ok) {
    console.error(`GET /v1/owner/traffic -> HTTP ${r.status}`);
    process.exit(1);
  }
  const s: any = await r.json();
  if (process.env.TRAFFIC_JSON === "1") {
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  const t = s.totals;
  console.log(`Lumi API traffic ${s.window.from} .. ${s.window.to} (${s.window.days} d), generated ${s.generated_at}${s.truncated ? " [truncated]" : ""}${s.logging ? "" : " [logging OFF]"}`);
  console.log(`Requests ${t.requests}, visitor-days ${t.visitor_days}, 402s ${t.payment_required_402}, paid ${t.paid}${t.paid_outside != null ? ` (outside ${t.paid_outside}, $${t.usd_outside}; Lumi tests ${t.paid_test})` : ""}${t.paid_per_402 != null ? ` (${(t.paid_per_402 * 100).toFixed(1)}% of 402s)` : ""}`);
  console.log(`By client: ${Object.entries(t.by_client).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}`);
  console.log(`By status: ${Object.entries(t.by_status).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}`);
  console.log("\nDaily:");
  console.log("  day          requests visitors   402s  paid  outside  test  outside$  browser  other");
  for (const d of s.daily) console.log(`  ${d.day}  ${String(d.requests).padStart(8)} ${String(d.visitors).padStart(8)} ${String(d.payment_required_402).padStart(6)} ${String(d.paid).padStart(5)} ${String(d.paid_outside ?? "-").padStart(8)} ${String(d.paid_test ?? "-").padStart(5)} ${String(d.usd_outside ?? "-").padStart(9)} ${String(d.browser).padStart(8)} ${String(d.non_browser).padStart(6)}`);
  const list = (title: string, rows: any[]) => {
    console.log(`\n${title}:`);
    if (!rows.length) console.log("  -");
    for (const x of rows) console.log(`  ${String(x.requests).padStart(6)}  ${String(x.visitor_days).padStart(5)} vd  ${x.key}`);
  };
  list("Top paths", s.top_paths);
  list("Top 402 paths", s.top_402_paths);
  list("Top paid paths", s.top_paid_paths);
  list("Top user agents", s.top_user_agents);
  list("Top referrers", s.top_referrers);
  list("Top countries", s.top_countries);
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
