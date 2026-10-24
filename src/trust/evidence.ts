/**
 * Free trust evidence (no purchases): XRPL payTo census, Base USDC forward index with funder clustering,
 * vet402 open data (CC BY 4.0, third-party) and the demand-driven test-buy queue.
 * Facts only, dated; never a judgement about anyone. Third-party data is never mixed into Lumi's own purchase-verified counts.
 */
import type { D1Like } from "../config";
import { rpc, rpcAny, assetOfIou, RIPPLE_EPOCH, TRANSFER_TOPIC, BASE_USDC, XRPL_ADDR_RE, EVM_ADDR_RE } from "./verify";

type Fetch = typeof fetch;

export const X402_SOURCE_TAG = 804681468;
export const BASE_NET = "eip155:8453";
export const XRPL_NET = "xrpl:0";
/** Lumi's own wallets (payments from them, or from accounts they funded, are never organic). */
export const LUMI_WALLETS = {
  xrpl: ["rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM", "rpvsTYDZmX1j1ndmEFG6YjjZZwp6VRtQRz", "r4sRyacXpbh4HbagmgfoQq8Q3j8ZJzbZ1J"],
  evm: ["0x5e617bac19912e6d212cb303ae84655e9e203532", "0x7722dfae6bbed2fd02dc07455c2f5bf14be25e4a", "0xbaaf2635c9a7697601600749ca90456274667999"],
};
/** Known test/scanner wallets (owner can extend via meta `known_testers`). */
export const KNOWN_TESTERS = { xrpl: ["r4w68TArDZjivtcFMNL7PvKf7uPg14Vev8"], evm: [] as string[] };
/** A funder that funded at least this many indexed payers is treated as a hub (exchange, bridge, faucet) and not used for clustering. */
export const HUB_MIN = 20;
export const CENSUS_FRESH_MS = 24 * 3_600_000;
export const CENSUS_REQUEUE_MS = 15 * 60_000;
export const BASE_BLOCK_MS = 2000;
export const BASE_WINDOW_MAX = 1800; // blocks per cron run (~1 h); more backlog than that is skipped and recorded as a gap
export const BASE_GROUP = 200; // payTos per getLogs topic filter
export const FUNDER_LOOKBACK = 9000; // blocks (~5 h) before the first indexed payment
export const VET402 = {
  source: "vet402 observatory (KIZUNA Creation)",
  license: "CC BY 4.0",
  license_url: "https://creativecommons.org/licenses/by/4.0/",
  link: "https://vet402.com/observatory",
  methodology: "https://vet402.com/observatory/methodology",
  cite: (d: string) => `KIZUNA Creation. vet402 observatory. Dataset, retrieved ${d}. https://vet402.com/api/v1/observatory/state`,
};

const iso = (t: number | null | undefined) => (t == null || !Number.isFinite(t) ? null : new Date(t).toISOString());

// ---------------------------------------------------------------- rows

export interface CensusRow { network: string; pay_to: string; checked_at: number; queued_at: number | null; doc: string | null }
export interface InflowRow { pay_to: string; payer: string; n: number; units: number; first_ts: number; last_ts: number; first_block: number; last_tx: string }
export interface FunderRow { network: string; account: string; funder: string | null; checked_at: number; note: string | null }
export interface Vet402Row {
  resource_key: string; network: string | null; l0_verdict: string | null; l0_probed_at: number | null; listed: number | null;
  l1_attempts: number; l1_settled: number; l1_delivered: number; l1_last_at: number | null; l1_last_status: string | null; l1_last_http: number | null; l1_last_tx: string | null; retrieved_at: number;
}
export interface QueueRow { resource: string; network: string; price_usd: number | null; reasons: string; hits: number; status: string; queued_at: number; updated_at: number; note: string | null }

export type PriorityClaim = "claimed" | "duplicate" | "cap_reached";

