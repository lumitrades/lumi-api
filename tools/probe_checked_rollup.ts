// Rollup for the free probe-checked tier (box-side, read-only). Usage: PC=/tmp/pc OUT=<dir> npx tsx tools/probe_checked_rollup.ts
// Seller key = registrableDomain() (same key the API looks up). Dedupe: sellers sharing a payTo are one seller for counting.
// Output stores no payTo, no amounts, no payer data; summary has aggregate counts only.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { registrableDomain } from "../src/trust/catalog";
import { rollupSeller, toRow, parseProbeRow, PROBE_MAX_ROWS_PER_LOAD, type EndpointProbe, type HistoryBand, type SellerProbeResult } from "../src/trust/probe_checked";

const PC = process.env.PC ?? "/tmp/pc";
const OUT = process.env.OUT ?? "/tmp/pc/out";
const T = JSON.parse(readFileSync(`${PC}/targets.json`, "utf8"));
const P = JSON.parse(readFileSync(process.env.RESULTS ?? `${PC}/probe_results.json`, "utf8"));
const onchain = new Set<string>(T.onchain.map((o: any) => o.recipient.toLowerCase()));
const actPay = new Set<string>(T.act_paytos.map((a: string) => a.toLowerCase()));
const evm = (a: string) => /^0x[0-9a-f]{40}$/.test(a);
const addr = (k: string) => (k.includes("|") ? k.split("|").pop()! : k).toLowerCase();

type S = { key: string; hosts: Set<string>; sources: Set<string>; payTos: Set<string>; base: boolean; activity: boolean; buys: number; delivered: number; baseBuy: boolean; prodValid: boolean; endpoints: EndpointProbe[]; complete: boolean | null };
const sellers = new Map<string, S>();
const get = (host: string) => {
  const key = registrableDomain(host) ?? host;
  let s = sellers.get(key);
  if (!s) sellers.set(key, (s = { key, hosts: new Set(), sources: new Set(), payTos: new Set(), base: false, activity: false, buys: 0, delivered: 0, baseBuy: false, prodValid: false, endpoints: [], complete: null }));
  s.hosts.add(host); return s;
};
for (const h of T.hosts) {
  if (h.host === "lumitrades.io" || h.host.endsWith(".lumitrades.io")) continue;
  const s = get(h.host);
  h.sources.forEach((x: string) => s.sources.add(x));
  (h.pay_tos ?? []).forEach((p: string) => s.payTos.add(addr(p)));
  if (h.base_listed) s.base = true;
  if (h.sources.includes("activity")) s.activity = true;
  if (h.target?.prod_valid) s.prodValid = true;
  if (h.buys) { s.buys += h.buys.n; s.delivered += h.buys.delivered; if (h.buys.base) s.baseBuy = true; }
}
for (const nh of P.new_hosts ?? []) get(nh).sources.add("wellknown");
for (const r of P.results) {
  if (!r.host || r.host.endsWith("lumitrades.io")) continue;
  const s = get(r.host);
  if (r.wellknown?.ok) s.sources.add("wellknown");
  const p = r.probe; if (!p) continue;
  s.endpoints.push({ endpoint: p.url, ts: P.started, status: p.status, latency_ms: p.latency_ms, error: p.error, quote: p.quote });
  if (p.quote?.base_offer) s.base = true;
  (p.pay_tos_all ?? []).forEach((k: string) => s.payTos.add(addr(k)));
  if (p.complete_402 != null) s.complete = (s.complete ?? false) || !!p.complete_402;
}
for (const s of sellers.values()) for (const a of s.payTos) { if (onchain.has(a)) s.base = true; if (actPay.has(a)) s.activity = true; }

// Union-find over shared payTo (count dedupe only).
const parent = new Map<string, string>(); const find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
const byPay = new Map<string, string>();
for (const s of sellers.values()) for (const a of s.payTos) { const o = byPay.get(a); if (o) parent.set(find(s.key), find(o)); else byPay.set(a, s.key); }

const histOf = (a: string | null | undefined): HistoryBand => {
  if (!a || !evm(a.toLowerCase())) return "unknown";
  const h = P.pay_to_history?.[a.toLowerCase()];
  if (h === "x402_settlements_30d" || h === "contract") return "1-9"; // lower bound: has public on-chain history
  return (h as HistoryBand) ?? "unknown";
};
const results = new Map<string, SellerProbeResult>();
for (const s of sellers.values()) {
  if (!s.endpoints.length) continue;
  const reg = s.key;
  const rd = P.rdap?.[reg];
  const q = s.endpoints.find((e) => e.quote?.pay_to)?.quote;
  results.set(reg, rollupSeller({
    seller: reg, endpoints: s.endpoints, tls: P.tls?.[reg] ?? null,
    domain_age_days: rd?.registered_at ? Math.floor((P.started - rd.registered_at) / 86_400_000) : null,
    pay_to_history: histOf(q?.pay_to), listing_complete: s.complete, delivered_test_buys: s.delivered,
  }));
}

