/** Catalog orchestration: cron scheduling, queue consumer, lookups and owner-posted purchase evidence. */
import type { Receipt, ReceiptStore } from "./receipts";
import { dataReturnedView, deliveryCounts, deliveryState, guardBuy, inconclusiveReason, INCONCLUSIVE_REASONS, isInconclusiveReason } from "./delivery";
import type { D1Like } from "../config";
import { VENDORS } from "../vendors";
import {
  DISCOVERY_URL, INGEST_PAGE, PROBE_BATCH, RDAP_PER_BATCH, RUNS_PER_DAY, DELISTED_AFTER_MS, LABELS, LABEL_NOTES,
  toListing, probeRow, rdapRegistered, catalogView, catalogFreeView, normalizeDomain, normalizeUrl, isPlatformHost, explorerFor,
  type CatalogStore, type CatalogStats, type LookupQuery, type BuyRow,
} from "./catalog";
import { lookupBaseUsdc, lookupXrplPayment, lookupStellarUsdc, EVM_TX_RE, XRPL_TX_RE, XRPL_ADDR_RE, EVM_ADDR_RE, STELLAR_TX_RE, STELLAR_HORIZON } from "./verify";
import {
  type EvidenceStore, type PayerAgg, type XrplCensusDoc, BASE_NET, XRPL_NET, LUMI_WALLETS, KNOWN_TESTERS, HUB_MIN, CENSUS_FRESH_MS, BASE_WINDOW_MAX, BASE_GROUP, BASE_BLOCK_MS,
  classifyPayers, xrplCensus, baseHead, baseLogs, baseFunder, vet402View, parseVet402, VET402,
} from "./evidence";

export type CatalogJob =
  | { kind: "ingest"; offset: number }
  | { kind: "probe"; after: number }
  | { kind: "xrpl_census"; payTo: string }
  | { kind: "base_logs"; from: number; to: number; offset: number; head: number; headTs: number }
  | { kind: "base_funders" };
import type { SanctionsScreen } from "../sanctions";
export interface QueueLike {
  sendBatch(messages: { body: CatalogJob; delaySeconds?: number }[]): Promise<unknown>;
}

export interface SelfEntry {
  name: string;
  domains: string[];
  pay_to: string[];
  url: string;
}

export interface CatalogDeps {
  store: CatalogStore;
  fetch: typeof fetch;
  now: () => number;
  log(e: Record<string, unknown>): void;
  queue?: QueueLike;
  xrplRpc: string[];
  baseRpc: string;
  buyers: { xrpl: string[]; evm: string[]; stellar?: string[] };
  /** Stellar Horizon base URL for verifying Stellar pubnet test-buys (default horizon.stellar.org). */
  stellarHorizon?: string;
  self: SelfEntry;
  /** Signed test-buy receipts, attached to purchases in full (paid) lookups; trust/check uses them for its verdict but does not return them. */
  receipts?: ReceiptStore;
  isOwner(request: Request): Promise<boolean>;
  /** Lumi's own test-buys of the curated XRPL vendor list since `since` (trust store observations). */
  curatedBuys?: (since: number) => Promise<CuratedBuy[]>;
  /** Max sellers per UTC day that trust checks (free or paid) can move to the front of the Base test-buy queue. Default 5. */
  priorityDailyCap?: number;
  /** Free evidence (payTo census, Base forward index, vet402 import, buy queue). Optional: off when unset. */
  evidence?: EvidenceStore;
  /** Public Base RPCs, rotated (getLogs for the forward index). */
  baseRpcs?: string[];
  /** Status flips found by a probe batch (quote valid / pays listed payTo / price matches), for the licence feed delta. */
  onStatusChanges?: (changes: StatusChange[]) => Promise<void>;
  /** OFAC SDN screen (src/sanctions.ts): queued test-buys whose listing pays a listed address are withheld from the runner. */
  sanctions?: SanctionsScreen;
}

export interface StatusChange { ts: number; resource: string; field: "quote_valid" | "pays_listed_address" | "price_matches"; old: string | null; new: string | null }

/** Compare a row's stored probe status with a fresh probe result (first observations are not changes). */
export function statusChanges(row: { resource: string; probe_ts: number | null; probe_valid: number | null; probe_pay_to_match: number | null; probe_price_match: number | null }, p: { ts: number; valid: boolean; pay_to_match: boolean | null; price_match: boolean | null }): StatusChange[] {
  if (row.probe_ts == null) return [];
  const s = (v: number | boolean | null | undefined) => (v == null ? null : v === true || v === 1 ? "true" : "false");
  const out: StatusChange[] = [];
  const pairs: [StatusChange["field"], string | null, string | null][] = [
    ["quote_valid", s(row.probe_valid), s(p.valid)],
    ["pays_listed_address", s(row.probe_pay_to_match), s(p.pay_to_match)],
    ["price_matches", s(row.probe_price_match), s(p.price_match)],
  ];
  for (const [field, o, n] of pairs) if (o !== n) out.push({ ts: p.ts, resource: row.resource, field, old: o, new: n });
  return out;
}

export interface CuratedBuy {
  vendor_id: string;
  endpoint: string;
  ts: number;
  network: string;
  tx_hash: string;
  amount: string;
  asset: string;
  http_status: number | null;
  data_returned: boolean;
  inconclusive?: string | null;
}

/**
 * Dated, one-off XRPL Bazaar sweep (box-side test-buys of every XRPL-paying host in the CDP Bazaar catalog,
 * Oct 22-23 2026; each buy re-verified on the ledger when it was merged). A fixed, dated fact, not a live count:
 * new XRPL hosts listed after Oct 23 2026 are not covered by it.
 */
const SWEEP_COUNTS = { as_of: "2026-10-23", as_of_label: "Oct 23 2026", hosts_checked: 98, hosts_total: 98, hosts_bought: 93, delivered: 82, not_delivered: 2, inconclusive: 9 } as const;
// Counts from the Oct 23 2026 XRPL sweep notes (bazaar_coverage; (98 third-party XRPL hosts; Lumi's own host excluded),
// recomputed by scripts/sweep_counts.py. inconclusive = paid, but Lumi recorded no HTTP response (Lumi's 90 s client timeout or
// an interrupted run): delivery unknown, Lumi-side, not counted against the seller (correction logged Oct 23 2026).
// Curated-vendor buys that are not Bazaar hosts (e.g. cloudpayx) are not part of this sweep.
export const XRPL_BAZAAR_SWEEP = {
  statement: `${SWEEP_COUNTS.hosts_bought} of ${SWEEP_COUNTS.hosts_total} XRPL Bazaar hosts bought, ${SWEEP_COUNTS.delivered} delivered, ${SWEEP_COUNTS.not_delivered} not delivered, ${SWEEP_COUNTS.inconclusive} inconclusive (Lumi-side, no response recorded), checked ${SWEEP_COUNTS.hosts_checked} of ${SWEEP_COUNTS.hosts_total}, as of ${SWEEP_COUNTS.as_of_label}`,
  as_of: SWEEP_COUNTS.as_of,
  hosts_checked: SWEEP_COUNTS.hosts_checked,
  hosts_total: SWEEP_COUNTS.hosts_total,
  hosts_bought: SWEEP_COUNTS.hosts_bought,
  delivered: SWEEP_COUNTS.delivered,
  not_delivered: SWEEP_COUNTS.not_delivered,
  inconclusive: SWEEP_COUNTS.inconclusive,
  corrections: "/v1/monitor/corrections",
  note: "Dated snapshot. Hosts not bought had no payable XRPL quote within Lumi's limits at the time; that is a dated observation, not a judgement of the seller.",
} as const;

/** XRPL test-bought window for the curated list. */
export const CURATED_WINDOW_MS = 30 * 86_400_000;

