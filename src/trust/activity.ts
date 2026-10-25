/**
 * "Observed on-chain payments (unverified)" per seller (legal review 2026-10-25, M6/M7/M8): payments to a seller's listed
 * payTo addresses seen on the public ledger in the last 30 days, excluding Lumi, known test and catalog-sweeping wallets and
 * wallets funded by the seller, grouped by funding source (all done upstream, before rows reach this module).
 * Information only: never an input to a label, score, tier, ranking or badge, and nothing a seller can buy.
 *
 * Privacy: payer wallet addresses are never accepted or stored. Public views show ranges (ACTIVITY_BANDS), recency in weeks
 * and a concentration flag, and nothing at all below ACTIVITY_MIN_GROUPS independent payer groups. The dollar total and the
 * top payer's exact share are owner-only (activityOwnerView).
 */
import type { D1Like } from "../config";
import type { VerdictThresholds } from "./verdict";

export interface ActivityRow {
  seller: string;
  domains: string[];
  pay_to: string[];
  payers_30d: number | null;
  payments_30d: number | null;
  total_usd_30d: number | null;
  top_payer_share: number | null;
  /** PRIVATE: 0..1 share of paying volume from wallets funded by the seller itself or from the seller's own promo/prize credits
   *  recycling into its calls (upstream funding-source grouping). Public views show only the `self_funded_loop` flag. */
  self_funded_share: number | null;
  last_payment_at: number | null;
  window_end: number;
  source: string | null;
  fp: string;
  kfp: string;
  updated_at: number;
}

export interface ActivityStore {
  /** Rows reachable from any of the lookup keys ("d:<domain>" / "p:<payTo>"), each with the key that matched. */
  find(keys: string[]): Promise<Array<ActivityRow & { k: string }>>;
  fingerprints(sellers: string[]): Promise<Map<string, { fp: string; kfp: string }>>;
  /** rows: full upserts; rekey: sellers whose key set changed (old keys deleted, new keys inserted). */
  write(rows: ActivityRow[], rekey: ActivityRow[]): Promise<void>;
  get(seller: string): Promise<ActivityRow | null>;
  count(): Promise<number>;
}

export const ACTIVITY_MAX_ROWS_PER_INGEST = 2000;
export const ACTIVITY_NAME = "Observed on-chain payments (unverified)";
/** §6.4 definition text, verbatim from the legal review. */
export const ACTIVITY_DEFINITION =
  "Payments to this seller's listed pay-to address seen on the public ledger in the last 30 days, excluding Lumi, known test and catalog-sweeping wallets, and wallets funded by the seller. Grouped by funding source. Lumi can't confirm who the payers are or that they are separate customers. Shown in ranges. Not part of the score.";
export const ACTIVITY_TOO_FEW = "too few payers to show";
/** Ranges, never exact counts (M7). [min, max, label]. */
export const ACTIVITY_BANDS: [number, number, string][] = [[0, 0, "0"], [1, 9, "1–9"], [10, 99, "10–99"], [100, 999, "100–999"], [1000, 9999, "1k–10k"], [10000, Infinity, "10k+"]];
export const activityBand = (n: number | null) => (n == null ? null : ACTIVITY_BANDS.find(([lo, hi]) => n >= lo && n <= hi)?.[2] ?? null);
/** Recency in weeks, never a timestamp. */
export function weeksAgo(lastMs: number | null, now: number): string | null {
  if (lastMs == null) return null;
  const w = Math.floor(Math.max(0, now - lastMs) / (7 * 86_400_000));
  return w === 0 ? "within the last week" : w >= 5 ? "more than 4 weeks ago" : `${w}–${w + 1} weeks ago`;
}
export type ActivityFlag = "self_funded_loop";
export const SELF_FUNDED_NOTE = "Much of this seller's paying volume comes from wallets the seller funded or from its own promotional credits or prizes, so these payments do not show independent demand.";
export type ActivityPublic =
  | { name: string; definition: string; shown: false; note: string; as_of: string; flags?: ActivityFlag[]; flag_note?: string }
  | { name: string; definition: string; shown: true; payer_groups_30d: string | null; payments_30d: string | null; last_payment: string | null; concentrated: boolean | null; as_of: string; stale?: true; flags: ActivityFlag[]; flag_note?: string };