export interface EvidenceStore {
  getCensus(network: string, payTo: string): Promise<CensusRow | null>;
  putCensus(row: CensusRow): Promise<void>;
  /** Mark queued unless queued recently; true when the caller should enqueue a job. */
  markQueued(network: string, payTo: string, t: number): Promise<boolean>;
  addInflow(rows: InflowRow[]): Promise<number>;
  inflowFor(payTo: string, limit: number): Promise<InflowRow[]>;
  unresolvedPayers(limit: number): Promise<{ payer: string; first_block: number }[]>;
  funders(network: string, accounts: string[]): Promise<FunderRow[]>;
  putFunders(rows: FunderRow[]): Promise<number>;
  hubs(min: number): Promise<{ network: string; funder: string; n: number }[]>;
  putVet402(rows: Vet402Row[]): Promise<number>;
  vet402For(keys: string[]): Promise<Vet402Row[]>;
  enqueueBuy(r: { resource: string; network: string; price_usd: number | null; reasons: string[] }, t: number): Promise<void>;
  buyQueue(status: string, limit: number): Promise<QueueRow[]>;
  setBuyStatus(resource: string, status: string, note: string | null, t: number): Promise<boolean>;
  /**
   * Test-buy priority slot for one seller on one UTC day (abuse limit for check-driven queue jumps, free and paid alike):
   * "claimed" when this is the seller's first signal today and fewer than `cap` sellers were claimed today; "duplicate"
   * when the seller already has today's slot; "cap_reached" when the day's cap is used up. Atomic on D1.
   */
  claimPriority(day: string, seller: string, resource: string, cap: number, t: number): Promise<PriorityClaim>;
  existingResources(urls: string[]): Promise<string[]>;
  evmPayTos(): Promise<string[]>;
  xrplPayTos(): Promise<string[]>;
}

export class MemoryEvidenceStore implements EvidenceStore {
  census = new Map<string, CensusRow>();
  inflow = new Map<string, InflowRow>();
  fund = new Map<string, FunderRow>();
  vet = new Map<string, Vet402Row>();
  queue = new Map<string, QueueRow>();
  resources = new Set<string>();
  evm: string[] = [];
  xrpl: string[] = [];
  async getCensus(n: string, p: string) { return this.census.get(`${n}|${p}`) ?? null; }
  async putCensus(r: CensusRow) { this.census.set(`${r.network}|${r.pay_to}`, r); }
  async markQueued(n: string, p: string, t: number) {
    const ex = this.census.get(`${n}|${p}`);
    if (ex?.queued_at && ex.queued_at > t - CENSUS_REQUEUE_MS) return false;
    this.census.set(`${n}|${p}`, { network: n, pay_to: p, checked_at: ex?.checked_at ?? 0, queued_at: t, doc: ex?.doc ?? null });
    return true;
  }
  async addInflow(rows: InflowRow[]) {
    for (const r of rows) {
      const k = `${r.pay_to}|${r.payer}`;
      const ex = this.inflow.get(k);
      if (!ex) this.inflow.set(k, { ...r });
      else {
        ex.n += r.n; ex.units += r.units; ex.first_ts = Math.min(ex.first_ts, r.first_ts); ex.first_block = Math.min(ex.first_block, r.first_block);
        if (r.last_ts >= ex.last_ts) { ex.last_ts = r.last_ts; ex.last_tx = r.last_tx; }
      }
    }
    return rows.length;
  }
  async inflowFor(p: string, limit: number) { return [...this.inflow.values()].filter((r) => r.pay_to === p).sort((a, b) => b.last_ts - a.last_ts).slice(0, limit); }
  async unresolvedPayers(limit: number) {
    const m = new Map<string, { payer: string; first_block: number; last: number }>();
    for (const r of this.inflow.values()) {
      if (this.fund.has(`${BASE_NET}|${r.payer}`)) continue;
      const ex = m.get(r.payer);
      if (!ex) m.set(r.payer, { payer: r.payer, first_block: r.first_block, last: r.last_ts });
      else { ex.first_block = Math.min(ex.first_block, r.first_block); ex.last = Math.max(ex.last, r.last_ts); }
    }
    return [...m.values()].sort((a, b) => b.last - a.last).slice(0, limit).map(({ payer, first_block }) => ({ payer, first_block }));
  }
  async funders(n: string, accts: string[]) { return accts.map((a) => this.fund.get(`${n}|${a}`)).filter((x): x is FunderRow => !!x); }
  async putFunders(rows: FunderRow[]) { for (const r of rows) this.fund.set(`${r.network}|${r.account}`, r); return rows.length; }
  async hubs(min: number) {
    const c = new Map<string, { network: string; funder: string; n: number }>();
    for (const f of this.fund.values()) if (f.funder) { const k = `${f.network}|${f.funder}`; const x = c.get(k) ?? { network: f.network, funder: f.funder, n: 0 }; x.n++; c.set(k, x); }
    return [...c.values()].filter((x) => x.n >= min);
  }
  async putVet402(rows: Vet402Row[]) { for (const r of rows) this.vet.set(r.resource_key, r); return rows.length; }
  async vet402For(keys: string[]) { return keys.map((k) => this.vet.get(k)).filter((x): x is Vet402Row => !!x); }
  async enqueueBuy(r: { resource: string; network: string; price_usd: number | null; reasons: string[] }, t: number) {
    const ex = this.queue.get(r.resource);
    if (ex) { if (ex.status !== "queued" && ex.updated_at < t - 30 * 86_400_000) ex.status = "queued"; ex.hits++; ex.updated_at = t; ex.reasons = r.reasons.join(","); return; }
    this.queue.set(r.resource, { resource: r.resource, network: r.network, price_usd: r.price_usd, reasons: r.reasons.join(","), hits: 1, status: "queued", queued_at: t, updated_at: t, note: null });
  }
  async buyQueue(status: string, limit: number) { return [...this.queue.values()].filter((q) => status === "all" || q.status === status).sort((a, b) => b.hits - a.hits || a.queued_at - b.queued_at).slice(0, limit); }
  async setBuyStatus(resource: string, status: string, note: string | null, t: number) {
    const ex = this.queue.get(resource); if (!ex) return false; ex.status = status; ex.note = note; ex.updated_at = t; return true;
  }
  priority = new Map<string, { day: string; seller: string; resource: string; at: number }>();
  async claimPriority(day: string, seller: string, resource: string, cap: number, t: number): Promise<PriorityClaim> {
    if (this.priority.has(`${day}|${seller}`)) return "duplicate";
    if ([...this.priority.values()].filter((p) => p.day === day).length >= cap) return "cap_reached";
    this.priority.set(`${day}|${seller}`, { day, seller, resource, at: t });
    return "claimed";
  }
  async existingResources(urls: string[]) { return urls.filter((u) => this.resources.has(u)); }
  async evmPayTos() { return this.evm; }
  async xrplPayTos() { return this.xrpl; }
}