/** Test-bought, split by chain: Base USDC buys of Bazaar listings vs XRPL buys of the curated list. Never merged into one number. */
export function chainSplit(s: CatalogStats | null, x: XrplAgg | null) {
  const base = s?.by_network?.["eip155:8453"] ?? (s && !s.by_network ? { purchase_verified: s.purchase_verified, test_buys: s.test_buys } : { purchase_verified: 0, test_buys: 0 });
  const otherBazaar = s?.by_network ? Object.entries(s.by_network).filter(([n]) => n !== "eip155:8453" && n !== "xrpl:0" && n !== "stellar:pubnet") : [];
  const stel = s?.by_network?.["stellar:pubnet"] ?? { purchase_verified: 0, test_buys: 0 };
  return {
    base_usdc: { network: "eip155:8453", asset: "USDC", source: "CDP Bazaar catalog listings Lumi bought once each", purchase_verified_resources: base.purchase_verified, test_buys: base.test_buys },
    xrpl: {
      network: "xrpl:0", assets: x?.assets ?? [], source: "Lumi's curated XRPL vendor list (test-buys within shared daily caps)", window_days: CURATED_WINDOW_MS / 86_400_000,
      purchase_verified_endpoints: x?.endpoints ?? 0, vendors: x?.vendors ?? 0, test_buys: x?.buys ?? 0, delivered: x?.delivered ?? 0,
      bazaar_catalog: { purchase_verified_resources: s?.by_network?.["xrpl:0"]?.purchase_verified ?? 0, test_buys: s?.by_network?.["xrpl:0"]?.test_buys ?? 0, source: "CDP Bazaar catalog listings Lumi bought on XRPL" },
      bazaar_sweep: XRPL_BAZAAR_SWEEP,
    },
    stellar_usdc: { network: "stellar:pubnet", asset: "USDC", source: "x402 catalog listings (CDP Bazaar) Lumi bought on Stellar with USDC (daily routine, shared cap)", purchase_verified_resources: stel.purchase_verified, test_buys: stel.test_buys },
    ...(otherBazaar.length ? { other_bazaar_networks: Object.fromEntries(otherBazaar) } : {}),
    note: `Counted separately per chain. Most Bazaar catalog test-buys are Base USDC. XRPL: the curated list is test-bought by a daily routine within shared caps (about $0.50 a day in total: 0.30 RLUSD + 0.10 XRP + 0.15 Stellar USDC, so not every vendor every day). Stellar: catalog listings that accept stellar:pubnet USDC are test-bought from the same shared cap, and a one-off XRPL Bazaar sweep covered ${XRPL_BAZAAR_SWEEP.statement}.`,
  };
}

export interface XrplAgg { buys: number; delivered: number; inconclusive?: number; endpoints: number; vendors: number; assets: string[]; rows: CuratedBuy[] }

const STATS_EVERY_MS = 25 * 60_000; // every cron run (one aggregate query), so the summary matches the entries
/** Read path recomputes when the stored stats are older than this (e.g. a cron run was missed). */
const STATS_STALE_MS = 60 * 60_000;
/** Free browse is a teaser: the most-used listings only. Single URL/domain/payTo lookups stay free and uncapped by this. */
export const FREE_BROWSE_MAX = 100;
export const FREE_BROWSE_PAGE = 25;
export const FREE_LOOKUP_ENTRIES = 5;
/**
 * Daily stop points on ONE shared counter (rows written today, UTC day, index entries included): each job kind runs
 * only while the counter is below its threshold. Writes this counter does not see (traffic batches, live signals,
 * meta, rate limits, trust probes, receipts) add ~15-20k/day. Sized for Workers Paid (50M D1 rows written/month
 * included): ~200k counted + ~20k uncounted is ~6.6M/month (~13% of the allowance; even 3x200k would be ~36%).
 * Kept as a safety net against runaway jobs, not as a quota.
 */
export const WRITE_BUDGET = { ingest: 200_000, probe: 200_000, evidence: 200_000 };
/**
 * A trust check result (free or paid: the same rule for both, payment never changes the order) worth a priority test-buy:
 * exact listing, paid on Base, no conclusive Lumi purchase of the listing ever, and a warning signal. The seller-level
 * "never test-bought" check (any listing on the same host) runs in queueBuy.
 */
export function buyCandidate(body: any, exact: any, _t = Date.now()) {
  const e = exact?.catalog?.entries?.[0];
  if (!e || exact?.self || !body?.matched?.exact) return null;
  if ((body?.reasons ?? []).some((r: any) => r?.code === "sanctioned_address")) return null; // never queue a test-buy of an OFAC-listed payTo
  // Inconclusive buys (Lumi-side, delivery unknown) do not count as a purchase: the listing may be retested.
  if ((e.purchases ?? []).some(conclusivePurchase)) return null;
  const reasons: string[] = (body.reasons ?? []).map((r: any) => String(r.code)).filter((c: string) => BUY_SIGNALS.includes(c));
  if (!reasons.length) return null;
  const nets: string[] = (e.pay_to ?? []).map((p: any) => String(p.network));
  // Only the Base test-buy routine reads this queue; other chains would only use up the daily cap.
  if (!nets.includes(BASE_NET)) return null;
  const price = Number(e.listed_price_usd);
  return { resource: String(e.resource), network: BASE_NET, price_usd: Number.isFinite(price) ? price : null, reasons };
}
const conclusivePurchase = (p: any) =>
  !!p && !p.inconclusive && p.delivery !== "inconclusive" && p.data_returned !== null && !(p.data_returned === false && (p.http_status == null || p.http_status === 0));
/** Default daily cap on sellers moved to the front of the Base test-buy queue by checks (env TRUST_PRIORITY_DAILY_CAP). */
export const PRIORITY_DAILY_CAP = 5;
/** A seller can move up through checks at most once per this many days (the public /trust-policy/ text says once per 30 days). */
export const PRIORITY_SELLER_DAYS = 30;
export type PriorityResult = { queued: boolean; reason: "queued" | "duplicate_30d" | "cap_reached" | "already_test_bought" | "bad_resource" | "evidence_off" };
/**
 * Trust check (free or paid) signals that queue a resource for the daily test-buy routine (never bought inline).
 * Objective only, from Lumi's own records and public data, so the result does not depend on who ran the check.
 * pay_to_mismatch is left out on purpose: it compares a payTo the caller enters, so anyone could trigger it.
 */
export const BUY_SIGNALS = ["last_quote_invalid", "quote_pays_unlisted_address", "quoted_price_differs", "unreliable_quotes", "young_domain", "no_organic_payers", "no_bazaar_usage", "vet402_l0_fail"];
const PER_HOST = 3;
/** CDP discovery rate-limits bursts (HTTP 429 seen from Workers): one page per 10 s. */
const INGEST_SPACING_S = 10;
const PROBE_SPACING_S = 30;
const dayKey = (t: number) => "writes:" + new Date(t).toISOString().slice(0, 10);
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", ...headers } });
const iso = (t: number) => new Date(t).toISOString();
const BANNED = /\b(scam|fraud|rug|fake|ponzi|steal|thief|criminal)\b/i;