/** Flags only (never the share itself): self_funded_loop when the self-funded share reaches th.selfFundedPct. */
export function activityFlags(r: Pick<ActivityRow, "self_funded_share">, th: Pick<VerdictThresholds, "selfFundedPct">): ActivityFlag[] {
  return r.self_funded_share != null && r.self_funded_share * 100 >= th.selfFundedPct ? ["self_funded_loop"] : [];
}
/** Qualified wording for the check's organic_payers reason when the seller is flagged self_funded_loop (owner decision 2026-10-25). */
export const ORGANIC_QUALIFIED_NOTE = "Lumi's funding-source analysis flags this seller as self_funded_loop: much of its paying volume comes from wallets the seller funded or from its own promotional credits or prizes, so this payer count may not show independent demand.";
/**
 * Check reasons with organic_payers qualified when the seller's activity row carries the self_funded_loop flag: each
 * organic_payers reason becomes organic_payers_qualified (detail extended) and one self_funded_loop info reason is added.
 * Severity stays "info", so the decision and label are unchanged. Reasons are returned untouched when there is no flag.
 */
export function qualifyOrganicPayers<R extends { code: string; severity: string; detail?: string }>(reasons: R[], flags: ActivityFlag[]): R[] {
  if (!flags.includes("self_funded_loop") || !reasons.some((r) => r.code === "organic_payers")) return reasons;
  const out = reasons.map((r) => (r.code === "organic_payers" ? { ...r, code: "organic_payers_qualified", detail: `${r.detail ?? ""} ${ORGANIC_QUALIFIED_NOTE}`.trim() } : r));
  if (!out.some((r) => r.code === "self_funded_loop")) out.push({ code: "self_funded_loop", severity: "info", detail: SELF_FUNDED_NOTE } as R);
  return out;
}
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const PAYTO_RE = /^(?:0x[0-9a-f]{40}|r[1-9a-hj-np-z]{24,34}|g[a-z2-7]{55}|[1-9a-hj-np-z]{32,44})$/;

export const domainKey = (d: string) => d.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
/** "eip155:8453:0xAbC" -> "0xabc" (CAIP prefix dropped; lowercased like every payTo match in Lumi). */
export const payToKey = (p: string) => { const s = p.trim(); const i = s.lastIndexOf(":"); return (i >= 0 ? s.slice(i + 1) : s).toLowerCase(); };

/** FNV-1a 32-bit, twice with different seeds: a cheap change detector (not security-relevant). */
function fp(s: string) {
  const h = (seed: number) => { let x = seed >>> 0; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; } return x.toString(16).padStart(8, "0"); };
  return h(2166136261) + h(0x811c9dc5 ^ 0x5bd1e995);
}

export interface IngestResult { received: number; valid: number; rejected: { index: number; error: string }[]; written: number; unchanged: number; rekeyed: number; key_collisions: number }