// Universe + coverage (Base).
const all = [...sellers.values()];
const baseS = all.filter((s) => s.base);
const clusters = new Map<string, S[]>(); for (const s of baseS) { const r = find(s.key); (clusters.get(r) ?? clusters.set(r, []).get(r)!).push(s); }
const mapped = new Set<string>(); for (const s of all) s.payTos.forEach((a) => mapped.add(a));
const addrOnly = [...onchain].filter((a) => !mapped.has(a));
const cl = [...clusters.values()];
const any = (g: S[], f: (s: S) => boolean) => g.some(f);
const pout = (g: S[]) => { const o = g.map((s) => results.get(s.key)?.outcome).filter(Boolean) as string[]; return o.includes("pass") ? "pass" : o.includes("partial") ? "partial" : o.includes("fail") ? "fail" : "not_checked"; };
const count = <T,>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length;
const srcCount = (src: string) => ({ hosts: count(T.hosts.concat((P.new_hosts ?? []).map((h: string) => ({ host: h, sources: ["wellknown"] }))), (h: any) => h.sources.includes(src) || (src === "wellknown" && false)), sellers: count(all, (s) => s.sources.has(src)), base_sellers: count(baseS, (s) => s.sources.has(src)) });
const outcomes = (xs: SellerProbeResult[]) => xs.reduce((m: Record<string, number>, r) => ((m[r.outcome] = (m[r.outcome] ?? 0) + 1), m), {});
const notes = new Map<string, number>(); for (const r of results.values()) r.notes.forEach((n) => notes.set(n, (notes.get(n) ?? 0) + 1));
const checkStats: Record<string, Record<string, number>> = {};
for (const r of results.values()) for (const [k, v] of Object.entries(r.checks)) { checkStats[k] ??= {}; checkStats[k][v] = (checkStats[k][v] ?? 0) + 1; }
const covered = (f: (g: S[]) => boolean) => count(cl, f);
const resBase = baseS.map((s) => results.get(s.key)).filter(Boolean) as SellerProbeResult[];
const summary = {
  generated_at: new Date().toISOString(), probe_started: new Date(P.started).toISOString(), probe_finished: new Date(P.finished).toISOString(), http_requests: P.requests,
  hosts_probed: P.results.length, new_hosts_from_wellknown: (P.new_hosts ?? []).length,
  sellers_registrable_all_networks: all.length,
  sources: { bazaar: srcCount("bazaar"), x402scan: srcCount("x402scan"), activity: srcCount("activity"), wellknown: { sellers: count(all, (s) => s.sources.has("wellknown")), base_sellers: count(baseS, (s) => s.sources.has("wellknown")) }, onchain_recipients_base_30d: onchain.size, onchain_mapped_to_listed_endpoint: onchain.size - addrOnly.length, onchain_address_only: addrOnly.length },
  base: {
    sellers_with_endpoint_registrable: baseS.length, sellers_with_endpoint_deduped_by_payto: cl.length, address_only_recipients: addrOnly.length,
    total_distinct_base_sellers: cl.length + addrOnly.length,
    coverage_of_endpoint_sellers: {
      test_bought_any: covered((g) => any(g, (s) => s.buys > 0)), test_bought_delivered: covered((g) => any(g, (s) => s.delivered > 0)),
      activity_data: covered((g) => any(g, (s) => s.activity)), prod_quote_probe_valid_before: covered((g) => any(g, (s) => s.prodValid)),
      new_probe: cl.reduce((m: Record<string, number>, g) => ((m[pout(g)] = (m[pout(g)] ?? 0) + 1), m), {}),
      any_evidence_before: covered((g) => any(g, (s) => s.buys > 0 || s.activity || s.prodValid)),
      any_evidence_after: covered((g) => any(g, (s) => s.buys > 0 || s.activity || s.prodValid) || ["pass", "partial", "fail"].includes(pout(g))),
      positive_before_delivered_buy: covered((g) => any(g, (s) => s.delivered > 0)),
      positive_after_buy_or_probe_pass: covered((g) => any(g, (s) => s.delivered > 0) || pout(g) === "pass"),
      probe_pass_no_buy_no_prior_quote_check: covered((g) => pout(g) === "pass" && !any(g, (s) => s.delivered > 0 || s.prodValid)),
      probe_pass_without_buy: covered((g) => pout(g) === "pass" && !any(g, (s) => s.delivered > 0)),
    },
    address_only_note: "On-chain recipients with no public listing or well-known file mapping them to an endpoint; counted in aggregate only, not probed.",
  },
  probe_rows_registrable: { total: results.size, outcomes: outcomes([...results.values()]), base_outcomes: outcomes(resBase), checks: checkStats, top_notes: [...notes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12) },
};
mkdirSync(OUT, { recursive: true });
const rows = [...results.values()].map((r) => toRow(r, P.finished)).filter((r) => typeof parseProbeRow(r) === "object");
for (let i = 0; i * PROBE_MAX_ROWS_PER_LOAD < rows.length; i++) writeFileSync(`${OUT}/load_${String(i + 1).padStart(2, "0")}.json`, JSON.stringify({ rows: rows.slice(i * PROBE_MAX_ROWS_PER_LOAD, (i + 1) * PROBE_MAX_ROWS_PER_LOAD) }));
writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
const rej: Record<string, number> = {}; for (const r of results.values()) { const x = parseProbeRow(toRow(r, P.finished)); if (typeof x === "string") rej[x] = (rej[x] ?? 0) + 1; }
console.error(`rows ${rows.length} (rejected ${results.size - rows.length}: ${JSON.stringify(rej)})`);