export function createCatalog(deps: CatalogDeps) {
  const { store, now } = deps;

  let xrplMemo: { at: number; agg: XrplAgg } | undefined;
  /** XRPL test-buys of the curated list in the last 30 days (memoised 5 min). */
  async function xrplAgg(): Promise<XrplAgg | null> {
    if (!deps.curatedBuys) return null;
    const t = now();
    if (xrplMemo && t - xrplMemo.at < 300_000) return xrplMemo.agg;
    try {
      const rows = (await deps.curatedBuys(t - CURATED_WINDOW_MS)).filter((r) => r.network.startsWith("xrpl:") && r.ts >= t - CURATED_WINDOW_MS).sort((a, b) => b.ts - a.ts);
      const agg: XrplAgg = {
        buys: rows.length, delivered: deliveryCounts(rows).delivered, inconclusive: deliveryCounts(rows).inconclusive,
        endpoints: new Set(rows.map((r) => r.endpoint)).size, vendors: new Set(rows.map((r) => r.vendor_id)).size,
        assets: [...new Set(rows.map((r) => r.asset))].sort(), rows,
      };
      xrplMemo = { at: t, agg };
      return agg;
    } catch (e) {
      deps.log({ event: "curated_buys_error", error: String(e) });
      return xrplMemo?.agg ?? null;
    }
  }

  /** Jobs are spaced `spacing` seconds apart (queue delay) so upstream APIs and vendors see a slow, steady rate. */
  async function send(jobs: CatalogJob[], spacing = 0) {
    if (!jobs.length) return;
    if (!deps.queue) {
      for (const j of jobs) await consume(j); // tests / Node: run inline
      return;
    }
    const msgs = jobs.map((body, i) => (spacing && i ? { body, delaySeconds: Math.min(43_200, i * spacing) } : { body }));
    for (let i = 0; i < msgs.length; i += 100) await deps.queue.sendBatch(msgs.slice(i, i + 100));
  }

  async function catalogTotal(): Promise<number> {
    const r = await deps.fetch(`${DISCOVERY_URL}?limit=1&offset=0`, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`discovery HTTP ${r.status}`);
    const total = Number(((await r.json()) as any).pagination?.total ?? 0);
    await store.setMeta("ingest_total", String(total));
    return total;
  }

  /** Owner-triggered full pass: every page at once (still bounded by the daily write budget). */
  async function startIngest(): Promise<number> {
    const total = await catalogTotal();
    const jobs: CatalogJob[] = [];
    for (let o = 0; o < total + INGEST_PAGE; o += INGEST_PAGE) jobs.push({ kind: "ingest", offset: o });
    await store.setMeta("ingest_last", JSON.stringify({ at: now(), total, pages: jobs.length }));
    await send(jobs, INGEST_SPACING_S);
    return total;
  }

  /**
   * Every 30 min (cron): the next slice of the Bazaar catalog (the whole list is re-read about once a day),
   * the next slice of free quote checks (rotating slices; coverage depends on catalog size), and stats every 6 h.
   */
  async function cron() {
    const t = now();
    const out: Record<string, unknown> = {};
    try {
      let total = Number((await store.getMeta("ingest_total")) ?? "0");
      let cursor = Number((await store.getMeta("ingest_cursor")) ?? "0");
      if (!total || cursor >= total) {
        if (total) await store.setMeta("ingest_last", JSON.stringify({ at: t, total, pages: Math.ceil(total / INGEST_PAGE) }));
        total = await catalogTotal();
        cursor = 0;
      }
      const pages = Math.max(1, Math.ceil(total / INGEST_PAGE / RUNS_PER_DAY));
      const jobs: CatalogJob[] = [];
      for (let i = 0; i < pages && cursor < total; i++, cursor += INGEST_PAGE) jobs.push({ kind: "ingest", offset: cursor });
      await store.setMeta("ingest_cursor", String(cursor));
      await send(jobs, INGEST_SPACING_S);
      out.ingest_jobs = jobs.length;
    } catch (e) {
      out.ingest_error = String(e);
    }
    const maxId = await store.maxId();
    if (maxId > 0) {
      const perRun = Math.max(1, Math.ceil(maxId / PROBE_BATCH / RUNS_PER_DAY));
      let cursor = Number((await store.getMeta("probe_cursor")) ?? "0");
      const jobs: CatalogJob[] = [];
      for (let i = 0; i < perRun; i++) {
        if (cursor >= maxId) cursor = 0;
        jobs.push({ kind: "probe", after: cursor });
        cursor += PROBE_BATCH;
      }
      await store.setMeta("probe_cursor", String(cursor));
      await send(jobs, PROBE_SPACING_S);
      out.probe_jobs = jobs.length;
    }
    if (deps.evidence) {
      try { out.evidence = await evidenceCron(t); } catch (e) { out.evidence_error = String(e); }
    }
    const st = await stats();
    if (!st || t - st.computed_at > STATS_EVERY_MS) await store.setMeta("stats", JSON.stringify(await store.computeStats(t)));
    deps.log({ event: "catalog_cron", ...out });
    return out;
  }

  async function underBudget(kind: keyof typeof WRITE_BUDGET) {
    const used = Number((await store.getMeta(dayKey(now()))) ?? "0");
    return used < WRITE_BUDGET[kind];
  }

  async function probeAll(rows: Awaited<ReturnType<CatalogStore["range"]>>, t: number) {
    // At most PER_HOST concurrent requests to any one host; hosts run in parallel.
    const byHost = new Map<string, typeof rows>();
    for (const r of rows) byHost.set(r.domain, [...(byHost.get(r.domain) ?? []), r]);
    const out: Awaited<ReturnType<typeof probeRow>>[] = [];
    await Promise.all(
      [...byHost.values()].map(async (list) => {
        for (let i = 0; i < list.length; i += PER_HOST) out.push(...(await Promise.all(list.slice(i, i + PER_HOST).map((r) => probeRow(deps.fetch, r, t)))));
      }),
    );
    return out;
  }

  async function consume(job: CatalogJob) {
    if (job.kind === "xrpl_census" || job.kind === "base_logs" || job.kind === "base_funders") return consumeEvidence(job);
    if (job.kind === "ingest") {
      const r = await deps.fetch(`${DISCOVERY_URL}?limit=${INGEST_PAGE}&offset=${job.offset}`, { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error(`discovery HTTP ${r.status}`);
      const items: any[] = ((await r.json()) as any).items ?? [];
      const ls = items.map(toListing).filter((x): x is NonNullable<typeof x> => !!x);
      if (!(await underBudget("ingest"))) return { skipped: "daily write budget" };
      const w = await store.upsert(ls, now());
      await store.addCounter(dayKey(now()), w + 1);
      return { ingested: ls.length, written: w };
    }
    const t = now();
    if (!(await underBudget("probe"))) return { skipped: "daily write budget" };
    const rows = (await store.range(job.after, PROBE_BATCH)).filter((r) => r.method !== "MCP" && r.last_seen > t - DELISTED_AFTER_MS);
    const results = await probeAll(rows, t);
    const w = await store.saveProbes(results);
    if (deps.onStatusChanges) {
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ch = results.flatMap((p) => { const r = byId.get(p.id); return r ? statusChanges(r, p) : []; });
      if (ch.length) await deps.onStatusChanges(ch).catch((e) => deps.log({ event: "status_change_error", error: String(e) }));
    }
    // Domain age: a few registrable domains from this batch that have no recent RDAP answer.
    const regs = [...new Set(rows.map((r) => r.reg_domain).filter((x): x is string => !!x && !isPlatformHost(x)))];
    if (regs.length) {
      const known = new Map((await store.domainInfo(regs)).map((x) => [x.domain, x]));
      const due = regs.filter((x) => { const k = known.get(x); return !k || k.checked_at < t - 30 * 86_400_000; }).slice(0, RDAP_PER_BATCH);
      for (const dmn of due) {
        const r = await rdapRegistered(deps.fetch, dmn);
        await store.saveDomain({ domain: dmn, registered_at: r.registered_at, checked_at: t, error: r.error });
      }
      await store.addCounter(dayKey(t), w + due.length * 2 + 1);
    } else await store.addCounter(dayKey(t), w + 1);
    return { probed: results.length, valid: results.filter((r) => r.valid).length };
  }

  // ------------------------------------------------------------ free evidence

  const metaJson = async <T,>(k: string): Promise<T | null> => { try { const v = await store.getMeta(k); return v ? (JSON.parse(v) as T) : null; } catch { return null; } };
  let evmMemo: { at: number; set: Set<string>; list: string[] } | undefined;
  async function evmPayTos(t: number, refresh = false) {
    if (!refresh && evmMemo && t - evmMemo.at < 600_000) return evmMemo;
    let m = await metaJson<{ at: number; list: string[] }>("evm_paytos");
    if (refresh && (!m || t - m.at > 86_400_000)) {
      m = { at: t, list: await deps.evidence!.evmPayTos() };
      await store.setMeta("evm_paytos", JSON.stringify(m));
    }
    evmMemo = { at: t, list: m?.list ?? [], set: new Set(m?.list ?? []) };
    return evmMemo;
  }
  let hubMemo: { at: number; set: Set<string> } | undefined;
  async function hubSet(t: number) {
    if (hubMemo && t - hubMemo.at < 600_000) return hubMemo.set;
    const h = await metaJson<{ at: number; hubs: string[] }>("funder_hubs");
    hubMemo = { at: t, set: new Set((h?.hubs ?? []).map((x) => x.toLowerCase())) };
    return hubMemo.set;
  }
  async function testers() {
    const m = await metaJson<{ xrpl?: string[]; evm?: string[] }>("known_testers");
    return { xrpl: [...KNOWN_TESTERS.xrpl, ...(m?.xrpl ?? [])], evm: [...KNOWN_TESTERS.evm, ...(m?.evm ?? [])].map((x) => x.toLowerCase()) };
  }
  const lumiWallets = (net: "xrpl" | "evm") => [...LUMI_WALLETS[net], ...(net === "xrpl" ? deps.buyers.xrpl : deps.buyers.evm), ...deps.self.pay_to];
  const baseRpcs = () => deps.baseRpcs?.length ? deps.baseRpcs : [deps.baseRpc];

  async function evidenceCron(t: number) {
    const ev = deps.evidence!;
    const out: Record<string, unknown> = {};
    const jobs: CatalogJob[] = [];
    // Base forward index: the blocks since the last run (at most BASE_WINDOW_MAX; older backlog is recorded as a gap).
    try {
      if (!(await underBudget("evidence"))) out.base = "skipped: daily write budget";
      else {
        const { list } = await evmPayTos(t, true);
        const head = await baseHead(deps.fetch, baseRpcs());
        const safe = head.block - 10;
        const idx = (await metaJson<{ started_block: number; started_at: number; cursor: number; last_run: number; gaps: { from: number; to: number; at: number }[]; skipped_blocks: number }>("base_index"))
          ?? { started_block: safe - 900, started_at: t, cursor: safe - 900, last_run: 0, gaps: [], skipped_blocks: 0 };
        let from = idx.cursor + 1;
        if (safe - from + 1 > BASE_WINDOW_MAX) {
          const gap = { from, to: safe - BASE_WINDOW_MAX, at: t };
          idx.gaps = [...idx.gaps, gap].slice(-20); idx.skipped_blocks += gap.to - gap.from + 1;
          from = safe - BASE_WINDOW_MAX + 1;
        }
        if (from <= safe && list.length) {
          for (let o = 0; o < list.length; o += BASE_GROUP) jobs.push({ kind: "base_logs", from, to: safe, offset: o, head: head.block, headTs: head.ts });
          jobs.push({ kind: "base_funders" });
          idx.cursor = safe; idx.last_run = t;
          await store.setMeta("base_index", JSON.stringify(idx));
          out.base = { from, to: safe, groups: Math.ceil(list.length / BASE_GROUP) };
        }
      }
    } catch (e) { out.base_error = String(e); }
    // XRPL census pre-warm: catalog + curated XRPL payTos, a few per run, re-checked daily.
    try {
      let xl = await metaJson<{ at: number; list: string[] }>("xrpl_paytos");
      if (!xl || t - xl.at > 86_400_000) {
        const cur = VENDORS.flatMap((v) => v.pay_to.xrpl);
        xl = { at: t, list: [...new Set([...(await ev.xrplPayTos()), ...cur])].filter((a) => XRPL_ADDR_RE.test(a) && !lumiWallets("xrpl").includes(a)) };
        await store.setMeta("xrpl_paytos", JSON.stringify(xl));
      }
      let n = 0;
      for (const a of xl.list) {
        if (n >= 4) break;
        const c = await ev.getCensus(XRPL_NET, a);
        if (c && c.checked_at > t - CENSUS_FRESH_MS) continue;
        if (await ev.markQueued(XRPL_NET, a, t)) { jobs.push({ kind: "xrpl_census", payTo: a }); n++; }
      }
      out.xrpl_census_jobs = n;
    } catch (e) { out.xrpl_error = String(e); }
    // Funding hubs (exchanges, bridges): every 6 h.
    try {
      const h = await metaJson<{ at: number }>("funder_hubs");
      if (!h || t - h.at > 6 * 3_600_000) {
        const hubs = (await ev.hubs(HUB_MIN)).map((x) => x.funder);
        await store.setMeta("funder_hubs", JSON.stringify({ at: t, min_payers: HUB_MIN, hubs }));
        hubMemo = undefined;
      }
    } catch (e) { out.hubs_error = String(e); }
    await send(jobs, 5);
    return out;
  }

  async function consumeEvidence(job: Extract<CatalogJob, { kind: "xrpl_census" | "base_logs" | "base_funders" }>) {
    const ev = deps.evidence;
    if (!ev) return { skipped: "evidence off" };
    const t = now();
    if (!(await underBudget("evidence"))) return { skipped: "daily write budget" };
    if (job.kind === "xrpl_census") {
      const d = await xrplCensus(deps.fetch, deps.xrplRpc, job.payTo, ev, t);
      await store.addCounter(dayKey(t), 2 + d.payers.filter((p) => p.fk).length);
      return { census: job.payTo, x402_payments: d.x402_payments };
    }
    if (job.kind === "base_logs") {
      const { list } = await evmPayTos(t);
      const group = list.slice(job.offset, job.offset + BASE_GROUP);
      if (!group.length) return { skipped: "empty group" };
      const rows = await baseLogs(deps.fetch, baseRpcs(), group, job.from, job.to, { block: job.head, ts: job.headTs });
      const w = await ev.addInflow(rows);
      await store.addCounter(dayKey(t), w + 1);
      return { pairs: rows.length };
    }
    const due = await ev.unresolvedPayers(15);
    const out = [];
    for (const p of due) {
      try { out.push(await baseFunder(deps.fetch, baseRpcs(), p.payer, p.first_block, t)); } catch { /* next run */ }
    }
    const w = await ev.putFunders(out);
    await store.addCounter(dayKey(t), w + 1);
    return { funders: out.length, of: due.length };
  }

  /** Census view (free: counts only; paid: plus cluster samples with tx hashes). */
  function censusView(network: string, payTo: string, payers: PayerAgg[], ctx: { seller: string[]; lumi: string[]; testers: string[]; hubs: Set<string> }, meta: Record<string, unknown>, free: boolean) {
    const c = classifyPayers(payers, { payTo, sellerPayTos: ctx.seller, lumi: ctx.lumi, testers: ctx.testers, hubs: ctx.hubs });
    const exp = (tx: string | null) => (tx ? explorerFor(network, tx) : null);
    return {
      network, pay_to: payTo, status: "ok", ...meta,
      organic_payers: c.organic_payers, organic_wallets: c.organic_wallets, organic_payments: c.organic_payments, last_organic_at: c.last_organic_at,
      payers_seen: c.payers_seen, excluded_payers: c.excluded, funder_unresolved: c.funder_unresolved,
      method: "organic_payers = distinct funding clusters: payers funded by the same account count once; Lumi's own wallets, known test wallets, proof/test wallets the seller itself declared (seller_declared), the seller's payTos and wallets they funded are excluded. Funders that funded " + HUB_MIN + "+ indexed payers (exchanges, bridges) are not used for clustering.",
      ...(free ? {} : {
        ...(network === BASE_NET ? { organic_usd: c.organic_usd } : {}),
        top_clusters: c.clusters.slice(0, 5).map((k) => ({ wallets: k.payers.length, sample_payer: k.payers[0], funder: k.funder, payments: k.n, last_at: new Date(k.last_ts).toISOString(), last_tx: k.last_tx, explorer: exp(k.last_tx) })),
      }),
    };
  }

  /** Free evidence for a lookup: payTo census (XRPL ledger read / Base forward index). Queues an XRPL census when none is fresh. */
  async function censusFor(payTos: { network: string; pay_to: string }[], seller: string[], free: boolean, allowQueue: boolean) {
    const ev = deps.evidence;
    if (!ev || !payTos.length) return [];
    const t = now();
    const ts = await testers();
    const hubs = await hubSet(t);
    const out: Record<string, unknown>[] = [];
    for (const p of payTos.slice(0, 3)) {
      if (XRPL_ADDR_RE.test(p.pay_to)) {
        let c = await ev.getCensus(XRPL_NET, p.pay_to);
        let queued = false;
        if ((!c?.doc || c.checked_at < t - CENSUS_FRESH_MS) && allowQueue && (await ev.markQueued(XRPL_NET, p.pay_to, t))) {
          await send([{ kind: "xrpl_census", payTo: p.pay_to }]);
          queued = true;
          if (!deps.queue) c = await ev.getCensus(XRPL_NET, p.pay_to); // inline (tests / Node)
        }
        if (!c?.doc) { out.push({ network: XRPL_NET, pay_to: p.pay_to, status: queued || c?.queued_at ? "queued" : "not_checked", note: "An XRPL ledger read of this payTo is queued; look again in a few minutes." }); continue; }
        const d = JSON.parse(c.doc) as XrplCensusDoc;
        const payers: PayerAgg[] = d.payers.map((x) => ({ payer: x.a, funder: x.f, funder_known: x.fk, n: x.n, last_ts: x.last_ts, last_tx: x.last_tx, amounts: x.amt }));
        out.push(censusView(XRPL_NET, p.pay_to, payers, { seller, lumi: lumiWallets("xrpl"), testers: ts.xrpl, hubs }, {
          source: "XRPL ledger (account_tx, latest 200 transactions), read by Lumi",
          as_of: iso(d.checked_at), window: { from: d.window_from ? iso(d.window_from) : null, to: d.window_to ? iso(d.window_to) : null, complete_history: d.complete },
          x402_payments: d.x402_payments, x402_markers: { source_tag_804681468: d.markers.source_tag, invoice_id: d.markers.invoice_id }, incoming_payments: d.incoming_payments,
          ...(c.checked_at < t - CENSUS_FRESH_MS ? { refresh: "queued" } : {}),
        }, free));
      } else if (EVM_ADDR_RE.test(p.pay_to)) {
        const a = p.pay_to.toLowerCase();
        const idx = await metaJson<{ started_at: number; started_block: number; cursor: number; last_run: number; skipped_blocks: number }>("base_index");
        const { set } = await evmPayTos(t);
        if (!idx) { out.push({ network: BASE_NET, pay_to: a, status: "index_not_started" }); continue; }
        if (!set.has(a)) { out.push({ network: BASE_NET, pay_to: a, status: "not_indexed", note: "Only payTos listed in the CDP Bazaar catalog are indexed (forward from the index start)." }); continue; }
        const rows = await ev.inflowFor(a, 500);
        const fm = new Map((await ev.funders(BASE_NET, rows.map((r) => r.payer))).map((f) => [f.account, f]));
        const payers: PayerAgg[] = rows.map((r) => ({ payer: r.payer, funder: fm.get(r.payer)?.funder ?? null, funder_known: fm.has(r.payer), n: r.n, last_ts: r.last_ts, last_tx: r.last_tx, usd: r.units / 1e6 }));
        out.push(censusView(BASE_NET, a, payers, { seller: seller.map((x) => x.toLowerCase()), lumi: lumiWallets("evm").map((x) => x.toLowerCase()), testers: ts.evm, hubs }, {
          source: "Base USDC Transfer logs into this payTo (Lumi forward index, public RPCs)",
          as_of: iso(idx.last_run), window: { from: iso(idx.last_run - (idx.cursor - idx.started_block) * BASE_BLOCK_MS), to: iso(idx.last_run), note: "forward-only from the index start; blocks skipped under load are listed in the catalog summary" },
        }, free));
      }
    }
    return out;
  }

  async function vet402For(rows: { resource: string }[], free: boolean) {
    if (!deps.evidence || !rows.length) return new Map<string, ReturnType<typeof vet402View>>();
    const v = await deps.evidence.vet402For(rows.map((r) => r.resource));
    return new Map(v.map((r) => [r.resource_key, vet402View(r, free)]));
  }

  /**
   * Any trust check (free lookup, free trial, paid trust/check): queue the resource for the daily Base test-buy routine
   * (never bought inline). One path for every caller, so free and paid checks have identical queue effects. Abuse limits:
   * one slot per seller host per PRIORITY_SELLER_DAYS (30) days (repeat checks add nothing, not even hits), at most `priorityDailyCap` sellers
   * per day, and never for a seller Lumi has already test-bought (conclusively, on any of its listings).
   */
  async function queueBuy(c: { resource: string; network: string; price_usd: number | null; reasons: string[] }): Promise<PriorityResult> {
    if (!deps.evidence) return { queued: false, reason: "evidence_off" };
    let seller: string;
    try { seller = normalizeDomain(new URL(c.resource).hostname); } catch { return { queued: false, reason: "bad_resource" }; }
    if (!seller) return { queued: false, reason: "bad_resource" };
    if ((await store.buysByDomain(seller, 10)).some(conclusivePurchase)) return { queued: false, reason: "already_test_bought" };
    const t = now();
    const cap = Math.max(0, Math.floor(deps.priorityDailyCap ?? PRIORITY_DAILY_CAP));
    const claim = await deps.evidence.claimPriority(iso(t).slice(0, 10), seller, c.resource, cap, t, t - PRIORITY_SELLER_DAYS * 86_400_000);
    if (claim !== "claimed") return { queued: false, reason: claim === "duplicate" ? "duplicate_30d" : "cap_reached" };
    await deps.evidence.enqueueBuy(c, t);
    await store.addCounter(dayKey(t), 3);
    return { queued: true, reason: "queued" };
  }

  /**
   * Confirm re-buy: a failed test-buy that has not met the checks_failed bar, or a seller's re-test
   * request, puts the resource back in the Base test-buy queue. Not limited by the never-test-bought rule or the 30-day
   * priority slot (it is a re-test of a failure), but at most once per seller per 24 h. Only Base is bought automatically.
   */
  async function queueConfirmBuy(c: { resource: string; network?: string | null; price_usd: number | null; why: string }): Promise<{ queued: boolean; reason: string }> {
    if (!deps.evidence) return { queued: false, reason: "evidence_off" };
    let seller: string;
    try { seller = normalizeDomain(new URL(c.resource).hostname); } catch { return { queued: false, reason: "bad_resource" }; }
    if (c.network && c.network !== BASE_NET) return { queued: false, reason: "not_base" };
    const t = now();
    const k = `confirm_rebuy:${seller}`;
    const last = Number((await store.getMeta(k)) ?? "0");
    if (t - last < 86_400_000) return { queued: false, reason: "duplicate_24h" };
    await store.setMeta(k, String(t));
    await deps.evidence.enqueueBuy({ resource: c.resource, network: BASE_NET, price_usd: c.price_usd, reasons: [c.why] }, t);
    await deps.evidence.setBuyStatus(c.resource, "queued", c.why, t);
    return { queued: true, reason: "queued" };
  }

  async function evidenceStatus() {
    if (!deps.evidence) return null;
    const idx = await metaJson<{ started_at: number; last_run: number; skipped_blocks: number; gaps: unknown[] }>("base_index");
    const v = await metaJson<{ at: number; retrieved_at: string; matched: number }>("vet402_import");
    return {
      bazaar_quality: "Coinbase CDP Bazaar quality fields (30-day calls, unique payers, last called) are stored per listing at most every 20 h and shown, attributed and dated, in lookups and trust/check.",
      base_forward_index: idx ? { since: iso(idx.started_at), last_run: iso(idx.last_run), skipped_blocks: idx.skipped_blocks, gaps: idx.gaps?.length ?? 0 } : "not started",
      xrpl_census: "XRPL ledger reads of catalog and curated payTos (latest 200 transactions), refreshed daily; on demand for looked-up r-addresses.",
      third_party: v ? { source: VET402.source, license: VET402.license, link: VET402.link, retrieved_at: v.retrieved_at, resources_matched: v.matched } : null,
    };
  }

  async function postEvidence(request: Request, url: URL): Promise<Response> {
    if (!(await deps.isOwner(request))) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
    const ev = deps.evidence;
    if (!ev) return json(503, { error: "evidence_unavailable" });
    const path = url.pathname;
    const t = now();
    if (path === "/v1/trust/catalog/evidence/run") {
      const kind = url.searchParams.get("kind");
      if (kind === "cron") return json(200, await evidenceCron(t));
      if (kind === "funders") return json(200, await consumeEvidence({ kind: "base_funders" }));
      if (kind === "xrpl") {
        const a = url.searchParams.get("payTo") ?? "";
        if (!XRPL_ADDR_RE.test(a)) return json(400, { error: "invalid_field", field: "payTo" });
        return json(200, await consumeEvidence({ kind: "xrpl_census", payTo: a }));
      }
      return json(400, { error: "invalid_field", field: "kind", detail: "cron | funders | xrpl" });
    }
    let b: any;
    try { b = await request.json(); } catch { return json(400, { error: "invalid_json" }); }
    if (path === "/v1/trust/catalog/evidence/vet402") {
      const rows = parseVet402(b, t);
      if (typeof rows === "string") return json(400, { error: "invalid_field", detail: rows });
      if (!(await underBudget("evidence"))) return json(429, { error: "daily_write_budget", retryable: true });
      // Map vet402 resource_key (host/path) to catalogued resources; unmatched rows are not stored.
      const byUrl = new Map<string, (typeof rows)[number]>();
      for (const r of rows) for (const u of [`https://${r.resource_key}`, `http://${r.resource_key}`]) byUrl.set(u, r);
      const hit = await ev.existingResources([...byUrl.keys()]);
      const put = hit.map((u) => ({ ...byUrl.get(u)!, resource_key: u }));
      const w = await ev.putVet402(put);
      await store.addCounter(dayKey(t), w + 1);
      const prev = await metaJson<{ matched: number; retrieved_at: string }>("vet402_import");
      const matched = (prev && prev.retrieved_at === iso(put[0]?.retrieved_at ?? Date.parse(b.retrieved_at)) ? prev.matched : 0) + w;
      await store.setMeta("vet402_import", JSON.stringify({ at: t, retrieved_at: iso(Date.parse(b.retrieved_at)), matched }));
      return json(200, { received: rows.length, matched: w, unmatched_keys: rows.filter((r) => !hit.includes(`https://${r.resource_key}`) && !hit.includes(`http://${r.resource_key}`)).map((r) => r.resource_key) });
    }
    if (path === "/v1/trust/catalog/evidence/testers") {
      const xrpl = Array.isArray(b?.xrpl) ? b.xrpl.filter((a: unknown) => typeof a === "string" && XRPL_ADDR_RE.test(a)) : [];
      const evm = Array.isArray(b?.evm) ? b.evm.filter((a: unknown) => typeof a === "string" && EVM_ADDR_RE.test(a)).map((a: string) => a.toLowerCase()) : [];
      const note = typeof b?.note === "string" ? b.note.slice(0, 200) : null;
      if (xrpl.length + evm.length > 500) return json(400, { error: "too_many" });
      await store.setMeta("known_testers", JSON.stringify({ at: t, xrpl, evm, note }));
      return json(200, { xrpl: xrpl.length, evm: evm.length });
    }
    if (path === "/v1/trust/catalog/buy-queue") {
      const resource = typeof b?.resource === "string" ? normalizeUrl(b.resource) : null;
      const status = String(b?.status ?? "");
      if (!resource || !["queued", "bought", "skipped"].includes(status)) return json(400, { error: "invalid_field", detail: "resource + status (queued|bought|skipped)" });
      const note = typeof b?.note === "string" ? b.note.slice(0, 200) : null;
      return json(200, { updated: await ev.setBuyStatus(resource, status, note, t) });
    }
    return json(404, { error: "not_found" });
  }

  async function stats(): Promise<CatalogStats | null> {
    const s = await store.getMeta("stats");
    let st: CatalogStats | null = null;
    try { st = s ? (JSON.parse(s) as CatalogStats) : null; } catch { st = null; }
    const t = now();
    if (st && t - st.computed_at > STATS_STALE_MS) {
      try {
        st = await store.computeStats(t);
        await store.setMeta("stats", JSON.stringify(st));
      } catch { /* keep the stored copy */ }
    }
    return st;
  }

  function selfMatch(q: LookupQuery): boolean {
    const s = deps.self;
    if (q.domain && s.domains.includes(normalizeDomain(q.domain))) return true;
    if (q.url) { const n = normalizeUrl(q.url); if (n && s.domains.includes(normalizeDomain(new URL(n).hostname))) return true; }
    if (q.payTo && s.pay_to.map((x) => x.toLowerCase()).includes(q.payTo.trim().toLowerCase())) return true;
    return false;
  }

  /** Curated XRPL vendors matching the query, with their own XRPL purchase rows (counted apart from the Base catalog). */
  async function curatedMatches(q: LookupQuery, base: string, free: boolean) {
    const d = q.domain ? normalizeDomain(q.domain) : q.url && normalizeUrl(q.url) ? normalizeDomain(new URL(normalizeUrl(q.url)!).hostname) : null;
    const pt = q.payTo?.trim().toLowerCase();
    const vs = VENDORS.filter((v) => {
      const hosts = [v.homepage, ...v.endpoints.map((e) => e.url)].map((u) => { try { return normalizeDomain(new URL(u).hostname); } catch { return ""; } });
      const pays = [...v.pay_to.xrpl, ...(v.pay_to.evm ?? [])].map((x) => x.toLowerCase());
      return (d && hosts.some((h) => h === d || h.endsWith("." + d))) || (pt && pays.includes(pt));
    });
    if (!vs.length) return [];
    const agg = await xrplAgg();
    return vs.map((v) => {
      const buys = (agg?.rows ?? []).filter((r) => r.vendor_id === v.id);
      const last = buys[0];
      return {
        id: v.id, name: v.name, homepage: v.homepage, network: "xrpl:0",
        tier: buys.length ? "test-bought (XRPL, curated list)" : "curated XRPL list: no Lumi test-buy in the last 30 days",
        xrpl_test_buys: {
          window_days: CURATED_WINDOW_MS / 86_400_000, count: buys.length, ...deliveryCounts(buys),
          ...(last ? { last_at: iso(last.ts), last_data_returned: dataReturnedView(last), last_delivery: deliveryState(last) } : {}),
        },
        ...(free ? {} : {
          purchases: buys.slice(0, 10).map((b) => ({
            at: iso(b.ts), network: b.network, endpoint: b.endpoint, amount: b.amount, asset: b.asset, tx_hash: b.tx_hash, explorer: explorerFor(b.network, b.tx_hash),
            http_status: b.http_status, data_returned: dataReturnedView(b), delivery: deliveryState(b),
            ...(inconclusiveReason(b) ? { inconclusive_reason: inconclusiveReason(b) } : {}),
          })),
        }),
        detail: `${base}/v1/trust/vendors/${v.id}`,
      };
    });
  }

  async function lookupDoc(q: LookupQuery, base: string, opts: { free?: boolean; limit?: number } = {}) {
    const free = !!opts.free;
    const limit = opts.limit ?? (free ? FREE_LOOKUP_ENTRIES : 25);
    const query = Object.fromEntries(Object.entries(q).filter(([, v]) => v));
    const t = now();
    if (selfMatch(q)) {
      return {
        kind: "trust_lookup", query, observed: true, generated_at: iso(t),
        self: { name: deps.self.name, url: deps.self.url, label: LABELS.self, note: "This is Lumi's own API. Lumi does not score or quote-check itself." },
      };
    }
    const curated = await curatedMatches(q, base, free);
    const { total, rows } = await store.lookup(q, limit);
    const buys = await store.buysFor(rows.map((r) => r.resource));
    const doms = free ? new Map<string, any>() : new Map((await store.domainInfo([...new Set(rows.map((r) => r.reg_domain).filter((x): x is string => !!x))])).map((x) => [x.domain, x]));
    const vet = await vet402For(rows, free).catch(() => new Map());
    const entries: Array<{ tier: string } & Record<string, unknown>> = (free
      ? rows.map((r) => catalogFreeView(r, buys.filter((b) => b.resource === r.resource), t))
      : rows.map((r) => catalogView(r, buys.filter((b) => b.resource === r.resource), r.reg_domain ? doms.get(r.reg_domain) : undefined, t))
    ).map((e, i) => (vet.has(rows[i].resource) ? { ...e, third_party: { vet402: vet.get(rows[i].resource) } } : e));
    if (!curated.length && !entries.length) {
      return {
        kind: "trust_lookup", query, observed: false, generated_at: iso(t),
        note: "Lumi has no observations for this URL, domain or payTo. It is not in the CDP x402 Bazaar catalog Lumi ingests (refreshed daily) nor in Lumi's curated list. No observation is not a negative finding.",
      };
    }
    if (!free && deps.receipts) {
      try {
        const lists = [...entries, ...curated].map((e: any) => (Array.isArray(e.purchases) ? e.purchases : [])) as any[][];
        const rc: Map<string, Receipt> = await deps.receipts.byTx(lists.flat().map((x) => x.tx_hash));
        for (const l of lists) for (const x of l) { const r = rc.get(x.tx_hash); if (r) x.receipt = r; }
      } catch (e) { deps.log({ event: "receipts_error", error: String(e) }); }
    }
    const tiers: Record<string, number> = {};
    for (const e of entries) tiers[e.tier] = (tiers[e.tier] ?? 0) + 1;
    // payTo census: the queried payTo, else the payTos of the first listing (url lookups / trust/check).
    let census: Record<string, unknown>[] = [];
    try {
      const firstAcc = (() => { try { return JSON.parse(rows[0]?.accepts ?? "[]") as { n?: string; p?: string }[]; } catch { return []; } })();
      const seller = [...new Set(rows.flatMap((r) => (r.pay_tos ?? "").split(",").filter(Boolean)))];
      const targets = q.payTo
        ? [{ network: XRPL_ADDR_RE.test(q.payTo.trim()) ? XRPL_NET : BASE_NET, pay_to: q.payTo.trim() }]
        : !q.domain || q.url ? [...new Map(firstAcc.filter((a) => a.p).map((a) => [String(a.p).toLowerCase(), { network: String(a.n), pay_to: String(a.p) }])).values()] : [];
      const curatedSeller = curated.length ? VENDORS.filter((v) => curated.some((c: any) => c.id === v.id)).flatMap((v) => v.pay_to.xrpl) : [];
      census = await censusFor(targets, [...seller, ...curatedSeller], free, true);
    } catch (e) { deps.log({ event: "census_error", error: String(e) }); }
    const st = await stats();
    return {
      kind: "trust_lookup", query, observed: true, generated_at: iso(t),
      ...(st ? { coverage: coverageLine(st, await xrplAgg()) } : {}),
      labels: LABEL_NOTES,
      curated,
      catalog: { total_matches: total, shown: entries.length, ordering: "Bazaar 30-day calls, most used first", tiers_shown: tiers, entries },
      ...(census.length ? { payto_census: census } : {}),
      methodology: `${base}/v1/trust/methodology`,
      ...(free ? { evidence: freeEvidenceNote(base, q) } : {}),
      note: "Observations, not a rating. Quote checks are free unpaid requests; purchases are single test-buys. Few samples = low confidence.",
    };
  }

  function freeEvidenceNote(base: string, q?: LookupQuery) {
    const u = q?.url ? `?url=${encodeURIComponent(q.url)}` : "?url=<resource>";
    return {
      free: "answer only: tier and the yes/no outcome of the latest quote check and test-buys",
      paid: `Tx hashes, explorer links, check history, latency and domain age: ${base}/v1/trust/check${u} ($0.02) or, for curated vendors, ${base}/v1/trust/vendors/{id}/report ($0.02).`,
    };
  }

  async function summary(base: string) {
    const s = await stats();
    const x = await xrplAgg();
    const ing = await store.getMeta("ingest_last");
    return {
      source: "CDP x402 Bazaar discovery (free); x402scan's resource API is paid, so it is not ingested",
      lookup: `${base}/v1/trust/vendors?url=<resource url> | ?domain=<host> | ?payTo=<address>`,
      browse: `${base}/v1/trust/catalog (free teaser: the ${FREE_BROWSE_MAX} most-used listings, ${FREE_BROWSE_PAGE} per page)`,
      labels: LABEL_NOTES,
      coverage: s ? coverageLine(s, x) : null,
      counts: s ? { catalogued: s.catalogued, active: s.active, quote_checked: s.quote_checked, quote_checked_24h: s.quote_checked_24h, quote_verified: s.quote_verified, purchase_verified: s.by_network?.[BASE_NET]?.purchase_verified ?? s.purchase_verified, test_buys: s.by_network?.[BASE_NET]?.test_buys ?? s.test_buys, purchase_verified_note: "Bazaar catalog resources only (Base USDC). XRPL test-buys of the curated list are in purchase_verified_by_chain.xrpl, counted separately.", domains: s.domains, as_of: iso(s.computed_at) } : null,
      purchase_verified_by_chain: chainSplit(s, x),
      ...(deps.evidence ? { free_evidence: await evidenceStatus().catch(() => null) } : {}),
      last_ingest: ing ? (() => { const j = JSON.parse(ing); return { at: iso(j.at), listed_total: j.total }; })() : null,
      checks: "free, unpaid 402-quote checks rotate through the catalog in slices every 30 minutes (valid 402, price vs listing, payTo vs listing, latency); counts.quote_checked_24h shows how many resources were actually checked in the last 24 h. Registrable-domain age via RDAP monthly",
    };
  }

  let topMemo: { at: number; rows: Awaited<ReturnType<CatalogStore["top"]>> } | undefined;
  async function topRows() {
    const t = now();
    if (topMemo && t - topMemo.at < 300_000) return topMemo.rows;
    const rows = await store.top(0, FREE_BROWSE_MAX);
    topMemo = { at: t, rows };
    return rows;
  }

  /** Free teaser browse: the FREE_BROWSE_MAX most-used listings, FREE_BROWSE_PAGE per page, answer-only entries. */
  async function browseDoc(url: URL, base: string) {
    const t = now();
    const popular = url.searchParams.get("popular") === "1";
    const pages = Math.ceil(FREE_BROWSE_MAX / FREE_BROWSE_PAGE);
    const limit = Math.max(1, Math.min(FREE_BROWSE_PAGE, Number(url.searchParams.get("limit") ?? String(FREE_BROWSE_PAGE)) || FREE_BROWSE_PAGE));
    const pageRaw = Math.floor(Number(url.searchParams.get("page") ?? "1") || 1);
    const page = Math.max(1, pageRaw);
    let rows: Awaited<ReturnType<CatalogStore["top"]>> = [];
    let next: string | null = null;
    if (popular) {
      const maxUsd = Math.min(1, Number(url.searchParams.get("max_usd") ?? "0.05") || 0.05);
      rows = await store.popular(maxUsd, limit, url.searchParams.get("network") ?? "eip155:8453");
    } else if ((page - 1) * limit < FREE_BROWSE_MAX) {
      const all = await topRows();
      rows = all.slice((page - 1) * limit, Math.min(page * limit, FREE_BROWSE_MAX));
      if (page * limit < Math.min(FREE_BROWSE_MAX, all.length)) next = `${base}/v1/trust/catalog?page=${page + 1}${limit !== FREE_BROWSE_PAGE ? `&limit=${limit}` : ""}`;
    }
    const buys = await store.buysFor(rows.map((r) => r.resource));
    return {
      kind: "trust_catalog", generated_at: iso(t), summary: await summary(base),
      free_tier: {
        shows: `the ${FREE_BROWSE_MAX} most-used listings (Bazaar 30-day calls), ${FREE_BROWSE_PAGE} per page, pages 1-${pages}${popular ? "; popular=1 returns the top cheap listings only" : ""}`,
        ...(url.searchParams.has("after") ? { ignored: "after= is no longer supported: the free catalog is not a full export" } : {}),
        ...(!popular && (page - 1) * limit >= FREE_BROWSE_MAX ? { beyond_free_pages: `page ${page} is past the free teaser` } : {}),
        lookup: `Any specific listing is free to look up: ${base}/v1/trust/vendors?url=<resource url> | ?domain=<host> | ?payTo=<address>`,
        evidence: freeEvidenceNote(base),
        rate_limit: "free catalog requests are rate-limited per client per day",
      },
      ...(popular ? {} : { page }),
      entries: rows.map((r) => catalogFreeView(r, buys.filter((b) => b.resource === r.resource), t)),
      next,
    };
  }

  async function postObservation(request: Request): Promise<Response> {
    if (!(await deps.isOwner(request))) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
    let b: any;
    try { b = await request.json(); } catch { return json(400, { error: "invalid_json" }); }
    const resource = typeof b?.resource === "string" ? normalizeUrl(b.resource) : null;
    const row = resource ? await store.byResource(resource) : null;
    if (!row) return json(404, { error: "unknown_resource", detail: "resource must be a catalogued URL (GET /v1/trust/vendors?url=...)" });
    const network = String(b.network ?? "");
    let tx = typeof b.tx_hash === "string" ? b.tx_hash.trim() : "";
    if (network === "eip155:8453") { tx = tx.toLowerCase(); if (!EVM_TX_RE.test(tx)) return json(400, { error: "invalid_field", field: "tx_hash" }); }
    else if (network === "stellar:pubnet") { tx = tx.toLowerCase(); if (!STELLAR_TX_RE.test(tx)) return json(400, { error: "invalid_field", field: "tx_hash" }); }
    else if (network === "xrpl:0") { tx = tx.toUpperCase(); if (!XRPL_TX_RE.test(tx)) return json(400, { error: "invalid_field", field: "tx_hash" }); }
    else return json(400, { error: "invalid_field", field: "network", detail: "eip155:8453, xrpl:0 or stellar:pubnet" });
    if (typeof b.data_returned !== "boolean") return json(400, { error: "invalid_field", field: "data_returned" });
    const summaryText = typeof b.summary === "string" ? b.summary.replace(/\s+/g, " ").trim() : "";
    if (!summaryText || summaryText.length > 300) return json(400, { error: "invalid_field", field: "summary", detail: "1-300 chars" });
    if (BANNED.test(summaryText)) return json(400, { error: "invalid_field", field: "summary", detail: "factual wording only" });
    const look = network === "eip155:8453" ? await lookupBaseUsdc(deps.fetch, deps.baseRpc, tx)
      : network === "stellar:pubnet" ? await lookupStellarUsdc(deps.fetch, deps.stellarHorizon ?? STELLAR_HORIZON, tx)
      : await lookupXrplPayment(deps.fetch, deps.xrplRpc, tx);
    if (!look.ok) return json(look.reason === "ledger_unavailable" ? 503 : 422, { recorded: false, reason: look.reason });
    const buyers = (network === "eip155:8453" ? deps.buyers.evm : network === "stellar:pubnet" ? deps.buyers.stellar ?? [] : deps.buyers.xrpl).map((x) => x.toLowerCase());
    const listed = (row.pay_tos ?? "").split(",");
    const pay = look.payments.find((p) => buyers.includes(p.from.toLowerCase()) && listed.includes(p.to.toLowerCase()));
    if (!pay) return json(422, { recorded: false, reason: "no payment from a Lumi wallet to a listed payTo in this tx" });
    const http = b.http_status == null ? null : Number(b.http_status);
    const lat = b.latency_ms == null ? null : Number(b.latency_ms);
    if (b.inconclusive != null && !isInconclusiveReason(b.inconclusive)) return json(400, { error: "invalid_field", field: "inconclusive", detail: Object.keys(INCONCLUSIVE_REASONS).join(" | ") });
    // Guard: no HTTP status + no data is inconclusive (Lumi-side), never "no data returned".
    const buy: BuyRow = guardBuy({
      resource: row.resource, domain: row.domain, ts: Number.isFinite(pay.ts) ? pay.ts : now(), network, tx_hash: tx, amount: pay.amount, asset: pay.asset,
      pay_to: pay.to, facilitator: typeof b.facilitator === "string" ? b.facilitator.slice(0, 80) : null,
      http_status: Number.isInteger(http) ? http : null, data_returned: b.data_returned, latency_ms: Number.isInteger(lat) ? lat : null, summary: summaryText,
      inconclusive: b.inconclusive ?? null,
    });
    const ins = await store.addBuy(buy);
    deps.log({ event: "catalog_buy", domain: row.domain, inserted: ins === "inserted" });
    if (ins === "inserted") {
      // Keep the public test-bought counts in step with the entries.
      try { await store.setMeta("stats", JSON.stringify(await store.computeStats(now()))); } catch { /* next cron run */ }
      topMemo = undefined;
    }
    return json(ins === "inserted" ? 201 : 200, { recorded: ins === "inserted", duplicate: ins === "duplicate", tx_hash: tx, explorer: explorerFor(network, tx) });
  }

  async function handle(request: Request, url: URL, base: string): Promise<Response | null> {
    const path = url.pathname;
    if (request.method === "GET" && path === "/v1/trust/catalog") return json(200, await browseDoc(url, base), { "Cache-Control": "public, max-age=300" });
    if (request.method === "POST" && path === "/v1/trust/catalog/observations") return postObservation(request);
    if (request.method === "POST" && (path.startsWith("/v1/trust/catalog/evidence/") || path === "/v1/trust/catalog/buy-queue")) return postEvidence(request, url);
    if (request.method === "GET" && path === "/v1/trust/catalog/buy-queue") {
      if (!(await deps.isOwner(request))) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      if (!deps.evidence) return json(503, { error: "evidence_unavailable" });
      const status = url.searchParams.get("status") ?? "queued";
      const rows = await deps.evidence.buyQueue(status, Math.min(200, Number(url.searchParams.get("limit") ?? "50") || 50));
      if (!deps.sanctions) return json(200, { status, rows }, { "Cache-Control": "no-store" });
      // Sanctions screen before the runner sees a row: the listing's payTos (one indexed read per row, owner-only, once a day).
      await deps.sanctions.ready();
      const keep: typeof rows = [], refused: { resource: string; pay_to: string; reason: string }[] = [];
      for (const r of rows) {
        const listed = (await store.byResource(r.resource).catch(() => null))?.pay_tos ?? "";
        const hit = deps.sanctions.checkAny(listed.split(","));
        if (hit) { deps.sanctions.refuse("catalog_buy_queue", hit, { resource: r.resource }); refused.push({ resource: r.resource, pay_to: hit.normalized, reason: "sanctioned_address" }); }
        else keep.push(r);
      }
      return json(200, { status, rows: keep, ...(refused.length ? { refused } : {}) }, { "Cache-Control": "no-store" });
    }
    if (request.method === "POST" && path === "/v1/trust/catalog/ingest") {
      if (!(await deps.isOwner(request))) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      if (url.searchParams.get("now") === "1") return json(200, { started: true, total: await startIngest() });
      return json(202, { requested: false, detail: "Not needed: the 30-minute cron runs a rolling ingest that covers the full catalog daily. Use ?now=1 to queue every page immediately." });
    }
    if (request.method === "POST" && path === "/v1/trust/catalog/stats") {
      if (!(await deps.isOwner(request))) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      const s = await store.computeStats(now());
      await store.setMeta("stats", JSON.stringify(s));
      return json(200, s);
    }
    return null;
  }

  /** Owner correction: reclassify a stored catalog buy as inconclusive (Lumi-side). The prior summary is kept. */
  const markInconclusive = (tx: string, reason: string, summary: string) => deps.store.markInconclusive(tx, reason, summary, deps.now());
  return { cron, consume, lookupDoc, summary, handle, startIngest, stats, xrplAgg, queueBuy, queueConfirmBuy, markInconclusive };
}

export type Catalog = ReturnType<typeof createCatalog>;
export type { D1Like };

const fmt = (n: number) => Number(n ?? 0).toLocaleString("en-US");
/** Honest one-line coverage: what is indexed vs what Lumi actually checked or bought. */
export function coverageLine(s: { catalogued: number; domains: number; quote_verified: number; purchase_verified: number; quote_checked_24h?: number; by_network?: CatalogStats["by_network"] }, x?: XrplAgg | null): string {
  const base = s.by_network?.["eip155:8453"]?.purchase_verified ?? s.purchase_verified;
  return `${fmt(s.catalogued)} resources across ${fmt(s.domains)} domains indexed, ${fmt(s.quote_verified)} quote-checked, ${fmt(base)} test-bought on Base (USDC)` +
    (s.quote_checked_24h != null ? ` (${fmt(s.quote_checked_24h)} quote-checked in the last 24 h)` : "") +
    (x ? `; separately, ${fmt(x.endpoints)} XRPL endpoints from ${fmt(x.vendors)} curated vendors test-bought (${fmt(x.buys)} XRPL test-buys in 30 days, ${fmt(x.delivered)} returned data)` : "") +
    `; XRPL Bazaar sweep: ${XRPL_BAZAAR_SWEEP.statement}`;
}