/** Validate one ingest row. Unknown fields are ignored (so a payer address sent by mistake is never stored). */
export function parseActivityRow(x: any, now: number): ActivityRow | string {
  if (!x || typeof x !== "object") return "row must be an object";
  const seller = typeof x.seller === "string" ? x.seller.trim().slice(0, 200) : "";
  if (!seller) return "seller is required";
  const arr = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/) : []).map(String).filter(Boolean);
  const domains = [...new Set(arr(x.domains).map(domainKey))].filter((d) => HOST_RE.test(d)).slice(0, 20).sort();
  const pay_to = [...new Set(arr(x.pay_to).map(payToKey))].filter((p) => PAYTO_RE.test(p)).slice(0, 20).sort();
  if (!domains.length && !pay_to.length) return "at least one valid domain or pay_to is required";
  const int = (v: unknown) => (v == null || v === "" ? null : Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 1e9 ? Number(v) : NaN);
  const real = (v: unknown, max: number) => (v == null || v === "" ? null : Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= max ? Number(v) : NaN);
  const ts = (v: unknown) => (v == null || v === "" ? null : typeof v === "number" ? v : Date.parse(String(v)));
  const payers = int(x.payer_groups_30d ?? x.payers_30d), payments = int(x.payments_30d), total = real(x.total_usd_30d, 1e9), share = real(x.top_payer_share, 1);
  const last = ts(x.last_payment_at), end = ts(x.window_end);
  // Self-funded share: given directly, as seller-funded wallet share + own promo/prize credit share, or as 1 - outside share.
  const sfw = real(x.seller_funded_share, 1), scr = real(x.seller_credit_share, 1), outside = real(x.outside_share, 1);
  const selfShare = x.self_funded_share != null && x.self_funded_share !== "" ? real(x.self_funded_share, 1)
    : sfw != null || scr != null ? (Number.isNaN(sfw) || Number.isNaN(scr) ? NaN : Math.min(1, (sfw ?? 0) + (scr ?? 0)))
    : outside == null ? null : Number.isNaN(outside) ? NaN : 1 - outside;
  for (const [k, v] of Object.entries({ payers_30d: payers, payments_30d: payments, total_usd_30d: total, top_payer_share: share, self_funded_share: selfShare, last_payment_at: last })) if (Number.isNaN(v)) return `${k} is invalid`;
  if (end == null || !Number.isFinite(end)) return "window_end is required (ISO date or ms)";
  if (end > now + 2 * 86_400_000) return "window_end is in the future";
  if (last != null && last > end + 86_400_000) return "last_payment_at is after window_end";
  const source = typeof x.source === "string" ? x.source.slice(0, 200) : null;
  const row = { seller, domains, pay_to, payers_30d: payers, payments_30d: payments, total_usd_30d: total, top_payer_share: share, self_funded_share: selfShare, last_payment_at: last, window_end: end, source };
  return { ...row, fp: fp(JSON.stringify(row)), kfp: fp(JSON.stringify([domains, pay_to])), updated_at: now };
}

export const keysOf = (r: Pick<ActivityRow, "domains" | "pay_to">) => [...r.domains.map((d) => "d:" + d), ...r.pay_to.map((p) => "p:" + p)];

/** Lookup keys for a host and the payTos Lumi has on record for it: host, its parent (3+ labels), payTos. */
export function lookupKeys(host: string | null, payTos: string[]) {
  const ks: string[] = payTos.map((p) => "p:" + payToKey(p));
  if (host) {
    const h = domainKey(host);
    ks.push("d:" + h);
    const parts = h.split(".");
    if (parts.length >= 3) ks.push("d:" + parts.slice(1).join("."));
  }
  return [...new Set(ks)].slice(0, 12);
}

export function activityPublic(r: ActivityRow | null, now: number, th: VerdictThresholds): ActivityPublic | null {
  if (!r) return null;
  const as_of = new Date(r.window_end).toISOString().slice(0, 10);
  const base = { name: ACTIVITY_NAME, definition: ACTIVITY_DEFINITION };
  // Self-funded loop: a flag only (never the share). Shown even below the payer-group minimum, since it is about the
  // seller's own wallets and credits, not about outside payers.
  const flags = activityFlags(r, th);
  const fl = flags.length ? { flags, flag_note: SELF_FUNDED_NOTE } : {};
  // M8: nothing (counts, concentration, recency) below the minimum number of independent payer groups.
  if (r.payers_30d == null || r.payers_30d < Math.max(5, th.activityMinPayerGroups)) return { ...base, shown: false, note: ACTIVITY_TOO_FEW, as_of, ...fl };
  const stale = now - r.window_end > th.activityMaxAgeDays * 86_400_000;
  return {
    ...base,
    shown: true,
    payer_groups_30d: activityBand(r.payers_30d),
    payments_30d: activityBand(r.payments_30d),
    last_payment: weeksAgo(r.last_payment_at, now),
    // A self-funded loop is never reported as not concentrated.
    concentrated: flags.length ? true : r.top_payer_share == null ? null : r.top_payer_share * 100 >= th.concentrationPct,
    as_of,
    flags,
    ...(flags.length ? { flag_note: SELF_FUNDED_NOTE } : {}),
    ...(stale ? { stale: true as const } : {}),
  };
}

export function activityOwnerView(r: ActivityRow, now: number, th: VerdictThresholds) {
  return { public: activityPublic(r, now, th), payer_groups_30d: r.payers_30d, payments_30d: r.payments_30d, last_payment_at: r.last_payment_at == null ? null : new Date(r.last_payment_at).toISOString(), seller: r.seller, domains: r.domains, pay_to: r.pay_to, total_usd_30d: r.total_usd_30d, top_payer_share: r.top_payer_share, self_funded_share: r.self_funded_share, source: r.source, updated_at: new Date(r.updated_at).toISOString() };
}