export class D1EvidenceStore implements EvidenceStore {
  constructor(private db: D1Like) {}
  async getCensus(n: string, p: string) {
    return this.db.prepare("SELECT network, pay_to, checked_at, queued_at, doc FROM payto_census WHERE network = ?1 AND pay_to = ?2").bind(n, p).first<CensusRow>();
  }
  async putCensus(r: CensusRow) {
    await this.db.prepare(
      "INSERT INTO payto_census (network, pay_to, checked_at, queued_at, doc) VALUES (?1, ?2, ?3, NULL, ?4) ON CONFLICT(network, pay_to) DO UPDATE SET checked_at = excluded.checked_at, queued_at = NULL, doc = excluded.doc",
    ).bind(r.network, r.pay_to, r.checked_at, r.doc).run();
  }
  async markQueued(n: string, p: string, t: number) {
    const r = await this.db.prepare(
      `INSERT INTO payto_census (network, pay_to, checked_at, queued_at, doc) VALUES (?1, ?2, 0, ?3, NULL)
       ON CONFLICT(network, pay_to) DO UPDATE SET queued_at = excluded.queued_at WHERE payto_census.queued_at IS NULL OR payto_census.queued_at < ?4 RETURNING queued_at`,
    ).bind(n, p, t, t - CENSUS_REQUEUE_MS).first<{ queued_at: number }>();
    return !!r;
  }
  async addInflow(rows: InflowRow[]) {
    if (!rows.length) return 0;
    const stmts = rows.map((r) => this.db.prepare(
      `INSERT INTO base_inflow (pay_to, payer, n, units, first_ts, last_ts, first_block, last_tx) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(pay_to, payer) DO UPDATE SET n = base_inflow.n + excluded.n, units = base_inflow.units + excluded.units,
         first_ts = MIN(base_inflow.first_ts, excluded.first_ts), first_block = MIN(base_inflow.first_block, excluded.first_block),
         last_tx = CASE WHEN excluded.last_ts >= base_inflow.last_ts THEN excluded.last_tx ELSE base_inflow.last_tx END,
         last_ts = MAX(base_inflow.last_ts, excluded.last_ts)`,
    ).bind(r.pay_to, r.payer, r.n, r.units, r.first_ts, r.last_ts, r.first_block, r.last_tx));
    // Work list for funder resolution: only payers without a funders row (an ignored insert writes nothing).
    for (const r of rows) stmts.push(this.db.prepare(
      `INSERT OR IGNORE INTO funder_todo (payer, first_block, added_at) SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM funders WHERE network = '${BASE_NET}' AND account = ?1)`,
    ).bind(r.payer, r.first_block, r.last_ts));
    for (let i = 0; i < stmts.length; i += 100) await this.db.batch(stmts.slice(i, i + 100));
    return rows.length * 2;
  }
  async inflowFor(p: string, limit: number) {
    return (await this.db.prepare("SELECT * FROM base_inflow WHERE pay_to = ?1 ORDER BY last_ts DESC LIMIT ?2").bind(p, limit).all<InflowRow>()).results ?? [];
  }
  async unresolvedPayers(limit: number) {
    return (await this.db.prepare("SELECT payer, first_block FROM funder_todo ORDER BY added_at DESC LIMIT ?1").bind(limit).all<{ payer: string; first_block: number }>()).results ?? [];
  }
  async funders(n: string, accts: string[]) {
    if (!accts.length) return [];
    const out: FunderRow[] = [];
    for (let i = 0; i < accts.length; i += 90) {
      const part = accts.slice(i, i + 90);
      const ph = part.map((_, j) => `?${j + 2}`).join(",");
      out.push(...((await this.db.prepare(`SELECT * FROM funders WHERE network = ?1 AND account IN (${ph})`).bind(n, ...part).all<FunderRow>()).results ?? []));
    }
    return out;
  }
  async putFunders(rows: FunderRow[]) {
    if (!rows.length) return 0;
    await this.db.batch(rows.map((r) => this.db.prepare(
      "INSERT INTO funders (network, account, funder, checked_at, note) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(network, account) DO UPDATE SET funder = excluded.funder, checked_at = excluded.checked_at, note = excluded.note",
    ).bind(r.network, r.account, r.funder, r.checked_at, r.note)));
    const evm = rows.filter((r) => r.network === BASE_NET).map((r) => r.account);
    if (evm.length) await this.db.batch(evm.map((a) => this.db.prepare("DELETE FROM funder_todo WHERE payer = ?1").bind(a)));
    return rows.length + evm.length;
  }
  async hubs(min: number) {
    return (await this.db.prepare("SELECT network, funder, COUNT(*) AS n FROM funders WHERE funder IS NOT NULL GROUP BY network, funder HAVING n >= ?1").bind(min).all<any>()).results ?? [];
  }
  async putVet402(rows: Vet402Row[]) {
    if (!rows.length) return 0;
    const stmts = rows.map((r) => this.db.prepare(
      `INSERT INTO ext_vet402 (resource_key, network, l0_verdict, l0_probed_at, listed, l1_attempts, l1_settled, l1_delivered, l1_last_at, l1_last_status, l1_last_http, l1_last_tx, retrieved_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
       ON CONFLICT(resource_key) DO UPDATE SET network = excluded.network, l0_verdict = excluded.l0_verdict, l0_probed_at = excluded.l0_probed_at, listed = excluded.listed,
         l1_attempts = excluded.l1_attempts, l1_settled = excluded.l1_settled, l1_delivered = excluded.l1_delivered, l1_last_at = excluded.l1_last_at,
         l1_last_status = excluded.l1_last_status, l1_last_http = excluded.l1_last_http, l1_last_tx = excluded.l1_last_tx, retrieved_at = excluded.retrieved_at`,
    ).bind(r.resource_key, r.network, r.l0_verdict, r.l0_probed_at, r.listed, r.l1_attempts, r.l1_settled, r.l1_delivered, r.l1_last_at, r.l1_last_status, r.l1_last_http, r.l1_last_tx, r.retrieved_at));
    for (let i = 0; i < stmts.length; i += 100) await this.db.batch(stmts.slice(i, i + 100));
    return rows.length;
  }
  async vet402For(keys: string[]) {
    if (!keys.length) return [];
    const ph = keys.slice(0, 90).map((_, i) => `?${i + 1}`).join(",");
    return (await this.db.prepare(`SELECT * FROM ext_vet402 WHERE resource_key IN (${ph})`).bind(...keys.slice(0, 90)).all<Vet402Row>()).results ?? [];
  }
  async enqueueBuy(r: { resource: string; network: string; price_usd: number | null; reasons: string[] }, t: number) {
    await this.db.prepare(
      `INSERT INTO buy_queue (resource, network, price_usd, reasons, hits, status, queued_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, 'queued', ?5, ?5)
       ON CONFLICT(resource) DO UPDATE SET hits = buy_queue.hits + 1, reasons = excluded.reasons, updated_at = excluded.updated_at,
         status = CASE WHEN buy_queue.status <> 'queued' AND buy_queue.updated_at < ?6 THEN 'queued' ELSE buy_queue.status END`,
    ).bind(r.resource, r.network, r.price_usd, r.reasons.join(","), t, t - 30 * 86_400_000).run();
  }
  async buyQueue(status: string, limit: number) {
    const sql = status === "all" ? "SELECT * FROM buy_queue ORDER BY hits DESC, queued_at LIMIT ?1" : "SELECT * FROM buy_queue WHERE status = ?2 ORDER BY hits DESC, queued_at LIMIT ?1";
    const st = status === "all" ? this.db.prepare(sql).bind(limit) : this.db.prepare(sql).bind(limit, status);
    return (await st.all<QueueRow>()).results ?? [];
  }
  async setBuyStatus(resource: string, status: string, note: string | null, t: number) {
    const r = await this.db.prepare("UPDATE buy_queue SET status = ?2, note = ?3, updated_at = ?4 WHERE resource = ?1 RETURNING resource").bind(resource, status, note, t).first();
    return !!r;
  }
  async claimPriority(day: string, seller: string, resource: string, cap: number, t: number): Promise<PriorityClaim> {
    // One statement: the cap count and the insert run together (D1 serialises writes), so concurrent checks cannot overshoot.
    const r = await this.db.prepare(
      `INSERT INTO buy_priority (day, seller, resource, at) SELECT ?1, ?2, ?3, ?4
       WHERE (SELECT COUNT(*) FROM buy_priority WHERE day = ?1) < ?5
       ON CONFLICT(day, seller) DO NOTHING RETURNING seller`,
    ).bind(day, seller, resource, t, cap).first();
    if (r) return "claimed";
    const ex = await this.db.prepare("SELECT seller FROM buy_priority WHERE day = ?1 AND seller = ?2").bind(day, seller).first();
    return ex ? "duplicate" : "cap_reached";
  }
  async existingResources(urls: string[]) {
    if (!urls.length) return [];
    const out: string[] = [];
    for (let i = 0; i < urls.length; i += 90) {
      const part = urls.slice(i, i + 90);
      const ph = part.map((_, j) => `?${j + 1}`).join(",");
      out.push(...((await this.db.prepare(`SELECT resource FROM catalog WHERE resource IN (${ph})`).bind(...part).all<{ resource: string }>()).results ?? []).map((r) => r.resource));
    }
    return out;
  }
  async evmPayTos() {
    return ((await this.db.prepare("SELECT DISTINCT pay_to_lc AS p FROM catalog_payto WHERE pay_to_lc LIKE '0x%' ORDER BY pay_to_lc").all<{ p: string }>()).results ?? []).map((r) => r.p).filter((p) => EVM_ADDR_RE.test(p));
  }
  async xrplPayTos() {
    const rows = (await this.db.prepare("SELECT c.accepts AS a FROM catalog c WHERE c.resource IN (SELECT resource FROM catalog_payto WHERE pay_to_lc LIKE 'r%') LIMIT 500").all<{ a: string }>()).results ?? [];
    const s = new Set<string>();
    for (const r of rows) { try { for (const x of JSON.parse(r.a ?? "[]")) if (typeof x?.p === "string" && XRPL_ADDR_RE.test(x.p)) s.add(x.p); } catch { /* skip */ } }
    return [...s];
  }
}