/** Service: cached lookups (5 min per isolate) + change-only batched ingest. */
export function createActivity(store: ActivityStore, now: () => number, self: { domains: string[]; pay_to: string[] } = { domains: [], pay_to: [] }) {
  const selfPay = new Set(self.pay_to.map(payToKey));
  const selfDom = self.domains.map(domainKey);
  const isSelf = (r: ActivityRow) => r.pay_to.some((p) => selfPay.has(p)) || r.domains.some((d) => selfDom.some((s) => d === s || d.endsWith("." + s)));
  const memo = new Map<string, { at: number; row: ActivityRow | null }>();
  const TTL = 5 * 60_000;
  async function lookup(host: string | null, payTos: string[]): Promise<ActivityRow | null> {
    const keys = lookupKeys(host, payTos);
    if (!keys.length) return null;
    const mk = keys.join("|");
    const t = now();
    const hit = memo.get(mk);
    if (hit && t - hit.at < TTL) return hit.row;
    let row: ActivityRow | null = null;
    try {
      const rows = await store.find(keys);
      // Priority: a payTo match, then the exact host, then the parent domain.
      row = keys.map((k) => rows.find((r) => r.k === k)).find(Boolean) ?? null;
      if (row) { const { k: _k, ...rest } = row as ActivityRow & { k: string }; row = rest; }
    } catch { row = null; } // table missing (migration not applied) or D1 hiccup: activity is optional
    if (memo.size > 2000) memo.clear();
    memo.set(mk, { at: t, row });
    return row;
  }
  async function ingest(body: any): Promise<IngestResult | { error: string }> {
    const list = Array.isArray(body?.rows) ? body.rows : null;
    if (!list) return { error: "rows[] is required" };
    if (list.length > ACTIVITY_MAX_ROWS_PER_INGEST) return { error: `at most ${ACTIVITY_MAX_ROWS_PER_INGEST} rows per request` };
    const t = now();
    const rejected: IngestResult["rejected"] = [];
    const bySeller = new Map<string, ActivityRow>();
    list.forEach((x: any, i: number) => { const r = parseActivityRow({ source: body?.source, ...x }, t); if (typeof r === "string") rejected.push({ index: i, error: r }); else if (isSelf(r)) rejected.push({ index: i, error: "lumi_self_excluded" }); else bySeller.set(r.seller, r); });
    const rows = [...bySeller.values()];
    const prior = await store.fingerprints(rows.map((r) => r.seller));
    const changed = rows.filter((r) => prior.get(r.seller)?.fp !== r.fp);
    const rekey = changed.filter((r) => prior.get(r.seller)?.kfp !== r.kfp);
    const owner = new Map<string, string>();
    let collisions = 0;
    for (const r of rows) for (const k of keysOf(r)) { if (owner.has(k) && owner.get(k) !== r.seller) collisions++; owner.set(k, r.seller); }
    if (changed.length) await store.write(changed, rekey);
    if (changed.length) memo.clear();
    return { received: list.length, valid: rows.length, rejected: rejected.slice(0, 50), written: changed.length, unchanged: rows.length - changed.length, rekeyed: rekey.length, key_collisions: collisions };
  }
  return { lookup, ingest, store };
}
export type Activity = ReturnType<typeof createActivity>;

export class MemoryActivityStore implements ActivityStore {
  rows = new Map<string, ActivityRow>();
  keys = new Map<string, string>();
  writes = 0;
  async find(keys: string[]) {
    return keys.flatMap((k) => { const s = this.keys.get(k); const r = s ? this.rows.get(s) : undefined; return r ? [{ ...r, k }] : []; });
  }
  async fingerprints(sellers: string[]) {
    return new Map(sellers.flatMap((s) => { const r = this.rows.get(s); return r ? [[s, { fp: r.fp, kfp: r.kfp }] as const] : []; }));
  }
  async write(rows: ActivityRow[], rekey: ActivityRow[]) {
    for (const r of rekey) { for (const [k, s] of [...this.keys]) if (s === r.seller) this.keys.delete(k); for (const k of keysOf(r)) this.keys.set(k, r.seller); }
    for (const r of rows) { this.rows.set(r.seller, { ...r }); this.writes++; }
  }
  async get(seller: string) { return this.rows.get(seller) ?? null; }
  async count() { return this.rows.size; }
}

const fromDb = (r: any): ActivityRow => ({
  seller: r.seller, domains: String(r.domains ?? "").split(" ").filter(Boolean), pay_to: String(r.pay_to ?? "").split(" ").filter(Boolean),
  payers_30d: r.payers_30d ?? null, payments_30d: r.payments_30d ?? null, total_usd_30d: r.total_usd_30d ?? null, top_payer_share: r.top_payer_share ?? null, self_funded_share: r.self_funded_share ?? null,
  last_payment_at: r.last_payment_at ?? null, window_end: Number(r.window_end), source: r.source ?? null, fp: r.fp, kfp: r.kfp, updated_at: Number(r.updated_at),
});

/** D1: one indexed read per verdict lookup; ingest = chunked fingerprint reads + one batch per 100 statements. */
export class D1ActivityStore implements ActivityStore {
  constructor(private db: D1Like) {}
  async find(keys: string[]) {
    if (!keys.length) return [];
    const q = `SELECT k.k AS k, a.* FROM seller_activity_keys k JOIN seller_activity a ON a.seller = k.seller WHERE k.k IN (${keys.map((_, i) => "?" + (i + 1)).join(",")})`;
    const rs = (await this.db.prepare(q).bind(...keys).all<any>()).results ?? [];
    return rs.map((r: any) => ({ ...fromDb(r), k: r.k }));
  }
  async fingerprints(sellers: string[]) {
    const out = new Map<string, { fp: string; kfp: string }>();
    for (let i = 0; i < sellers.length; i += 90) {
      const part = sellers.slice(i, i + 90);
      const rs = (await this.db.prepare(`SELECT seller, fp, kfp FROM seller_activity WHERE seller IN (${part.map((_, j) => "?" + (j + 1)).join(",")})`).bind(...part).all<any>()).results ?? [];
      for (const r of rs) out.set(r.seller, { fp: r.fp, kfp: r.kfp });
    }
    return out;
  }
  async write(rows: ActivityRow[], rekey: ActivityRow[]) {
    const up = "INSERT INTO seller_activity (seller, domains, pay_to, payers_30d, payments_30d, total_usd_30d, top_payer_share, self_funded_share, last_payment_at, window_end, source, fp, kfp, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14) ON CONFLICT (seller) DO UPDATE SET domains = excluded.domains, pay_to = excluded.pay_to, " +
      "payers_30d = excluded.payers_30d, payments_30d = excluded.payments_30d, total_usd_30d = excluded.total_usd_30d, top_payer_share = excluded.top_payer_share, self_funded_share = excluded.self_funded_share, " +
      "last_payment_at = excluded.last_payment_at, window_end = excluded.window_end, source = excluded.source, fp = excluded.fp, kfp = excluded.kfp, updated_at = excluded.updated_at";
    const stmts = [
      ...rows.map((r) => this.db.prepare(up).bind(r.seller, r.domains.join(" "), r.pay_to.join(" "), r.payers_30d, r.payments_30d, r.total_usd_30d, r.top_payer_share, r.self_funded_share, r.last_payment_at, r.window_end, r.source, r.fp, r.kfp, r.updated_at)),
      ...rekey.flatMap((r) => [
        this.db.prepare("DELETE FROM seller_activity_keys WHERE seller = ?1").bind(r.seller),
        ...keysOf(r).map((k) => this.db.prepare("INSERT INTO seller_activity_keys (k, seller) VALUES (?1, ?2) ON CONFLICT (k) DO UPDATE SET seller = excluded.seller").bind(k, r.seller)),
      ]),
    ];
    for (let i = 0; i < stmts.length; i += 100) await this.db.batch(stmts.slice(i, i + 100));
  }
  async get(seller: string) { const r = await this.db.prepare("SELECT * FROM seller_activity WHERE seller = ?1").bind(seller).first<any>(); return r ? fromDb(r) : null; }
  async count() { return Number((await this.db.prepare("SELECT COUNT(*) n FROM seller_activity").first<{ n: number }>())?.n ?? 0); }
}