// ---------------------------------------------------------------- classification (shared by XRPL and Base)

export interface PayerAgg { payer: string; funder?: string | null; funder_known: boolean; n: number; last_ts: number; last_tx: string | null; usd?: number; amounts?: Record<string, number> }
export interface ClassCtx { payTo: string; sellerPayTos: string[]; lumi: string[]; testers: string[]; hubs: Set<string> }

export function classifyPayers(payers: PayerAgg[], ctx: ClassCtx) {
  const lc = (x: string) => x.toLowerCase();
  const lumi = new Set(ctx.lumi.map(lc));
  const testers = new Set(ctx.testers.map(lc));
  const seller = new Set([ctx.payTo, ...ctx.sellerPayTos].map(lc));
  const ex = { lumi: 0, known_testers: 0, self_funded: 0 };
  const clusters = new Map<string, { key: string; funder: string | null; payers: string[]; n: number; last_ts: number; last_tx: string | null; usd: number }>();
  let organicPayments = 0;
  let lastOrganic = 0;
  let unresolved = 0;
  let organicUsd = 0;
  for (const p of payers) {
    const a = lc(p.payer);
    const f = p.funder ? lc(p.funder) : null;
    if (lumi.has(a) || (f && lumi.has(f))) { ex.lumi++; continue; }
    if (testers.has(a) || (f && testers.has(f))) { ex.known_testers++; continue; }
    if (seller.has(a) || (f && seller.has(f))) { ex.self_funded++; continue; }
    if (!p.funder_known) unresolved++;
    const key = f && !ctx.hubs.has(f) ? `f:${f}` : `a:${a}`;
    const c = clusters.get(key) ?? { key, funder: key.startsWith("f:") ? p.funder! : null, payers: [], n: 0, last_ts: 0, last_tx: null, usd: 0 };
    c.payers.push(p.payer); c.n += p.n; c.usd += p.usd ?? 0;
    if (p.last_ts > c.last_ts) { c.last_ts = p.last_ts; c.last_tx = p.last_tx; }
    clusters.set(key, c);
    organicPayments += p.n; organicUsd += p.usd ?? 0;
    lastOrganic = Math.max(lastOrganic, p.last_ts);
  }
  return {
    payers_seen: payers.length,
    excluded: ex,
    organic_payers: clusters.size,
    organic_wallets: [...clusters.values()].reduce((s, c) => s + c.payers.length, 0),
    organic_payments: organicPayments,
    organic_usd: Math.round(organicUsd * 1e6) / 1e6,
    last_organic_at: iso(lastOrganic || null),
    funder_unresolved: unresolved,
    clusters: [...clusters.values()].sort((a, b) => b.n - a.n),
  };
}

// ---------------------------------------------------------------- XRPL census (one account_tx page)

export interface XrplCensusDoc {
  network: string; pay_to: string; checked_at: number; scanned_tx: number; window_from: number | null; window_to: number | null; complete: boolean;
  incoming_payments: number; x402_payments: number; markers: { source_tag: number; invoice_id: number };
  payers: { a: string; f: string | null; fk: boolean; n: number; last_ts: number; last_tx: string; amt: Record<string, number> }[];
}

const xrplTs = (res: any, tx: any) => (res.close_time_iso ? Date.parse(res.close_time_iso) : typeof tx.date === "number" ? (tx.date + RIPPLE_EPOCH) * 1000 : NaN);

export async function xrplCensus(f: Fetch, urls: string[], payTo: string, store: EvidenceStore, t: number, maxFunders = 10): Promise<XrplCensusDoc> {
  let res: any = null;
  for (const u of urls) {
    try {
      const r = (await rpc(f, u, { method: "account_tx", params: [{ account: payTo, limit: 200, forward: false, api_version: 2 }] }))?.result;
      if (r?.error === "actNotFound") { res = { transactions: [] }; break; }
      if (r?.transactions) { res = r; break; }
    } catch { /* next */ }
  }
  if (!res) throw new Error("xrpl ledger unavailable");
  const txs: any[] = res.transactions ?? [];
  const per = new Map<string, XrplCensusDoc["payers"][number]>();
  let incoming = 0, x402 = 0, st = 0, inv = 0, from: number | null = null, to: number | null = null;
  for (const e of txs) {
    const tx = e.tx_json ?? e.tx ?? {};
    const meta = e.meta ?? {};
    const ts = xrplTs(e, tx);
    if (Number.isFinite(ts)) { from = from == null ? ts : Math.min(from, ts); to = to == null ? ts : Math.max(to, ts); }
    if (tx.TransactionType !== "Payment" || tx.Destination !== payTo || meta.TransactionResult !== "tesSUCCESS" || tx.Account === payTo) continue;
    incoming++;
    const isTag = tx.SourceTag === X402_SOURCE_TAG;
    const isInv = typeof tx.InvoiceID === "string" && tx.InvoiceID.length > 0;
    if (!isTag && !isInv) continue;
    x402++; if (isTag) st++; if (isInv) inv++;
    const d = meta.delivered_amount ?? meta.DeliveredAmount;
    let asset = "XRP", v = 0;
    if (typeof d === "string") v = Number(d) / 1e6;
    else if (d?.value) { v = Number(d.value); asset = assetOfIou(d); }
    const p = per.get(tx.Account) ?? { a: tx.Account, f: null, fk: false, n: 0, last_ts: 0, last_tx: "", amt: {} as Record<string, number> };
    p.amt = p.amt ?? {};
    p.n++; p.amt[asset] = (p.amt[asset] ?? 0) + v;
    if (ts > p.last_ts) { p.last_ts = ts; p.last_tx = String(e.hash ?? tx.hash ?? "").toUpperCase(); }
    per.set(tx.Account, p);
  }
  const payers = [...per.values()].sort((a, b) => b.n - a.n).slice(0, 100);
  // Funders: cached, then a few lookups per job (first tx of the account, forward order).
  const known = new Map((await store.funders(XRPL_NET, payers.map((p) => p.a))).map((r) => [r.account, r]));
  const fresh: FunderRow[] = [];
  for (const p of payers) {
    const k = known.get(p.a);
    if (k) { p.f = k.funder; p.fk = true; continue; }
    if (fresh.length >= maxFunders) continue;
    let funder: string | null = null, note: string | null = null, ok = false;
    for (const u of urls) {
      try {
        const r = (await rpc(f, u, { method: "account_tx", params: [{ account: p.a, limit: 1, forward: true, api_version: 2 }] }))?.result;
        const first = r?.transactions?.[0];
        if (!r?.transactions) continue;
        const ftx = first?.tx_json ?? first?.tx ?? {};
        if (ftx.TransactionType === "Payment" && ftx.Destination === p.a) funder = ftx.Account; else note = "first transaction is not an incoming payment";
        ok = true; break;
      } catch { /* next */ }
    }
    if (!ok) continue;
    p.f = funder; p.fk = true;
    fresh.push({ network: XRPL_NET, account: p.a, funder, checked_at: t, note });
  }
  if (fresh.length) await store.putFunders(fresh);
  const doc: XrplCensusDoc = {
    network: XRPL_NET, pay_to: payTo, checked_at: t, scanned_tx: txs.length, window_from: from, window_to: to, complete: !res.marker,
    incoming_payments: incoming, x402_payments: x402, markers: { source_tag: st, invoice_id: inv }, payers,
  };
  await store.putCensus({ network: XRPL_NET, pay_to: payTo, checked_at: t, queued_at: null, doc: JSON.stringify(doc) });
  return doc;
}

// ---------------------------------------------------------------- Base forward index

const pad = (a: string) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
const hex = (n: number) => "0x" + n.toString(16);

export async function baseHead(f: Fetch, urls: string[]): Promise<{ block: number; ts: number }> {
  const b = (await rpcAny(f, urls, { jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }))?.result;
  const block = parseInt(b?.number, 16), ts = parseInt(b?.timestamp, 16) * 1000;
  if (!Number.isFinite(block) || !Number.isFinite(ts)) throw new Error("base head unavailable");
  return { block, ts };
}

async function getLogs(f: Fetch, urls: string[], from: number, to: number, topics: unknown[]): Promise<any[]> {
  const r = await rpcAny(f, urls, { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: BASE_USDC, fromBlock: hex(from), toBlock: hex(to), topics }] });
  if (!Array.isArray(r?.result)) throw new Error("getLogs: no result");
  return r.result;
}

/** USDC Transfer logs into `payTos` over [from, to]; aggregated per (payTo, payer). Self-transfers and mints are skipped. */
export async function baseLogs(f: Fetch, urls: string[], payTos: string[], from: number, to: number, head: { block: number; ts: number }): Promise<InflowRow[]> {
  const topics = [TRANSFER_TOPIC, null, payTos.map(pad)];
  let logs: any[];
  try { logs = await getLogs(f, urls, from, to, topics); }
  catch (e) {
    if (to - from < 200) throw e;
    const mid = Math.floor((from + to) / 2); // range too large for the RPC: two halves
    logs = [...(await getLogs(f, urls, from, mid, topics)), ...(await getLogs(f, urls, mid + 1, to, topics))];
  }
  const agg = new Map<string, InflowRow>();
  for (const l of logs) {
    if (String(l.address).toLowerCase() !== BASE_USDC || l.topics?.[0] !== TRANSFER_TOPIC || l.topics.length < 3) continue;
    const payer = "0x" + String(l.topics[1]).slice(-40).toLowerCase();
    const payTo = "0x" + String(l.topics[2]).slice(-40).toLowerCase();
    if (payer === payTo || /^0x0{40}$/.test(payer)) continue;
    let units = 0;
    try { units = Number(BigInt(l.data)); } catch { continue; }
    if (!(units > 0)) continue;
    const b = parseInt(l.blockNumber, 16);
    const ts = head.ts - (head.block - b) * BASE_BLOCK_MS;
    const k = `${payTo}|${payer}`;
    const ex = agg.get(k);
    if (!ex) agg.set(k, { pay_to: payTo, payer, n: 1, units, first_ts: ts, last_ts: ts, first_block: b, last_tx: String(l.transactionHash).toLowerCase() });
    else {
      ex.n++; ex.units += units; ex.first_ts = Math.min(ex.first_ts, ts); ex.first_block = Math.min(ex.first_block, b);
      if (ts >= ex.last_ts) { ex.last_ts = ts; ex.last_tx = String(l.transactionHash).toLowerCase(); }
    }
  }
  return [...agg.values()];
}

/** Funder of a Base payer: the latest USDC sender in the FUNDER_LOOKBACK blocks before its first indexed payment (null if none). */
export async function baseFunder(f: Fetch, urls: string[], payer: string, firstBlock: number, t: number): Promise<FunderRow> {
  const from = Math.max(0, firstBlock - FUNDER_LOOKBACK), to = Math.max(0, firstBlock - 1);
  const logs = await getLogs(f, urls, from, to, [TRANSFER_TOPIC, null, pad(payer)]);
  const senders = logs.map((l) => ({ b: parseInt(l.blockNumber, 16), from: "0x" + String(l.topics?.[1]).slice(-40).toLowerCase() })).filter((x) => x.from !== payer && !/^0x0{40}$/.test(x.from)).sort((a, b) => b.b - a.b);
  return senders.length
    ? { network: BASE_NET, account: payer, funder: senders[0].from, checked_at: t, note: null }
    : { network: BASE_NET, account: payer, funder: null, checked_at: t, note: `no USDC received in the ${FUNDER_LOOKBACK} blocks before the first indexed payment` };
}

// ---------------------------------------------------------------- vet402 (third-party, CC BY 4.0)

export function vet402View(r: Vet402Row, free: boolean) {
  const d = iso(r.retrieved_at)!.slice(0, 10);
  return {
    source: VET402.source, license: VET402.license, license_url: VET402.license_url, link: VET402.link, methodology: VET402.methodology,
    cite: VET402.cite(d), retrieved_at: iso(r.retrieved_at),
    note: "Third-party test results, shown as published by vet402. Not Lumi's measurement and not counted in Lumi's purchase-verified numbers.",
    l0: r.l0_verdict ? { verdict: r.l0_verdict, probed_at: iso(r.l0_probed_at), listed: r.listed == null ? null : !!r.listed } : null,
    l1: r.l1_attempts ? {
      purchase_attempts: r.l1_attempts, settled: r.l1_settled, settled_with_2xx: r.l1_delivered, last_at: iso(r.l1_last_at), last_status: r.l1_last_status,
      ...(free ? {} : { last_http_status: r.l1_last_http, last_tx_hash: r.l1_last_tx, ...(r.l1_last_tx && /^0x[0-9a-f]{64}$/i.test(r.l1_last_tx) ? { explorer: `https://basescan.org/tx/${r.l1_last_tx}` } : {}) }),
    } : null,
  };
}

/** Base64-free sanity for owner-posted vet402 rows. */
export function parseVet402(b: any, t: number): Vet402Row[] | string {
  if (!Array.isArray(b?.rows) || b.rows.length > 500) return "rows: array of at most 500";
  const ra = Date.parse(String(b.retrieved_at ?? ""));
  if (!Number.isFinite(ra) || ra > t + 86_400_000) return "retrieved_at: ISO date";
  const num = (x: unknown) => (x == null || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null);
  const ts = (x: unknown) => (typeof x === "string" && Number.isFinite(Date.parse(x)) ? Date.parse(x) : null);
  const str = (x: unknown, n = 80) => (typeof x === "string" && x ? x.slice(0, n) : null);
  const out: Vet402Row[] = [];
  for (const r of b.rows) {
    if (typeof r?.k !== "string" || r.k.length > 500 || /^https?:/i.test(r.k)) return "rows[].k: resource_key (host/path, no scheme)";
    out.push({
      resource_key: r.k, network: str(r.network), l0_verdict: str(r.l0_verdict, 20), l0_probed_at: ts(r.l0_probed_at), listed: r.listed == null ? null : r.listed ? 1 : 0,
      l1_attempts: num(r.l1_attempts) ?? 0, l1_settled: num(r.l1_settled) ?? 0, l1_delivered: num(r.l1_delivered) ?? 0, l1_last_at: ts(r.l1_last_at),
      l1_last_status: str(r.l1_last_status, 40), l1_last_http: num(r.l1_last_http), l1_last_tx: str(r.l1_last_tx, 100), retrieved_at: ra,
    });
  }
  return out;
}
