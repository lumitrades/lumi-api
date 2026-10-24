/**
 * Lumi Check v0, server side: contributor keys, contributed receipts, caps and credits.
 * DRAFT on branch scanner-kit-v0. Not deployed.
 *
 * The open kit (packages/scanner-kit) only checks quotes, optionally makes capped test-buys, signs receipts with the
 * contributor's own wallet and submits them here. Everything that decides what counts (which sellers to test,
 * verification, anti-fraud, anti-boost, weighting, credits) lives in this file and never ships in the kit.
 *
 * Routes
 *   Contributor (ed25519 request signature, see signedMessage):
 *     POST /v1/contrib/submissions   one signed receipt (passive purchase or test-buy)
 *     GET  /v1/contrib/wanted        what to test next (server-chosen, per key rotation)
 *     GET  /v1/contrib/me            own credits, caps left and own recent submissions
 *     POST /v1/contrib/me            { share_demand: boolean } (opt-in to aggregate-only demand stats)
 *     DELETE /v1/contrib/me          { confirm: "<own key_id>" } delete the account (see eraseAccount)
 *     POST /v1/contrib/me/wallet-proof { address, key_type, public_key?, signature } prove control of a registered wallet
 *   Seller (signed with the payTo wallet):
 *     POST /v1/contrib/disputes      { tx_hash, reason, signer } holds a contributed finding for review
 *   Owner (Authorization: Bearer <OWNER_MCP_KEY>, same check as the other owner routes):
 *     POST /v1/owner/contributors                     issue a key
 *     GET  /v1/owner/contributors                     list keys with credit totals
 *     POST /v1/owner/contributors/{key_id}/revoke     revoke now ({ reason, forfeit })
 *     GET  /v1/owner/contributors/{key_id}/submissions
 *     GET  /v1/owner/contributors/flags               endpoints dominated by few funding sources / new wallets
 *     GET  /v1/owner/contributors/demand              opt-in demand, aggregate only (>= 2 contributors per row)
 *     POST /v1/owner/contributors/findings/{tx}       { action: "confirm" | "contradict" | "clear_dispute" | "uphold_dispute" }
 *     POST /v1/owner/contributors/findings/{tx}       { action: "mark_published" } receipt cited in a published, dated test result
 *     POST /v1/owner/contributors/delete              { key_id | wallet, confirm: true, request_ref? } delete on an email request
 *     POST /v1/owner/contributors/reconcile           confirm unconfirmed negatives against Lumi's own re-buys
 *     GET  /v1/owner/contributors/clusters            funding sources shared by more than one key
 *
 * Anti-gaming (docs/contributors-antigaming.md): wallet-control proof at issue (walletProofMessage), cached first-funder
 * tracing (XRPL / Stellar / Base) with one-hop clusters, weight 0 for unproven / seller-funded / same-cluster receipts,
 * near-duplicate refusal (payer + pay_to + amount within near_dup_window_s).
 *
 * D1: one row (+3 index entries) per accepted submission on its OWN daily counter `contrib_writes:<day>`
 * (CONTRIB_CAPS.write_budget_rows), separate from the catalog `writes:<day>` counter, so contributions never starve
 * ingest. With CONTRIB_QUEUE bound, inserts go through the lumi-contrib-writes queue and are flushed in one batch.
 * Rejected submissions write nothing. Credits are derived from the submission rows; there is no payout code.
 */
import { originPath } from "./check";
import { ed25519 } from "@noble/curves/ed25519";
import type { D1Like } from "../config";
import { json } from "../x402";
import { isOwnerKey } from "../mcp";
import { VENDORS } from "../vendors";
import { verifyReceipt, canonicalJson, type Receipt, type ReceiptStore } from "./receipts";
import {
  lookupXrplPayment, lookupBaseUsdc, lookupStellarUsdc, rpc, sha256Hex, verifyXrplSignature, xrplAddressOf, recoverEvmSigner,
  verifyStellarSignature, XRPL_ADDR_RE, EVM_ADDR_RE, STELLAR_ADDR_RE, STELLAR_HORIZON, type Lookup,
} from "./verify";
import { normalizeUrl, urlVariants, type CatalogRow, type CatalogStore } from "./catalog";

// ---------------------------------------------------------------- versions and configurable rules

export const CONTRIB_FORMAT = "lumi-contrib/0.1";
export const ACCEPTED_FORMATS = [CONTRIB_FORMAT];
export const KIT_NAME = "lumi-scanner-kit";
export const DEFAULT_MIN_KIT = "0.1.0";

/** Credits (DRAFT amounts for the owner to set). Credits only: never cash, no payout code. 1 USD = 1_000_000 uusd. */
export const DEFAULT_CREDITS = {
  base_uusd: 20_000, // $0.02 of API credits per verified receipt
  wanted_mult: 2, // endpoint is on the current wanted list
  chain_mult: { "xrpl:0": 1.5, "stellar:pubnet": 1.5, "eip155:8453": 1 } as Record<string, number>, // under-tested chains weigh more
  passive_mult: 1,
  test_buy_mult: 1,
  repeat_mult: 0.25, // same key + endpoint again inside repeat_window_days
  repeat_window_days: 30,
  unlisted_mult: 0, // endpoint unknown to Lumi, or pay_to not the listed one: stored, no credit
  monthly_cap_uusd: 5_000_000, // pilot: $5 of credits per contributor per calendar month (UTC)
};
export const DEFAULT_CAPS = {
  key_daily: 20, // accepted submissions per key per UTC day (key.daily_cap overrides)
  key_endpoint_daily: 1, // same key, same endpoint, same day
  endpoint_daily_sources: 3, // distinct FUNDING SOURCES per endpoint per day (not distinct wallets)
  source_endpoint_daily: 1, // one counted receipt per funding source per endpoint per day
  tx_max_age_days: 7,
  observed_skew_min: 60, // |delivery.observed_at - ledger time| allowed
  write_budget_rows: 5_000, // contributions-only D1 rows per UTC day
  per_minute: 10, // per-key request limit: Workers Rate Limiting binding when bound (CONTRIB_RATE_LIMITER), else in-isolate
  near_dup_window_s: 120, // same payer + seller + amount with ledger times this close = one purchase, whatever the tx hashes
  funding_recheck_days: 7, // cached "no funder found" lookups are retried after this; found funders are kept
  new_wallet_days: 30,
  flag_min_receipts: 4, // anti-boost flag needs at least this many receipts on the endpoint in 7 days
  flag_max_sources: 2, // ... from at most this many funding sources, or
  flag_new_wallet_share: 0.6, // ... this share from wallets funded < new_wallet_days ago
  demand_min_contributors: 2, // aggregate rows need at least this many distinct contributors
};
export type Credits = typeof DEFAULT_CREDITS;
export type Caps = typeof DEFAULT_CAPS;

const POSITIVE = "delivered";
/** A contributed "no delivery" style finding. "inconclusive" (no HTTP response seen) is never a negative. */
export const isNegative = (o: string | null | undefined) => !!o && o !== POSITIVE && o !== "inconclusive";
const DAY_MS = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
const dayOf = (t: number) => iso(t).slice(0, 10);
const monthStart = (t: number) => iso(t).slice(0, 7) + "-01";
export const contribBudgetKey = (t: number) => "contrib_writes:" + dayOf(t);
/** D1 rows written per accepted submission: the row + its secondary index entries (approximate, for the budget). */
export const ROWS_PER_SUBMISSION = 4;

export function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0), pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------- types

export interface ContributorKey {
  key_id: string; label: string; public_key: string; wallets: string[]; own_domains: string[];
  daily_cap: number | null; share_demand: boolean; status: "active" | "revoked" | "deleted"; forfeited: boolean;
  created_at: number; revoked_at: number | null; revoke_reason: string | null;
  /** UTC day of the last accepted receipt or signed check (updated at most once per key per day). Accounts are kept while active. */
  last_active_day?: string | null;
}
export interface WalletRow {
  address: string; key_id: string; funder: string | null; funded_at: number | null; source: string;
  /** A wallet-control signature was verified at registration (or later via /v1/contrib/me/wallet-proof). Unproven wallets earn zero weight. */
  proven?: boolean;
}
/** Cached first-funder lookup (migration 0022 `wallet_funding`): found funders are kept, misses retried after funding_recheck_days. */
export interface FundingRow { address: string; funder: string | null; funded_at: number | null; checked_at: number }
/** Message a wallet signs to prove control at registration, bound to the contributor's ed25519 key. */
export const walletProofMessage = (contributorPublicKeyHex: string, address: string) => `lumi-wallet-proof:v1:${contributorPublicKeyHex.toLowerCase()}:${address}`;
export interface WalletProof { key_type?: string; public_key?: string; signature?: string }
/** Verify a wallet-control proof with the same verifiers as seller disputes. */
export function verifyWalletProof(contributorPublicKeyHex: string, address: string, pr: WalletProof | null | undefined): boolean {
  if (!pr || typeof pr !== "object") return false;
  const msg = walletProofMessage(contributorPublicKeyHex, address), sig = String(pr.signature ?? "");
  try {
    if (XRPL_ADDR_RE.test(address)) return pr.key_type === "ripple-keypairs" && verifyXrplSignature(msg, sig, String(pr.public_key ?? "")) && xrplAddressOf(String(pr.public_key ?? "")) === address;
    if (EVM_ADDR_RE.test(address)) return pr.key_type === "eip191" && recoverEvmSigner(msg, sig) === address.toLowerCase();
    if (STELLAR_ADDR_RE.test(address)) return pr.key_type === "stellar-ed25519" && verifyStellarSignature(msg, sig, address);
  } catch { /* invalid */ }
  return false;
}
export interface Submission {
  tx_hash: string; key_id: string; day: string; created_at: number; mode: "passive" | "test_buy"; kit_version: string | null;
  endpoint: string; endpoint_key: string; domain: string | null; network: string; asset: string; amount: string;
  pay_to: string; payer: string; source: string; new_wallet: boolean; receipt_hash: string; http_status: number | null;
  outcome: string | null; finding: Finding; wanted: boolean; demand_opt_in: boolean; ledger_ts: number | null;
  credit_uusd: number; credit_note: string | null; dispute: string | null; metrics: string | null; receipt: string;
  /** Set by the owner when the receipt is cited in a published, dated test result (migration 0021). */
  published_at?: number | null;
  /**
   * Scoring weight (migration 0022): 1 = counts; 0 = stored for evidence but no leaderboard, credits or confirmations.
   * weight_note says why: wallet_unproven, seller_funded (payer funded by the seller's pay_to or its cluster), same_cluster
   * (another key in the same funding cluster already counted this seller today).
   */
  weight?: number; weight_note?: string | null;
}
/** Zero-weight reasons. */
export type WeightNote = "wallet_unproven" | "seller_funded" | "same_cluster";
/** True when a submission counts for scores and credits. */
export const weighs = (s: { finding: Finding; dispute: string | null; weight?: number | null }) => (s.finding === "counted" || s.finding === "confirmed") && !s.dispute && s.weight !== 0;
export interface EraseResult { found: boolean; submissions_deleted: number; submissions_anonymised: number; credit_spends_deleted: number; wallets_deleted: number }
/** Placeholder key id left on anonymised submissions and in the key tombstone's place: no link to the deleted contributor. */
export const DELETED_CONTRIBUTOR = "deleted";
/**
 * Anonymised copy of a stored receipt kept for a published, dated test result after account deletion: the wallet
 * signature, payer, kit details and anything else tying it to the contributor are removed. The tx hash stays (it is
 * public on the ledger and is what the published result cites).
 */
export function anonymisedReceipt(raw: string, at: number): string {
  let r: any; try { r = JSON.parse(raw); } catch { r = {}; }
  const { signer: _s, x_lumi_contrib: x, x_lumi_stored: _st, ...rest } = r ?? {};
  const payment = rest.payment ? (({ payer: _p, ...p }) => p)(rest.payment) : undefined;
  return JSON.stringify({
    ...rest, ...(payment ? { payment } : {}), issuer: { name: "Lumi Check contributor (deleted)" },
    ...(x?.measurements ? { x_lumi_contrib: { measurements: x.measurements } } : {}),
    x_lumi_stored: { anonymised_at: new Date(at).toISOString(), removed: ["signer", "payment.payer", "x_lumi_contrib.kit", "x_lumi_contrib.mode", "issuer.methodology"], note: "Contributor account deleted; kept only because a published, dated test result cites it." },
  }).slice(0, 12_000);
}
/** One redemption of free Lumi Check credits (the earn side is derived from verified submissions, so disputes reverse it). */
export interface CreditSpend { id: string; key_id: string; ts: number; day: string; product: string; cost: number; ref: string | null; alloc?: CreditAlloc[] | null }
/** Which earned lot (seller:day) a spend consumed, oldest first, so expiry is exact: unused credits expire 90 days after they were earned. */
export interface CreditAlloc { lot: string; n: number }
export type Finding = "counted" | "unconfirmed" | "confirmed" | "held" | "disputed" | "contradicted";
export interface CapCounts { key_day: number; key_ep_day: number; ep_day_sources: number; source_ep_day: number; key_ep_recent: number; month_credit: number; dup: number }
export type WriteOp =
  | { op: "insert"; row: Submission }
  | { op: "finding"; tx_hash: string; finding: Finding; dispute?: string | null }
  | { op: "touch"; key_id: string; day: string };

export interface ContributorStore {
  getKey(id: string): Promise<ContributorKey | null>;
  listKeys(): Promise<ContributorKey[]>;
  wallets(addresses: string[]): Promise<WalletRow[]>;
  issue(k: ContributorKey, wallets: WalletRow[]): Promise<void>;
  revoke(id: string, at: number, reason: string, forfeit: boolean): Promise<boolean>;
  /** Account deletion (contributor or owner request): see eraseAccount(). */
  erase(id: string, at: number, reason: string): Promise<EraseResult>;
  /** Owner: mark a submission as used in a published, dated test result (kept, anonymised, if the account is deleted). */
  markPublished(tx: string, at: number): Promise<boolean>;
  setShareDemand(id: string, v: boolean): Promise<void>;
  /** Record activity (no-op if already recorded for that day or later). */
  touch(id: string, day: string): Promise<void>;
  counts(q: { key_id: string; endpoint_key: string; source: string; day: string; since_recent: string; since_month: string; tx_hash: string }): Promise<CapCounts>;
  /** Near-duplicate purchase: this key, same payer + pay_to + amount, ledger time within windowMs (index: key_id, day). */
  nearDup(q: { key_id: string; since_day: string; payer: string; pay_to: string; amount: string; ledger_ts: number; window_ms: number }): Promise<number>;
  /** Weighted receipts for this seller (domain or pay_to) today from OTHER keys sharing the funding source (index: source, day). */
  clusterSeller(q: { source: string; day: string; domain: string | null; pay_to: string; key_id: string }): Promise<number>;
  /** Re-point wallets whose source was `from` (a wallet now known to be funded upstream) to `to`. */
  resource(from: string, to: string): Promise<void>;
  /** Mark a registered wallet as proven (wallet-control proof verified). */
  setProven(address: string, key_id: string): Promise<boolean>;
  getFunding(address: string): Promise<FundingRow | null>;
  putFunding(r: FundingRow): Promise<void>;
  /** Funding sources shared by wallets of more than one key (owner review). */
  clusters(): Promise<{ source: string; keys: string[]; wallets: string[] }[]>;
  /** Apply queued writes in ONE batch; returns D1 rows written (for the contributions budget). */
  apply(ops: WriteOp[], budgetKey: string): Promise<number>;
  byTx(tx: string): Promise<Submission | null>;
  recentByKey(key_id: string, limit: number): Promise<Submission[]>;
  endpointKeysSince(key_id: string, sinceDay: string): Promise<string[]>;
  /** Recent submissions on one endpoint (anti-boost flag and negative confirmation). */
  byEndpoint(endpoint_key: string, sinceDay: string): Promise<Submission[]>;
  totals(): Promise<{ key_id: string; n: number; credit_uusd: number; month_uusd: number }[]>;
  since(sinceDay: string, limit: number): Promise<Submission[]>;
  getMeta(k: string): Promise<string | null>;
  /** Retention: delete submissions (incl. the stored receipt copy) older than `beforeDay`. Returns rows deleted. */
  purge(beforeDay: string): Promise<number>;
  /** Earn side of the check-credit ledger: this key's submissions since a day (seller, day, finding only). */
  verifiedSince(key_id: string, sinceDay: string): Promise<Pick<Submission, "domain" | "pay_to" | "day" | "finding" | "dispute" | "weight">[]>;
  addSpend(row: CreditSpend): Promise<void>;
  deleteSpend(id: string): Promise<void>;
  spendsSince(key_id: string, sinceDay: string): Promise<CreditSpend[]>;
}

// ---------------------------------------------------------------- stores

const parseKey = (r: any): ContributorKey => ({
  key_id: r.key_id, label: r.label, public_key: r.public_key, wallets: safeArr(r.wallets), own_domains: safeArr(r.own_domains),
  daily_cap: r.daily_cap ?? null, share_demand: !!r.share_demand, status: r.status, forfeited: !!r.forfeited,
  created_at: Number(r.created_at), revoked_at: r.revoked_at ?? null, revoke_reason: r.revoke_reason ?? null, last_active_day: r.last_active_day ?? null,
});
const parseSub = (r: any): Submission => ({ ...r, new_wallet: !!r.new_wallet, wanted: !!r.wanted, demand_opt_in: !!r.demand_opt_in });
function safeArr(s: unknown): string[] { try { const a = JSON.parse(String(s ?? "[]")); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } }

export class MemoryContributorStore implements ContributorStore {
  keys = new Map<string, ContributorKey>();
  walletRows = new Map<string, WalletRow>();
  subs = new Map<string, Submission>();
  meta = new Map<string, string>();
  writes = 0;
  async getKey(id: string) { const k = this.keys.get(id); return k ? { ...k } : null; }
  async listKeys() { return [...this.keys.values()].map((k) => ({ ...k })); }
  async wallets(a: string[]) { return a.map((x) => this.walletRows.get(x)).filter((x): x is WalletRow => !!x); }
  async issue(k: ContributorKey, ws: WalletRow[]) { this.keys.set(k.key_id, { ...k }); for (const w of ws) this.walletRows.set(w.address, { ...w }); this.writes += 1 + ws.length; }
  async revoke(id: string, at: number, reason: string, forfeit: boolean) {
    const k = this.keys.get(id); if (!k) return false;
    Object.assign(k, { status: "revoked", revoked_at: at, revoke_reason: reason, forfeited: k.forfeited || forfeit }); this.writes++; return true;
  }
  async setShareDemand(id: string, v: boolean) { const k = this.keys.get(id); if (k) k.share_demand = v; this.writes++; }
  async touch(id: string, day: string) { const k = this.keys.get(id); if (k && k.status === "active" && (!k.last_active_day || k.last_active_day < day)) { k.last_active_day = day; this.writes++; } }
  async erase(id: string, at: number, reason: string): Promise<EraseResult> {
    const k = this.keys.get(id);
    const out: EraseResult = { found: !!k, submissions_deleted: 0, submissions_anonymised: 0, credit_spends_deleted: 0, wallets_deleted: 0 };
    if (!k) return out;
    for (const [tx, r] of this.subs) {
      if (r.key_id !== id) continue;
      if (r.published_at) { this.subs.set(tx, { ...r, ...ANON_FIELDS, receipt: anonymisedReceipt(r.receipt, at) }); out.submissions_anonymised++; }
      else { this.subs.delete(tx); out.submissions_deleted++; }
    }
    for (const [sid, sp] of this.spends) if (sp.key_id === id) { this.spends.delete(sid); out.credit_spends_deleted++; }
    for (const [a, w] of this.walletRows) if (w.key_id === id) { this.walletRows.delete(a); out.wallets_deleted++; }
    this.keys.set(id, tombstone(id, k, at, reason));
    this.writes += out.submissions_deleted + out.submissions_anonymised + out.credit_spends_deleted + out.wallets_deleted + 1;
    return out;
  }
  async markPublished(tx: string, at: number) { const r = this.subs.get(tx); if (!r) return false; r.published_at = r.published_at ?? at; this.writes++; return true; }
  async counts(q: Parameters<ContributorStore["counts"]>[0]): Promise<CapCounts> {
    const s = [...this.subs.values()];
    const epDay = s.filter((x) => x.endpoint_key === q.endpoint_key && x.day === q.day);
    return {
      key_day: s.filter((x) => x.key_id === q.key_id && x.day === q.day).length,
      key_ep_day: epDay.filter((x) => x.key_id === q.key_id).length,
      ep_day_sources: new Set(epDay.map((x) => x.source)).size,
      source_ep_day: epDay.filter((x) => x.source === q.source).length,
      key_ep_recent: s.filter((x) => x.key_id === q.key_id && x.endpoint_key === q.endpoint_key && x.day >= q.since_recent).length,
      month_credit: s.filter((x) => x.key_id === q.key_id && x.day >= q.since_month).reduce((a, x) => a + x.credit_uusd, 0),
      dup: this.subs.has(q.tx_hash) ? 1 : 0,
    };
  }
  async apply(ops: WriteOp[], budgetKey: string) {
    let rows = 0;
    for (const o of ops) {
      if (o.op === "insert") { if (!this.subs.has(o.row.tx_hash)) { this.subs.set(o.row.tx_hash, { ...o.row }); rows += ROWS_PER_SUBMISSION; } }
      else if (o.op === "touch") { const k = this.keys.get(o.key_id); if (k && k.status === "active" && (!k.last_active_day || k.last_active_day < o.day)) { k.last_active_day = o.day; rows++; } }
      else { const s = this.subs.get(o.tx_hash); if (s) { s.finding = o.finding; if (o.dispute !== undefined) s.dispute = o.dispute; rows++; } }
    }
    if (rows) { this.meta.set(budgetKey, String(Number(this.meta.get(budgetKey) ?? "0") + rows)); rows++; }
    this.writes += rows;
    return rows;
  }
  async byTx(tx: string) { const s = this.subs.get(tx); return s ? { ...s } : null; }
  async recentByKey(id: string, n: number) { return [...this.subs.values()].filter((s) => s.key_id === id).sort((a, b) => b.created_at - a.created_at).slice(0, n); }
  async endpointKeysSince(id: string, d: string) { return [...new Set([...this.subs.values()].filter((s) => s.key_id === id && s.day >= d).map((s) => s.endpoint_key))]; }
  async byEndpoint(ek: string, d: string) { return [...this.subs.values()].filter((s) => s.endpoint_key === ek && s.day >= d).map((s) => ({ ...s })); }
  async totals() {
    const m = new Map<string, { key_id: string; n: number; credit_uusd: number; month_uusd: number }>();
    const ms = monthStart(Date.now());
    for (const s of this.subs.values()) {
      const t = m.get(s.key_id) ?? { key_id: s.key_id, n: 0, credit_uusd: 0, month_uusd: 0 };
      t.n++; t.credit_uusd += s.credit_uusd; if (s.day >= ms) t.month_uusd += s.credit_uusd; m.set(s.key_id, t);
    }
    return [...m.values()];
  }
  async since(d: string, n: number) { return [...this.subs.values()].filter((s) => s.day >= d).slice(0, n); }
  async getMeta(k: string) { return this.meta.get(k) ?? null; }
  async purge(d: string) {
    let n = 0;
    for (const [k, s] of this.subs) if (s.day < d) { this.subs.delete(k); n++; }
    for (const [k, s] of this.spends) if (s.day < d) this.spends.delete(k);
    this.writes += n; return n;
  }
  spends = new Map<string, CreditSpend>();
  async verifiedSince(id: string, d: string) { return [...this.subs.values()].filter((s) => s.key_id === id && s.day >= d).map(({ domain, pay_to, day, finding, dispute, weight }) => ({ domain, pay_to, day, finding, dispute, weight })); }
  funding = new Map<string, FundingRow>();
  async nearDup(q: Parameters<ContributorStore["nearDup"]>[0]) {
    return [...this.subs.values()].filter((s) => s.key_id === q.key_id && s.day >= q.since_day && s.payer === q.payer && s.pay_to === q.pay_to && s.amount === q.amount && s.ledger_ts != null && Math.abs(s.ledger_ts - q.ledger_ts) <= q.window_ms).length;
  }
  async clusterSeller(q: Parameters<ContributorStore["clusterSeller"]>[0]) {
    return [...this.subs.values()].filter((s) => s.source === q.source && s.day === q.day && s.key_id !== q.key_id && s.weight !== 0 && (s.pay_to === q.pay_to || (!!q.domain && s.domain === q.domain))).length;
  }
  async resource(from: string, to: string) { for (const w of this.walletRows.values()) if (w.source === from && w.address !== to) { w.source = to; this.writes++; } }
  async setProven(a: string, id: string) { const w = this.walletRows.get(a); if (!w || w.key_id !== id) return false; w.proven = true; this.writes++; return true; }
  async getFunding(a: string) { const r = this.funding.get(a); return r ? { ...r } : null; }
  async putFunding(r: FundingRow) { this.funding.set(r.address, { ...r }); this.writes++; }
  async clusters() {
    const by = new Map<string, { keys: Set<string>; wallets: string[] }>();
    for (const w of this.walletRows.values()) { const e = by.get(w.source) ?? { keys: new Set(), wallets: [] }; e.keys.add(w.key_id); e.wallets.push(w.address); by.set(w.source, e); }
    return [...by.entries()].filter(([, e]) => e.keys.size > 1).map(([source, e]) => ({ source, keys: [...e.keys], wallets: e.wallets }));
  }
  async addSpend(r: CreditSpend) { this.spends.set(r.id, { ...r, alloc: r.alloc ? r.alloc.map((a) => ({ ...a })) : null }); this.writes++; }
  async deleteSpend(id: string) { this.spends.delete(id); this.writes++; }
  async spendsSince(id: string, d: string) { return [...this.spends.values()].filter((s) => s.key_id === id && s.day >= d).sort((a, b) => b.ts - a.ts).map((x) => ({ ...x, alloc: x.alloc ? x.alloc.map((a) => ({ ...a })) : null })); }
}

const TOUCH_SQL = "UPDATE contributor_keys SET last_active_day = ?2 WHERE key_id = ?1 AND status = 'active' AND (last_active_day IS NULL OR last_active_day < ?2)";
/** Submission fields cleared when a deleted contributor's published receipt is kept. */
const ANON_FIELDS = { key_id: DELETED_CONTRIBUTOR, payer: "", source: "", new_wallet: false, demand_opt_in: false, credit_uusd: 0, credit_note: null, kit_version: null } as const;
/** What is left of a deleted key: the random key id (so it can never be reused or re-authenticate), status and dates. No profile. */
function tombstone(id: string, k: ContributorKey, at: number, reason: string): ContributorKey {
  return { key_id: id, label: "", public_key: "", wallets: [], own_domains: [], daily_cap: null, share_demand: false, status: "deleted", forfeited: k.forfeited, created_at: k.created_at, revoked_at: at, revoke_reason: reason, last_active_day: null };
}
const SUB_COLS = "tx_hash, key_id, day, created_at, mode, kit_version, endpoint, endpoint_key, domain, network, asset, amount, pay_to, payer, source, new_wallet, receipt_hash, http_status, outcome, finding, wanted, demand_opt_in, ledger_ts, credit_uusd, credit_note, dispute, metrics, receipt, weight, weight_note";

export class D1ContributorStore implements ContributorStore {
  constructor(private db: D1Like) {}
  async getKey(id: string) {
    const r = await this.db.prepare("SELECT * FROM contributor_keys WHERE key_id = ?1").bind(id).first<any>();
    return r ? parseKey(r) : null;
  }
  async listKeys() { return ((await this.db.prepare("SELECT * FROM contributor_keys ORDER BY created_at").all<any>()).results ?? []).map(parseKey); }
  async wallets(a: string[]) {
    const l = [...new Set(a)].slice(0, 50);
    if (!l.length) return [];
    return ((await this.db.prepare(`SELECT * FROM contributor_wallets WHERE address IN (${l.map((_, i) => `?${i + 1}`).join(",")})`).bind(...l).all<any>()).results ?? []).map((r: any) => ({ ...r, proven: !!r.proven }));
  }
  async issue(k: ContributorKey, ws: WalletRow[]) {
    await this.db.batch([
      this.db.prepare("INSERT INTO contributor_keys (key_id, label, public_key, wallets, own_domains, daily_cap, share_demand, status, forfeited, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'active',0,?8)")
        .bind(k.key_id, k.label, k.public_key, JSON.stringify(k.wallets), JSON.stringify(k.own_domains), k.daily_cap, k.share_demand ? 1 : 0, k.created_at),
      ...ws.map((w) => this.db.prepare("INSERT INTO contributor_wallets (address, key_id, funder, funded_at, source, proven) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(address) DO UPDATE SET key_id = excluded.key_id, funder = excluded.funder, funded_at = excluded.funded_at, source = excluded.source, proven = excluded.proven")
        .bind(w.address, w.key_id, w.funder, w.funded_at, w.source, w.proven ? 1 : 0)),
    ]);
  }
  async revoke(id: string, at: number, reason: string, forfeit: boolean) {
    const r: any = await this.db.prepare("UPDATE contributor_keys SET status = 'revoked', revoked_at = ?2, revoke_reason = ?3, forfeited = MAX(forfeited, ?4) WHERE key_id = ?1").bind(id, at, reason, forfeit ? 1 : 0).run();
    return (r?.meta?.changes ?? 1) > 0;
  }
  async setShareDemand(id: string, v: boolean) { await this.db.prepare("UPDATE contributor_keys SET share_demand = ?2 WHERE key_id = ?1").bind(id, v ? 1 : 0).run(); }
  async touch(id: string, day: string) { await this.db.prepare(TOUCH_SQL).bind(id, day).run(); }
  /**
   * One batch (one transaction). Index reads only: submissions and spends by (key_id, ...), wallets by primary key.
   * Published rows are anonymised in place (receipt rewritten in JS); the rest are deleted.
   */
  async erase(id: string, at: number, reason: string): Promise<EraseResult> {
    const k = await this.getKey(id);
    const out: EraseResult = { found: !!k, submissions_deleted: 0, submissions_anonymised: 0, credit_spends_deleted: 0, wallets_deleted: 0 };
    if (!k) return out;
    const pub = ((await this.db.prepare("SELECT tx_hash, receipt FROM contributor_submissions WHERE key_id = ?1 AND published_at IS NOT NULL").bind(id).all<{ tx_hash: string; receipt: string }>()).results ?? []);
    const t = tombstone(id, k, at, reason);
    const st = [
      ...pub.map((r) => this.db.prepare("UPDATE contributor_submissions SET key_id = ?2, payer = '', source = '', new_wallet = 0, demand_opt_in = 0, credit_uusd = 0, credit_note = NULL, kit_version = NULL, receipt = ?3 WHERE tx_hash = ?1 AND key_id = ?4").bind(r.tx_hash, DELETED_CONTRIBUTOR, anonymisedReceipt(r.receipt, at), id)),
      this.db.prepare("DELETE FROM contributor_submissions WHERE key_id = ?1 AND published_at IS NULL").bind(id),
      this.db.prepare("DELETE FROM contributor_credit_spends WHERE key_id = ?1").bind(id),
      ...k.wallets.map((w) => this.db.prepare("DELETE FROM contributor_wallets WHERE address = ?1 AND key_id = ?2").bind(w, id)),
      this.db.prepare("UPDATE contributor_keys SET label = '', public_key = '', wallets = '[]', own_domains = '[]', daily_cap = NULL, share_demand = 0, status = 'deleted', revoked_at = ?2, revoke_reason = ?3, last_active_day = NULL WHERE key_id = ?1").bind(id, t.revoked_at, reason),
    ];
    const res = (await this.db.batch(st)) as any[];
    const ch = (i: number) => Number(res?.[i]?.meta?.changes ?? 0);
    out.submissions_anonymised = pub.reduce((n, _, i) => n + ch(i), 0);
    out.submissions_deleted = ch(pub.length);
    out.credit_spends_deleted = ch(pub.length + 1);
    out.wallets_deleted = k.wallets.reduce((n, _, i) => n + ch(pub.length + 2 + i), 0);
    return out;
  }
  async markPublished(tx: string, at: number) {
    const r: any = await this.db.prepare("UPDATE contributor_submissions SET published_at = COALESCE(published_at, ?2) WHERE tx_hash = ?1").bind(tx, at).run();
    return Number(r?.meta?.changes ?? 0) > 0;
  }
  async counts(q: Parameters<ContributorStore["counts"]>[0]): Promise<CapCounts> {
    // Every sub-select is served by (key_id, day), (endpoint_key, day) or the primary key: index reads only.
    const r = await this.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM contributor_submissions WHERE key_id = ?1 AND day = ?2) key_day,
         (SELECT COUNT(*) FROM contributor_submissions WHERE key_id = ?1 AND day = ?2 AND endpoint_key = ?3) key_ep_day,
         (SELECT COUNT(DISTINCT source) FROM contributor_submissions WHERE endpoint_key = ?3 AND day = ?2) ep_day_sources,
         (SELECT COUNT(*) FROM contributor_submissions WHERE endpoint_key = ?3 AND day = ?2 AND source = ?4) source_ep_day,
         (SELECT COUNT(*) FROM contributor_submissions WHERE key_id = ?1 AND day >= ?5 AND endpoint_key = ?3) key_ep_recent,
         (SELECT COALESCE(SUM(credit_uusd), 0) FROM contributor_submissions WHERE key_id = ?1 AND day >= ?6) month_credit,
         (SELECT COUNT(*) FROM contributor_submissions WHERE tx_hash = ?7) dup`,
    ).bind(q.key_id, q.day, q.endpoint_key, q.source, q.since_recent, q.since_month, q.tx_hash).first<CapCounts>();
    return { key_day: 0, key_ep_day: 0, ep_day_sources: 0, source_ep_day: 0, key_ep_recent: 0, month_credit: 0, dup: 0, ...(r ?? {}) };
  }
  async apply(ops: WriteOp[], budgetKey: string) {
    const st = ops.map((o) => o.op === "touch" ? this.db.prepare(TOUCH_SQL).bind(o.key_id, o.day) : o.op === "insert"
      ? this.db.prepare(`INSERT OR IGNORE INTO contributor_submissions (${SUB_COLS}) VALUES (${SUB_COLS.split(",").map((_, i) => `?${i + 1}`).join(",")})`).bind(
        o.row.tx_hash, o.row.key_id, o.row.day, o.row.created_at, o.row.mode, o.row.kit_version, o.row.endpoint, o.row.endpoint_key, o.row.domain, o.row.network,
        o.row.asset, o.row.amount, o.row.pay_to, o.row.payer, o.row.source, o.row.new_wallet ? 1 : 0, o.row.receipt_hash, o.row.http_status, o.row.outcome,
        o.row.finding, o.row.wanted ? 1 : 0, o.row.demand_opt_in ? 1 : 0, o.row.ledger_ts, o.row.credit_uusd, o.row.credit_note, o.row.dispute, o.row.metrics, o.row.receipt, o.row.weight ?? 1, o.row.weight_note ?? null)
      : o.dispute !== undefined
        ? this.db.prepare("UPDATE contributor_submissions SET finding = ?2, dispute = ?3 WHERE tx_hash = ?1").bind(o.tx_hash, o.finding, o.dispute)
        : this.db.prepare("UPDATE contributor_submissions SET finding = ?2 WHERE tx_hash = ?1").bind(o.tx_hash, o.finding));
    if (!st.length) return 0;
    const res = await this.db.batch(st);
    let rows = 0;
    if (Array.isArray(res)) for (const [i, r] of (res as any[]).entries()) rows += (r?.meta?.changes ?? 1) * (ops[i].op === "insert" ? ROWS_PER_SUBMISSION : 1);
    else rows = ops.length * ROWS_PER_SUBMISSION;
    if (rows) {
      await this.db.prepare("INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(meta.v AS INTEGER) + ?3 AS TEXT)").bind(budgetKey, String(rows), rows).run();
      rows++;
    }
    return rows;
  }
  async byTx(tx: string) { const r = await this.db.prepare(`SELECT ${SUB_COLS}, published_at FROM contributor_submissions WHERE tx_hash = ?1`).bind(tx).first<any>(); return r ? parseSub(r) : null; }
  async recentByKey(id: string, n: number) {
    return ((await this.db.prepare(`SELECT ${SUB_COLS} FROM contributor_submissions WHERE key_id = ?1 ORDER BY day DESC, created_at DESC LIMIT ?2`).bind(id, n).all<any>()).results ?? []).map(parseSub);
  }
  async endpointKeysSince(id: string, d: string) {
    return ((await this.db.prepare("SELECT DISTINCT endpoint_key FROM contributor_submissions WHERE key_id = ?1 AND day >= ?2").bind(id, d).all<{ endpoint_key: string }>()).results ?? []).map((r) => r.endpoint_key);
  }
  async byEndpoint(ek: string, d: string) {
    return ((await this.db.prepare(`SELECT ${SUB_COLS} FROM contributor_submissions WHERE endpoint_key = ?1 AND day >= ?2 LIMIT 200`).bind(ek, d).all<any>()).results ?? []).map(parseSub);
  }
  async totals() {
    return (await this.db.prepare("SELECT key_id, COUNT(*) n, COALESCE(SUM(credit_uusd),0) credit_uusd, COALESCE(SUM(CASE WHEN day >= ?1 THEN credit_uusd ELSE 0 END),0) month_uusd FROM contributor_submissions GROUP BY key_id")
      .bind(monthStart(Date.now())).all<any>()).results ?? [];
  }
  async since(d: string, n: number) {
    // Owner-only aggregate views; the table is small (owner-issued keys, capped per day).
    return ((await this.db.prepare(`SELECT ${SUB_COLS} FROM contributor_submissions WHERE day >= ?1 LIMIT ?2`).bind(d, n).all<any>()).results ?? []).map(parseSub);
  }
  async getMeta(k: string) { return (await this.db.prepare("SELECT v FROM meta WHERE k = ?1").bind(k).first<{ v: string }>())?.v ?? null; }
  async purge(d: string) {
    const r: any = await this.db.prepare("DELETE FROM contributor_submissions WHERE day < ?1").bind(d).run();
    await this.db.prepare("DELETE FROM contributor_credit_spends WHERE day < ?1").bind(d).run();
    return Number(r?.meta?.changes ?? 0);
  }
  async verifiedSince(id: string, d: string) {
    return ((await this.db.prepare("SELECT domain, pay_to, day, finding, dispute, weight FROM contributor_submissions WHERE key_id = ?1 AND day >= ?2").bind(id, d).all<any>()).results ?? []);
  }
  async nearDup(q: Parameters<ContributorStore["nearDup"]>[0]) {
    // (key_id, day) index range, then a filter on that key's few rows: no table scan.
    const r = await this.db.prepare("SELECT COUNT(*) n FROM contributor_submissions WHERE key_id = ?1 AND day >= ?2 AND payer = ?3 AND pay_to = ?4 AND amount = ?5 AND ledger_ts IS NOT NULL AND ABS(ledger_ts - ?6) <= ?7")
      .bind(q.key_id, q.since_day, q.payer, q.pay_to, q.amount, q.ledger_ts, q.window_ms).first<any>();
    return Number(r?.n ?? 0);
  }
  async clusterSeller(q: Parameters<ContributorStore["clusterSeller"]>[0]) {
    const r = await this.db.prepare("SELECT COUNT(*) n FROM contributor_submissions WHERE source = ?1 AND day = ?2 AND key_id != ?5 AND weight != 0 AND (pay_to = ?4 OR (?3 IS NOT NULL AND domain = ?3))")
      .bind(q.source, q.day, q.domain, q.pay_to, q.key_id).first<any>();
    return Number(r?.n ?? 0);
  }
  async resource(from: string, to: string) { await this.db.prepare("UPDATE contributor_wallets SET source = ?2 WHERE source = ?1 AND address != ?2").bind(from, to).run(); }
  async setProven(a: string, id: string) {
    const r: any = await this.db.prepare("UPDATE contributor_wallets SET proven = 1 WHERE address = ?1 AND key_id = ?2").bind(a, id).run();
    return (r?.meta?.changes ?? 1) > 0;
  }
  async getFunding(a: string) {
    const r = await this.db.prepare("SELECT address, funder, funded_at, checked_at FROM wallet_funding WHERE address = ?1").bind(a).first<any>();
    return r ? { address: r.address, funder: r.funder ?? null, funded_at: r.funded_at == null ? null : Number(r.funded_at), checked_at: Number(r.checked_at) } : null;
  }
  async putFunding(r: FundingRow) {
    await this.db.prepare("INSERT INTO wallet_funding (address, funder, funded_at, checked_at) VALUES (?1,?2,?3,?4) ON CONFLICT(address) DO UPDATE SET funder = excluded.funder, funded_at = excluded.funded_at, checked_at = excluded.checked_at")
      .bind(r.address, r.funder, r.funded_at, r.checked_at).run();
  }
  async clusters() {
    const rows = (await this.db.prepare("SELECT source, key_id, address FROM contributor_wallets WHERE source IN (SELECT source FROM contributor_wallets GROUP BY source HAVING COUNT(DISTINCT key_id) > 1) LIMIT 2000").all<any>()).results ?? [];
    const by = new Map<string, { keys: Set<string>; wallets: string[] }>();
    for (const w of rows) { const e = by.get(w.source) ?? { keys: new Set(), wallets: [] }; e.keys.add(w.key_id); e.wallets.push(w.address); by.set(w.source, e); }
    return [...by.entries()].map(([source, e]) => ({ source, keys: [...e.keys], wallets: e.wallets }));
  }
  async addSpend(r: CreditSpend) {
    await this.db.prepare("INSERT INTO contributor_credit_spends (id, key_id, ts, day, product, cost, ref, alloc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)").bind(r.id, r.key_id, r.ts, r.day, r.product, r.cost, r.ref, r.alloc ? JSON.stringify(r.alloc) : null).run();
  }
  async deleteSpend(id: string) { await this.db.prepare("DELETE FROM contributor_credit_spends WHERE id = ?1").bind(id).run(); }
  async spendsSince(id: string, d: string) {
    return ((await this.db.prepare("SELECT id, key_id, ts, day, product, cost, ref, alloc FROM contributor_credit_spends WHERE key_id = ?1 AND day >= ?2 ORDER BY ts DESC").bind(id, d).all<any>()).results ?? [])
      .map((r: any) => ({ ...r, ts: Number(r.ts), cost: Number(r.cost), alloc: r.alloc ? (JSON.parse(r.alloc) as CreditAlloc[]) : null }));
  }
}

// ---------------------------------------------------------------- helpers

/** What a contributor signs for each request (ed25519, base64 signature in Lumi-Signature). */
export const signedMessage = (method: string, pathAndQuery: string, ts: string, bodySha256: string) =>
  `lumi-contrib/v0\n${method.toUpperCase()}\n${pathAndQuery}\n${ts}\n${bodySha256}`;
/** What a seller signs to dispute a contributed finding about its endpoint. */
export const disputeMessage = (tx: string, reasonSha256: string) => `lumi-dispute:${tx}:${reasonSha256}`;

const HEX64 = /^[0-9a-f]{64}$/;
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hexBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
export const normWallet = (a: string) => (EVM_ADDR_RE.test(a) ? a.toLowerCase() : a);
const validWallet = (a: string) => XRPL_ADDR_RE.test(a) || EVM_ADDR_RE.test(a) || STELLAR_ADDR_RE.test(a);
const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
const hostMatches = (host: string, domains: string[]) => domains.some((d) => host === d || host.endsWith("." + d));
const randomHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
function mergeJson<T extends Record<string, any>>(base: T, raw: string | undefined): T {
  if (!raw) return base;
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return base;
    const out: any = { ...base };
    for (const [k, v] of Object.entries(o)) if (k in base) out[k] = typeof base[k] === "object" && v && typeof v === "object" ? { ...base[k], ...(v as object) } : v;
    return out;
  } catch { return base; }
}

/** Keep only known, small measurement fields from the kit (never trust size or shape). */
export function cleanMetrics(m: any): Record<string, unknown> | null {
  if (!m || typeof m !== "object") return null;
  const num = (v: unknown, max = 1e12) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : undefined);
  const str = (v: unknown, n = 128) => (typeof v === "string" ? v.slice(0, n) : undefined);
  const quotes = Array.isArray(m.quotes) ? m.quotes.slice(0, 6).map((q: any) => ({
    network: str(q?.network, 40), asset: str(q?.asset, 80), amount: str(q?.amount, 32), pay_to: str(q?.pay_to, 80), scheme: str(q?.scheme, 16),
  })) : undefined;
  const out = {
    latency_ms: num(m.latency_ms, 600_000), http_status: num(m.http_status, 999), response_bytes: num(m.response_bytes, 1e9),
    response_sha256: typeof m.response_sha256 === "string" && HEX64.test(m.response_sha256) ? m.response_sha256 : undefined,
    schema_fingerprint: typeof m.schema_fingerprint === "string" && /^[0-9a-f]{16,64}$/.test(m.schema_fingerprint) ? m.schema_fingerprint : undefined,
    content_type: str(m.content_type, 80), freshness_s: typeof m.freshness_s === "number" && Number.isFinite(m.freshness_s) ? Math.round(Math.max(-86400, Math.min(m.freshness_s, 1e9))) : undefined,
    data_timestamp: str(m.data_timestamp, 40), facilitator: str(m.facilitator, 120), settlement_ms: num(m.settlement_ms, 600_000),
    quote_latency_ms: num(m.quote_latency_ms, 600_000), quotes,
  };
  const s = canonicalJson(out);
  return s.length <= 2048 ? out : { ...out, quotes: undefined };
}

/** Funding source: who funded this wallet (one hop through other contributor wallets); the wallet itself if unknown or ignored. */
export const BASE_EXPLORER_API = "https://base.blockscout.com/api";
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
/**
 * First funder of a wallet. XRPL: the account's activating Payment (account_tx, forward, limit 1). Stellar: the
 * create_account operation's funder. Base: the earliest incoming ETH or USDC transfer from an Etherscan-compatible
 * explorer API (Blockscout by default; no key). Returns funder null when unknown or the lookup fails.
 */
export async function fundingOf(f: typeof fetch, opts: { xrplRpc: string[]; stellarHorizon: string; baseExplorer?: string }, address: string): Promise<{ funder: string | null; funded_at: number | null }> {
  try {
    if (EVM_ADDR_RE.test(address)) {
      const a = address.toLowerCase(), api = (opts.baseExplorer ?? BASE_EXPLORER_API).replace(/\/+$/, "");
      const get = async (q: string) => {
        const r = await f(`${api}?module=account&${q}&address=${a}&sort=asc&page=1&offset=10`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
        if (!r.ok) return [];
        const j: any = await r.json().catch(() => null);
        return Array.isArray(j?.result) ? j.result : [];
      };
      const [txs, toks] = await Promise.all([get("action=txlist"), get(`action=tokentx&contractaddress=${BASE_USDC}`)]);
      const inbound = [...txs.filter((t: any) => String(t?.to ?? "").toLowerCase() === a && String(t?.value ?? "0") !== "0" && String(t?.isError ?? "0") === "0"),
        ...toks.filter((t: any) => String(t?.to ?? "").toLowerCase() === a)]
        .map((t: any) => ({ from: String(t.from ?? "").toLowerCase(), ts: Number(t.timeStamp) * 1000 }))
        .filter((t) => EVM_ADDR_RE.test(t.from) && t.from !== a && Number.isFinite(t.ts))
        .sort((x, y) => x.ts - y.ts);
      return inbound.length ? { funder: inbound[0].from, funded_at: inbound[0].ts } : { funder: null, funded_at: null };
    }
    if (XRPL_ADDR_RE.test(address)) {
      for (const u of opts.xrplRpc) {
        const j = await rpc(f, u, { method: "account_tx", params: [{ account: address, forward: true, limit: 1, ledger_index_min: -1, ledger_index_max: -1, api_version: 2 }] }).catch(() => null);
        const t = j?.result?.transactions?.[0];
        if (!j?.result || j.result.error) continue;
        const tx = t?.tx_json ?? t?.tx;
        if (tx?.TransactionType === "Payment" && tx.Destination === address) {
          const ts = t.close_time_iso ? Date.parse(t.close_time_iso) : typeof tx.date === "number" ? (tx.date + 946_684_800) * 1000 : null;
          return { funder: String(tx.Account), funded_at: ts };
        }
        return { funder: null, funded_at: null };
      }
    } else if (STELLAR_ADDR_RE.test(address)) {
      const r = await f(`${opts.stellarHorizon.replace(/\/+$/, "")}/accounts/${address}/operations?order=asc&limit=1`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (r.ok) {
        const op = ((await r.json()) as any)?._embedded?.records?.[0];
        if (op?.type === "create_account") return { funder: String(op.funder), funded_at: Date.parse(op.created_at) || null };
      }
    }
  } catch { /* unknown */ }
  return { funder: null, funded_at: null };
}

// ---------------------------------------------------------------- service

export interface ContribQueue { send(body: unknown): Promise<unknown> }
export interface ContributorDeps {
  store: ContributorStore;
  fetch: typeof fetch;
  now: () => number;
  ownerKey?: string;
  xrplRpc: string[];
  baseRpc: string;
  stellarHorizon?: string;
  catalogStore?: CatalogStore;
  receipts?: ReceiptStore;
  /** Lumi's own pay_to addresses and hosts: never accepted as a contributed test target. */
  self: { pay_to: string[]; domains: string[] };
  /** Funders ignored when grouping by funding source (exchange hot wallets, faucets). */
  ignoreFunders?: string[];
  /** Etherscan-compatible explorer API for Base first-funder lookups (CONTRIB_BASE_EXPLORER_API). Default Blockscout. */
  baseExplorer?: string;
  /** Workers Rate Limiting binding (CONTRIB_RATE_LIMITER): durable-ish per-key limit across isolates, no D1 writes. */
  rateLimiter?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  queue?: ContribQueue;
  log?: (e: Record<string, unknown>) => void;
  credits?: string; caps?: string; minKit?: string; retiredKits?: string;
  /** Scoped admin key for /v1/owner/contributors* (CONTRIB_ADMIN_KEY). When set, OWNER_MCP_KEY no longer opens these routes. */
  adminKey?: string;
  /** Legacy USD-denominated credit / cash-bounty accounting (CONTRIB_CASH_BOUNTIES_ENABLED). Default false: never cash. */
  creditsEnabled?: boolean;
  /** Free Lumi Check credits per verified receipt (CONTRIB_CHECK_CREDITS_PER_RECEIPT). Placeholder default, needs Bobby. */
  checkCreditsPerReceipt?: string;
  /** Free Lumi Check credit prices (CONTRIB_CHECK_CREDIT_PRICES JSON). */
  checkCreditPrices?: string;
  /** Serves a paid product for credits: the same body the x402 route returns. Not charged on errors. */
  redeem?: (product: CreditProduct, input: Record<string, string>, base: string) => Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: Record<string, unknown> }>;
}

export type CreditProduct = "trust_check" | "vendor_report";

/** Lumi Check v0: raw contributed submissions (incl. the stored receipt copy) and credit spends are deleted after this many days (approved by Bobby). Accounts are not: see CONTRIB_ACTIVE_WINDOW_DAYS. */
export const CONTRIB_RETENTION_DAYS = 90;
/** Unused free Lumi Check credits expire this many days after the UTC day they were earned (approved by Bobby). Spends use the oldest credits first. */
export const CHECK_CREDIT_EXPIRY_DAYS = 90;
/**
 * Contributor accounts (keys, wallets) are NOT purged at 90 days: they are kept while active. Active = not revoked and a
 * verified-or-pending receipt accepted, or a signed /v1/check made, within the last CONTRIB_ACTIVE_WINDOW_DAYS (a new key
 * counts from its creation). PLACEHOLDER definition, flagged for Bobby. Inactive handling is a placeholder that only
 * lists keys (GET /v1/owner/contributors/inactive); it deletes, revokes or notifies nothing.
 */
export const CONTRIB_ACTIVE_WINDOW_DAYS = 365;
/**
 * Free Lumi Check credits (launch rewards, NO cash). Each verified receipt earns CHECK_CREDITS_PER_RECEIPT, at most ONE
 * earning per (contributor, seller, UTC day): extra receipts on the same seller that day, duplicates and rejected
 * (self-dealt, unverifiable) receipts earn nothing. Only findings counted/confirmed without a dispute earn; a later dispute
 * or contradiction removes the earning (the earn side is derived, not stored). Each earning is a lot that expires
 * CHECK_CREDIT_EXPIRY_DAYS after the day it was earned; spends draw from the oldest unexpired lot first.
 * Spend on detailed checks (paid /v1/trust/check) or vendor reports. PLACEHOLDER numbers, flagged for Bobby.
 */
export const CHECK_CREDITS_PER_RECEIPT = 5;
export const CHECK_CREDIT_PRICES: Record<CreditProduct, number> = { trust_check: 1, vendor_report: 10 };
/** Perks for contributors with >= 1 verified receipt: early access + a higher /v1/check rate limit (per key, per minute). */
export const CONTRIB_PERK_CHECKS_PER_MINUTE = 120;
/**
 * DISABLED STUB (design note, nothing pays out): post-revenue "wanted list" of FIXED bounties for testing specific sellers,
 * paid from a capped budget. See docs/contrib-bounties.md. No payout code exists; /v1/contrib/bounties reports disabled.
 */
export const CONTRIB_BOUNTIES = Object.freeze({ enabled: false, status: "planned_after_revenue", budget_cap_usd: 0, payout: "none" });

/** Contributor badges: verified receipts (findings counted or confirmed; at most one per endpoint per UTC day per key). */
export const CONTRIB_BADGES = [
  { id: "first_receipt", label: "First verified receipt", min: 1 },
  { id: "scout", label: "Scout", min: 10 },
  { id: "ranger", label: "Ranger", min: 50 },
  { id: "sentinel", label: "Sentinel", min: 200 },
] as const;

/** Canonical tx-hash form for duplicate detection: XRPL upper-case hex, EVM and Stellar lower-case. */
export function normTx(network: string, tx: string): string {
  return network === "xrpl:0" || network.startsWith("xrpl:") ? tx.toUpperCase() : tx.toLowerCase();
}

/** Receipt copy that is safe to store: seller endpoint reduced to origin + path (query strings can carry buyer details). */
export function storedReceipt(r: any): string {
  const ep = String(r?.seller?.endpoint ?? "");
  const clean = originPath(ep);
  const copy = clean && clean !== ep ? { ...r, seller: { ...r.seller, endpoint: clean }, x_lumi_stored: { redacted: ["seller.endpoint.query"], note: "Stored copy; verify against receipt_hash from the original." } } : r;
  return JSON.stringify(copy).slice(0, 12_000);
}

export function createContributors(deps: ContributorDeps) {
  const { store, now } = deps;
  const CREDITS: Credits = mergeJson(DEFAULT_CREDITS, deps.credits);
  const CAPS: Caps = mergeJson(DEFAULT_CAPS, deps.caps);
  const minKit = deps.minKit || DEFAULT_MIN_KIT;
  const retired = new Set((deps.retiredKits ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const ignore = new Set((deps.ignoreFunders ?? []).map(normWallet));
  const selfPayTo = new Set(deps.self.pay_to.map((x) => normWallet(x)));
  const horizon = deps.stellarHorizon ?? STELLAR_HORIZON;
  const minute = new Map<string, { at: number; n: number }>();
  const pending = new Map<string, number>(); // queued tx hashes (dedupe until the batch lands)
  let pendingRows = 0;
  let wantedMemo: { at: number; list: WantedItem[] } | undefined;
  const pendingPurchases = new Map<string, { ts: number; at: number }[]>(); // payer|pay_to|amount -> ledger times queued (near-dup until the batch lands)

  /** First funder, cached in wallet_funding: found funders forever, misses re-checked after funding_recheck_days. */
  async function funding(address: string): Promise<{ funder: string | null; funded_at: number | null }> {
    const a = normWallet(address);
    const c = await store.getFunding(a).catch(() => null);
    if (c && (c.funder || now() - c.checked_at < CAPS.funding_recheck_days * DAY_MS)) return { funder: c.funder, funded_at: c.funded_at };
    const f = await fundingOf(deps.fetch, { xrplRpc: deps.xrplRpc, stellarHorizon: horizon, baseExplorer: deps.baseExplorer }, a);
    const funder = f.funder ? normWallet(f.funder) : null;
    await store.putFunding({ address: a, funder, funded_at: f.funded_at, checked_at: now() }).catch(() => undefined);
    return { funder, funded_at: f.funded_at };
  }
  /**
   * Seller-funded: the payer was funded by the seller's pay_to, by the pay_to's own funder, or shares a funding source
   * with it. Exchange/faucet funders in CONTRIB_FUNDER_IGNORE never link wallets.
   */
  async function sellerFunded(w: WalletRow | undefined, payer: string, payTo: string): Promise<boolean> {
    const pf = w?.funder ?? (await funding(payer)).funder;
    const ps = w?.source ?? payer;
    const linked = (x: string | null | undefined) => !!x && !ignore.has(x);
    if ((linked(pf) && pf === payTo) || (ps !== payer && ps === payTo)) return true;
    const sf = (await funding(payTo)).funder;
    if (!linked(sf)) return false;
    if (pf === sf || ps === sf) return true;
    const [sw] = await store.wallets([sf!]); // seller's funder is itself a registered wallet: same cluster
    return !!sw && (sw.source === ps || sw.source === pf);
  }

  // Scoped: CONTRIB_ADMIN_KEY when set (OWNER_MCP_KEY then does NOT open contributor admin), else OWNER_MCP_KEY (back-compat).
  const adminKey = deps.adminKey || deps.ownerKey;
  const ownerOk = async (req: Request) => isOwnerKey(/^Bearer\s+(\S+)$/i.exec(req.headers.get("Authorization") ?? "")?.[1], adminKey);
  const creditsOn = deps.creditsEnabled === true;
  const perReceipt = (() => { const n = Number(deps.checkCreditsPerReceipt); return Number.isInteger(n) && n >= 0 && n <= 1000 ? n : CHECK_CREDITS_PER_RECEIPT; })();
  const prices: Record<CreditProduct, number> = (() => {
    const m = mergeJson({ ...CHECK_CREDIT_PRICES }, deps.checkCreditPrices) as Record<CreditProduct, unknown>;
    const out = { ...CHECK_CREDIT_PRICES };
    for (const k of Object.keys(out) as CreditProduct[]) { const n = Number(m[k]); if (Number.isInteger(n) && n >= 1 && n <= 10_000) out[k] = n; }
    return out;
  })();
  const perkMinute = new Map<string, { at: number; n: number }>();
  const noStore = { "Cache-Control": "no-store" };
  const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json(status, { error, ...extra }, noStore);

  function kitCheck(v: string | null | undefined): string | null {
    if (!v) return "kit_version_missing";
    const m = /^([a-z0-9-]+)\/(\d+\.\d+\.\d+)$/.exec(v);
    if (!m || m[1] !== KIT_NAME) return "kit_version_invalid";
    if (retired.has(m[2]) || cmpVersion(m[2], minKit) < 0) return "kit_version_retired";
    return null;
  }

  async function authContributor(req: Request, raw: string): Promise<{ ok: true; key: ContributorKey } | { ok: false; res: Response }> {
    const id = req.headers.get("Lumi-Contributor-Key") ?? "";
    const ts = req.headers.get("Lumi-Timestamp") ?? "";
    const sig = req.headers.get("Lumi-Signature") ?? "";
    const fail = (s: number, e: string) => ({ ok: false as const, res: err(s, e) });
    if (!/^lck_[0-9a-f]{16}$/.test(id) || !/^\d{13}$/.test(ts) || !sig) return fail(401, "contributor_signature_required");
    if (Math.abs(now() - Number(ts)) > 5 * 60_000) return fail(401, "timestamp_out_of_window");
    const kv = kitCheck(req.headers.get("Lumi-Kit"));
    if (kv) return { ok: false, res: err(426, kv, { min_kit_version: minKit, hint: "Update Lumi Check." }) };
    const key = await store.getKey(id); // read every time: revocation is instant
    if (!key) return fail(401, "unknown_key");
    if (key.status === "deleted") return fail(403, "key_deleted");
    if (key.status !== "active") return fail(403, "key_revoked");
    const u = new URL(req.url);
    const msg = signedMessage(req.method, u.pathname + u.search, ts, await sha256Hex(raw));
    let good = false;
    try { good = ed25519.verify(b64(sig), new TextEncoder().encode(msg), hexBytes(key.public_key)); } catch { good = false; }
    if (!good) return fail(401, "bad_signature");
    if (deps.rateLimiter) {
      // Workers Rate Limiting binding: shared across isolates in a location, no D1 rows. Fail open to the in-isolate limiter.
      const r = await deps.rateLimiter.limit({ key: "contrib:" + id }).catch(() => null);
      if (r && !r.success) return fail(429, "rate_limited");
      if (r) return { ok: true, key };
    }
    const t = now(), m = minute.get(id);
    if (m && t - m.at < 60_000) { if (++m.n > CAPS.per_minute) return fail(429, "rate_limited"); } else minute.set(id, { at: t, n: 1 });
    return { ok: true, key };
  }

  /**
   * Account deletion (self-service or owner on an email request). Deletes: the key's profile (label, public key,
   * wallets, own domains, demand opt-in, activity date), registered wallet rows, every credit spend, and every
   * submission row, which also removes the credit balance and lots (derived from them) and the leaderboard entry.
   * Keeps, with the contributor link stripped: submissions the owner marked as cited in a published, dated test
   * result (anonymisedReceipt). Untouched: tier-1 daily summaries and raw tier-1 rows, which never held a
   * contributor link. Leaves a tombstone key row (status 'deleted', no personal data) so the key can never sign again.
   */
  async function eraseAccount(id: string, by: "contributor" | "owner") {
    const r = await store.erase(id, now(), by === "contributor" ? "deleted_by_contributor" : "deleted_by_owner");
    minute.delete(id);
    if (r.found) deps.log?.({ event: "contrib_account_deleted", by, ...r }); // no key id or wallet in logs
    return { deleted: r.found, status: "deleted", ...r, kept: { anonymised_published_receipts: r.submissions_anonymised, tier1_daily_summaries: "unchanged (never linked to a contributor)" }, note: "Payments on a public blockchain cannot be deleted by anyone." };
  }

  async function flush(ops: WriteOp[]) {
    const rows = await store.apply(ops, contribBudgetKey(now()));
    deps.log?.({ event: "contrib_write", ops: ops.length, rows });
    return rows;
  }
  async function write(ops: WriteOp[]) {
    if (!ops.length) return;
    if (deps.queue) {
      for (const o of ops) if (o.op === "insert") pending.set(o.row.tx_hash, now());
      pendingRows += ops.reduce((n, o) => n + (o.op === "insert" ? ROWS_PER_SUBMISSION : 1), 0);
      await deps.queue.send({ kind: "contrib_write", ops });
    } else await flush(ops);
  }
  async function budgetLeft() {
    for (const [tx, at] of pending) if (now() - at > 10 * 60_000) pending.delete(tx);
    if (!pending.size) pendingRows = 0;
    const used = Number((await store.getMeta(contribBudgetKey(now()))) ?? "0") + pendingRows;
    return CAPS.write_budget_rows - used;
  }

  // ---------------------------------------------------- listing knowledge (read-only)

  interface Known { listed: boolean; pay_tos: string[]; vendor_id?: string; method?: string; body?: string | null }
  async function known(endpoint: string): Promise<Known> {
    const vars = urlVariants(endpoint);
    for (const v of VENDORS) for (const e of v.endpoints) if (vars.includes(normalizeUrl(e.url) ?? "")) return { listed: true, pay_tos: [...v.pay_to.xrpl, ...(v.pay_to.evm ?? [])].map(normWallet), vendor_id: v.id };
    if (deps.catalogStore) {
      for (const v of vars) {
        const row = await deps.catalogStore.byResource(v).catch(() => null);
        if (row) return { listed: true, pay_tos: (row.pay_tos ?? "").split(",").filter(Boolean).map(normWallet) };
      }
    }
    return { listed: false, pay_tos: [] };
  }
  /** Is this endpoint one the contributor (or any contributor) sells? */
  async function selfTest(key: ContributorKey, endpoint: string, payTo: string, payer: string, k: Known): Promise<string | null> {
    const host = hostOf(endpoint);
    const mine = new Set(key.wallets.map(normWallet));
    if (normWallet(payer) === normWallet(payTo)) return "self_payment";
    if (mine.has(normWallet(payTo))) return "self_test_pay_to";
    if (k.pay_tos.some((p) => mine.has(p))) return "self_test_listing";
    if (hostMatches(host, key.own_domains)) return "self_test_domain";
    if (selfPayTo.has(normWallet(payTo)) || hostMatches(host, deps.self.domains)) return "lumi_endpoint";
    if ((await store.wallets([normWallet(payTo)])).length) return "pay_to_is_contributor_wallet";
    for (const v of VENDORS) if ([...v.pay_to.xrpl, ...(v.pay_to.evm ?? [])].some((p) => mine.has(normWallet(p))) && hostOf(v.homepage) && hostMatches(host, [hostOf(v.homepage).replace(/^www\./, "")])) return "self_test_vendor";
    if (deps.catalogStore) {
      const sold = await deps.catalogStore.byPayTos([...mine].map((x) => x.toLowerCase()), 20).catch(() => [] as CatalogRow[]);
      if (sold.some((r) => r.domain && hostMatches(host, [r.domain.toLowerCase()]))) return "self_test_listing";
    }
    return null;
  }

  // ---------------------------------------------------- wanted list (server-side selection)

  interface WantedItem { url: string; method: string; body?: string | null; network: string; max_price: string; asset_hint?: string; key: string }
  async function globalWanted(): Promise<WantedItem[]> {
    if (wantedMemo && now() - wantedMemo.at < 30 * 60_000) return wantedMemo.list;
    const out: WantedItem[] = [];
    for (const v of VENDORS) for (const e of v.endpoints) {
      const u = normalizeUrl(e.url); if (!u) continue;
      out.push({ url: u, method: e.method, body: e.body ? JSON.stringify(e.body) : null, network: "xrpl:0", max_price: e.listed_price, asset_hint: e.listed_asset, key: (await sha256Hex(u)).slice(0, 32) });
    }
    if (deps.catalogStore) {
      for (const net of ["stellar:pubnet", "eip155:8453"]) {
        const rows = await deps.catalogStore.popular(0.05, 40, net).catch(() => [] as CatalogRow[]);
        for (const r of rows) {
          const u = normalizeUrl(r.resource); if (!u || hostMatches(hostOf(u), deps.self.domains)) continue;
          out.push({ url: u, method: r.method || "GET", body: r.body, network: net, max_price: String(r.price_usd ?? ""), asset_hint: "USDC", key: (await sha256Hex(u)).slice(0, 32) });
        }
      }
    }
    wantedMemo = { at: now(), list: out };
    return out;
  }
  async function wantedFor(key: ContributorKey, limit: number, network?: string) {
    const all = (await globalWanted()).filter((w) => !network || w.network === network);
    const recent = new Set(await store.endpointKeysSince(key.key_id, dayOf(now() - 7 * DAY_MS)));
    const mine = new Set(key.wallets.map(normWallet));
    const rank = async (w: WantedItem) => parseInt((await sha256Hex(key.key_id + dayOf(now()) + w.key)).slice(0, 8), 16);
    const pool: { w: WantedItem; r: number }[] = [];
    for (const w of all) {
      if (recent.has(w.key) || hostMatches(hostOf(w.url), key.own_domains)) continue;
      const k = await known(w.url);
      if (k.pay_tos.some((p) => mine.has(p))) continue;
      pool.push({ w, r: await rank(w) });
    }
    // Under-tested chains first, then a per-key daily rotation so contributors spread out.
    const chainW = (n: string) => CREDITS.chain_mult[n] ?? 1;
    pool.sort((a, b) => chainW(b.w.network) - chainW(a.w.network) || a.r - b.r);
    return pool.slice(0, limit).map(({ w }) => ({ url: w.url, method: w.method, ...(w.body ? { body: w.body } : {}), network: w.network, max_listed_price: w.max_price, ...(w.asset_hint ? { asset_hint: w.asset_hint } : {}) }));
  }
  async function isWanted(endpoint: string) {
    const ek = (await sha256Hex(endpoint)).slice(0, 32);
    return (await globalWanted()).some((w) => w.key === ek);
  }

  // ---------------------------------------------------- submissions

  function credit(o: { mode: string; network: string; wanted: boolean; repeat: boolean; listed: boolean; payToListed: boolean; monthSoFar: number; forfeited: boolean }) {
    if (!creditsOn) return { uusd: 0, note: "credits_disabled" };
    if (o.forfeited) return { uusd: 0, note: "forfeited" };
    if (!o.listed) return { uusd: Math.round(CREDITS.base_uusd * CREDITS.unlisted_mult), note: "unlisted_endpoint" };
    if (!o.payToListed) return { uusd: Math.round(CREDITS.base_uusd * CREDITS.unlisted_mult), note: "pay_to_not_listed" };
    let c = CREDITS.base_uusd * (CREDITS.chain_mult[o.network] ?? 1) * (o.mode === "passive" ? CREDITS.passive_mult : CREDITS.test_buy_mult);
    const notes: string[] = [];
    if (o.wanted) { c *= CREDITS.wanted_mult; notes.push("wanted"); }
    if (o.repeat) { c *= CREDITS.repeat_mult; notes.push("repeat"); }
    c = Math.round(c);
    const room = Math.max(0, CREDITS.monthly_cap_uusd - o.monthSoFar);
    if (c > room) { c = room; notes.push("monthly_cap"); }
    return { uusd: c, note: notes.join(",") || null };
  }

  /** Anti-boost: an endpoint whose recent verified receipts come from few funding sources or mostly new wallets. */
  function boostFlag(rows: Pick<Submission, "source" | "new_wallet">[]) {
    if (rows.length < CAPS.flag_min_receipts) return null;
    const sources = new Set(rows.map((r) => r.source)).size;
    const newShare = rows.filter((r) => r.new_wallet).length / rows.length;
    if (sources <= CAPS.flag_max_sources) return { flag: "few_funding_sources", receipts: rows.length, sources, new_wallet_share: Math.round(newShare * 100) / 100 };
    if (newShare >= CAPS.flag_new_wallet_share) return { flag: "new_wallets_dominate", receipts: rows.length, sources, new_wallet_share: Math.round(newShare * 100) / 100 };
    return null;
  }

  async function ledgerCheck(r: Receipt): Promise<{ ok: true; ts: number } | { ok: false; status: number; error: string }> {
    const p = r.payment;
    const look: Lookup = p.network === "xrpl:0" ? await lookupXrplPayment(deps.fetch, deps.xrplRpc, String(p.tx_hash))
      : p.network === "stellar:pubnet" ? await lookupStellarUsdc(deps.fetch, horizon, String(p.tx_hash))
      : await lookupBaseUsdc(deps.fetch, deps.baseRpc, String(p.tx_hash));
    if (!look.ok) return look.reason === "ledger_unavailable" ? { ok: false, status: 503, error: "ledger_unavailable" } : { ok: false, status: 422, error: "ledger_" + look.reason };
    const pay = look.payments.find((x) => x.from.toLowerCase() === String(p.payer).toLowerCase() && x.to.toLowerCase() === String(r.seller.pay_to).toLowerCase());
    if (!pay) return { ok: false, status: 422, error: "ledger_no_transfer_from_payer_to_pay_to" };
    if (Math.abs(Number(pay.amount) - Number(p.amount)) > 1e-9) return { ok: false, status: 422, error: "ledger_amount_mismatch" };
    if (pay.asset !== p.asset) return { ok: false, status: 422, error: "ledger_asset_mismatch" };
    if (!Number.isFinite(pay.ts)) return { ok: false, status: 503, error: "ledger_unavailable" };
    return { ok: true, ts: pay.ts };
  }

  async function submit(req: Request, raw: string, key: ContributorKey): Promise<Response> {
    let body: any;
    try { body = JSON.parse(raw); } catch { return err(400, "invalid_json"); }
    const r: any = body?.receipt;
    const mode = body?.mode === "test_buy" ? "test_buy" : body?.mode === "passive" ? "passive" : null;
    if (!mode) return err(400, "mode_required", { allowed: ["passive", "test_buy"] });
    // 1. Offline checks first (no network, no writes).
    const check = await verifyReceipt(r);
    if (!check.ok) return err(422, "receipt_invalid", { errors: check.errors });
    const ext = r.x_lumi_contrib;
    if (!ext || !ACCEPTED_FORMATS.includes(ext.format)) return err(422, "receipt_format_unsupported", { accepted: ACCEPTED_FORMATS });
    const kv = kitCheck(`${ext?.kit?.name}/${ext?.kit?.version}`);
    if (kv) return err(426, kv, { min_kit_version: minKit });
    if (ext.mode !== mode) return err(422, "mode_mismatch");
    const p = r.payment, tx = normTx(String(p.network), String(p.tx_hash));
    const payer = normWallet(String(p.payer)), payTo = normWallet(String(r.seller.pay_to));
    if (!key.wallets.map(normWallet).includes(payer)) return err(403, "payer_not_registered_to_key");
    const fullEndpoint = normalizeUrl(String(r.seller.endpoint ?? ""));
    // Stored, keyed and capped on origin + path only: query strings never stored, and cannot dodge per-endpoint caps.
    const endpoint = originPath(fullEndpoint);
    if (!fullEndpoint || !endpoint) return err(422, "endpoint_invalid");
    const observed = Date.parse(String(r.delivery.observed_at));
    if (!Number.isFinite(observed) || observed > now() + 5 * 60_000) return err(422, "observed_at_invalid");
    if (observed < now() - CAPS.tx_max_age_days * DAY_MS) return err(422, "too_old");
    // 2. Self-testing and duplicates (index reads).
    const k0 = await known(fullEndpoint);
    const k = k0.listed || fullEndpoint === endpoint ? k0 : await known(endpoint);
    const self = await selfTest(key, endpoint, payTo, payer, k);
    if (self) return err(403, "self_testing", { reason: self });
    if (pending.has(tx)) return err(409, "duplicate");
    if (deps.receipts && ((await deps.receipts.buy(tx).catch(() => null)) || (tx !== String(p.tx_hash) && (await deps.receipts.buy(String(p.tx_hash)).catch(() => null))))) return err(409, "already_recorded_by_lumi");
    const [w] = await store.wallets([payer]);
    const source = w?.source ?? payer;
    const newWallet = !!w?.funded_at && now() - w.funded_at < CAPS.new_wallet_days * DAY_MS;
    const ek = (await sha256Hex(endpoint)).slice(0, 32);
    const t = now(), day = dayOf(t);
    const c = await store.counts({ key_id: key.key_id, endpoint_key: ek, source, day, since_recent: dayOf(t - CREDITS.repeat_window_days * DAY_MS), since_month: monthStart(t), tx_hash: tx });
    if (c.dup) return err(409, "duplicate");
    // 3. Caps (anti-boost counts funding sources, not wallets).
    if (c.key_day >= (key.daily_cap ?? CAPS.key_daily)) return err(429, "key_daily_cap");
    if (c.key_ep_day >= CAPS.key_endpoint_daily) return err(429, "key_endpoint_daily_cap");
    if (c.source_ep_day >= CAPS.source_endpoint_daily) return err(429, "funding_source_endpoint_daily_cap");
    if (c.ep_day_sources >= CAPS.endpoint_daily_sources) return err(429, "endpoint_daily_cap");
    if ((await budgetLeft()) < ROWS_PER_SUBMISSION * 2) return err(503, "contrib_write_budget", { retry: "next UTC day" });
    // 4. On-ledger (one lookup, only after every cheap check passed).
    const led = await ledgerCheck(r);
    if (!led.ok) return err(led.status, led.error, led.status === 503 ? { retryable: true } : {});
    if (led.ts < t - CAPS.tx_max_age_days * DAY_MS) return err(422, "too_old");
    if (Math.abs(observed - led.ts) > CAPS.observed_skew_min * 60_000) return err(422, "observed_at_far_from_ledger");
    // 4b. Near-duplicate purchase (same payer + seller + amount, ledger times within the window), stored or queued.
    const win = CAPS.near_dup_window_s * 1000, pkey = `${payer}|${payTo}|${String(p.amount)}`;
    for (const [k2, l] of pendingPurchases) { const f = l.filter((x) => now() - x.at < 10 * 60_000); if (f.length) pendingPurchases.set(k2, f); else pendingPurchases.delete(k2); }
    if ((pendingPurchases.get(pkey) ?? []).some((x) => Math.abs(x.ts - led.ts) <= win)
      || (await store.nearDup({ key_id: key.key_id, since_day: dayOf(led.ts - win - DAY_MS), payer, pay_to: payTo, amount: String(p.amount), ledger_ts: led.ts, window_ms: win })) > 0) {
      return err(409, "near_duplicate", { window_s: CAPS.near_dup_window_s });
    }
    // 4c. Weight: unproven wallets, seller-funded payers and repeat receipts from one funding cluster count for nothing.
    let weightNote: WeightNote | null = null;
    if (!w?.proven) weightNote = "wallet_unproven";
    else if (await sellerFunded(w, payer, payTo)) weightNote = "seller_funded";
    else if ((await store.clusterSeller({ source, day, domain: hostOf(endpoint) || null, pay_to: payTo, key_id: key.key_id })) > 0) weightNote = "same_cluster";
    const weight = weightNote ? 0 : 1;
    // 5. Findings: negatives wait for independent confirmation; boosted endpoints are held.
    const ops: WriteOp[] = [];
    const recent = await store.byEndpoint(ek, dayOf(t - 7 * DAY_MS));
    const flag = boostFlag([...recent, { source, new_wallet: newWallet }]);
    const negative = isNegative(r.delivery.outcome);
    let finding: Finding = negative ? "unconfirmed" : "counted";
    if (negative && weight) {
      const other = recent.filter((s) => isNegative(s.outcome) && s.key_id !== key.key_id && s.source !== source && s.weight !== 0 && (s.finding === "unconfirmed" || s.finding === "confirmed"));
      if (other.length) { finding = "confirmed"; for (const s of other) if (s.finding === "unconfirmed") ops.push({ op: "finding", tx_hash: s.tx_hash, finding: "confirmed" }); }
      else if (await lumiRebuyNegative(endpoint, t)) finding = "confirmed";
    }
    if (flag) finding = "held";
    const wanted = await isWanted(endpoint);
    const payToListed = !k.listed || k.pay_tos.includes(payTo);
    const cr0 = credit({ mode, network: p.network, wanted, repeat: c.key_ep_recent > 0, listed: k.listed, payToListed, monthSoFar: c.month_credit, forfeited: key.forfeited });
    const cr = weight ? cr0 : { uusd: 0, note: weightNote };
    const metrics = cleanMetrics(ext.measurements);
    const row: Submission = {
      tx_hash: tx, key_id: key.key_id, day, created_at: t, mode, kit_version: String(ext.kit.version), endpoint, endpoint_key: ek, domain: hostOf(endpoint) || null,
      network: p.network, asset: String(p.asset), amount: String(p.amount), pay_to: payTo, payer, source, new_wallet: newWallet, receipt_hash: r.receipt_hash,
      http_status: Number.isInteger(r.delivery.http_status) ? r.delivery.http_status : null, outcome: String(r.delivery.outcome), finding, wanted,
      demand_opt_in: mode === "passive" && key.share_demand, ledger_ts: led.ts, credit_uusd: cr.uusd, credit_note: cr.note, dispute: null,
      metrics: metrics ? JSON.stringify(metrics) : null, receipt: storedReceipt(r), weight, weight_note: weightNote,
    };
    ops.unshift({ op: "insert", row });
    ops.push({ op: "touch", key_id: key.key_id, day });
    if (deps.queue) pendingPurchases.set(pkey, [...(pendingPurchases.get(pkey) ?? []), { ts: led.ts, at: now() }]);
    await write(ops);
    return json(202, {
      accepted: true, queued: !!deps.queue, tx_hash: tx, finding, weight, ...(weightNote ? { weight_note: weightNote, counts: false } : {}),
      ...(creditsOn ? { credit_uusd: cr.uusd, credit_usd: cr.uusd / 1e6, credit_note: cr.note } : { rewards: "check_credits_badges_leaderboard", check_credits: { per_verified_receipt: perReceipt, rule: "one earning per seller per UTC day; credited once the finding is verified" } }),
      ...(flag ? { endpoint_flag: flag.flag } : {}),
      note: creditsOn
        ? "Credits are Lumi API credits, not cash. Negative findings count only after independent confirmation. Draft terms apply."
        : "Rewards: free Lumi Check credits (detailed checks and reports), contributor badges, the leaderboard, early access and higher rate limits. No cash. Negative findings count only after independent confirmation. Draft terms apply.",
    }, noStore);
  }

  /** A Lumi test-buy of this endpoint in the last 7 days that returned no data confirms a contributed negative. */
  async function lumiRebuyNegative(endpoint: string, t: number) {
    if (!deps.catalogStore) return false;
    const buys = await deps.catalogStore.buysFor(urlVariants(endpoint)).catch(() => []);
    return buys.some((b: any) => b.ts > t - 7 * DAY_MS && b.data_returned === false && !b.inconclusive && b.http_status != null && b.http_status !== 0);
  }

  async function dispute(raw: string): Promise<Response> {
    let b: any;
    try { b = JSON.parse(raw); } catch { return err(400, "invalid_json"); }
    const tx = String(b?.tx_hash ?? ""), reason = String(b?.reason ?? "").slice(0, 500), s = b?.signer ?? {};
    const sub = await store.byTx(tx);
    if (!sub) return err(404, "not_found");
    const msg = disputeMessage(tx, await sha256Hex(reason));
    let ok = false;
    if (s.key_type === "ripple-keypairs") ok = verifyXrplSignature(msg, String(s.signature ?? ""), String(s.public_key ?? "")) && xrplAddressOf(String(s.public_key ?? "")) === sub.pay_to;
    else if (s.key_type === "eip191") ok = recoverEvmSigner(msg, String(s.signature ?? "")) === sub.pay_to.toLowerCase();
    else if (s.key_type === "stellar-ed25519") ok = sub.pay_to === s.address && verifyStellarSignature(msg, String(s.signature ?? ""), sub.pay_to);
    if (!ok) return err(401, "seller_signature_invalid", { message_to_sign: msg, signer_must_be: "the pay_to of the disputed receipt" });
    if (sub.dispute) return json(200, { disputed: true, already: true }, noStore);
    await write([{ op: "finding", tx_hash: tx, finding: "disputed", dispute: JSON.stringify({ at: iso(now()), reason, by: sub.pay_to }) }]);
    return json(202, { disputed: true, tx_hash: tx, note: "The contributed finding is held until a person at Lumi reviews it." }, noStore);
  }

  // ---------------------------------------------------- owner

  async function issue(raw: string): Promise<Response> {
    let b: any;
    try { b = JSON.parse(raw); } catch { return err(400, "invalid_json"); }
    const label = String(b?.label ?? "").trim().slice(0, 80);
    const pk = String(b?.public_key ?? "").toLowerCase();
    const wallets: string[] = Array.isArray(b?.wallets) ? [...new Set(b.wallets.map((x: unknown) => normWallet(String(x))))].slice(0, 10) as string[] : [];
    const own: string[] = Array.isArray(b?.own_domains) ? b.own_domains.map((d: unknown) => String(d).toLowerCase().trim()).filter(Boolean).slice(0, 20) : [];
    if (!label) return err(400, "label_required");
    if (!HEX64.test(pk)) return err(400, "public_key_invalid", { hint: "ed25519 public key, 64 hex" });
    if (!wallets.length || !wallets.every(validWallet)) return err(400, "wallets_invalid");
    const existing = await store.wallets(wallets);
    for (const w of existing) {
      const ok = await store.getKey(w.key_id);
      if (ok && (ok.status === "active" || ok.forfeited)) return err(409, ok.forfeited ? "wallet_forfeited" : "wallet_registered_to_other_key", { wallet: w.address });
    }
    // Wallet-control proof: each wallet signs walletProofMessage(public_key, address). Without one the key would let
    // anyone list someone else's busy wallet. allow_unproven (owner, explicit) registers it with zero weight.
    const proofs = b?.wallet_proofs && typeof b.wallet_proofs === "object" ? b.wallet_proofs : {};
    const proven = new Map(wallets.map((a) => [a, verifyWalletProof(pk, a, proofs[a] ?? proofs[a.toLowerCase()])]));
    const missing = wallets.filter((a) => !proven.get(a));
    if (missing.length && b?.allow_unproven !== true) {
      return err(400, "wallet_proof_required", { wallets: missing.map((a) => ({ address: a, message_to_sign: walletProofMessage(pk, a) })), hint: "lumi-scan prove-wallet --network <net> (signs with the wallet key locally). allow_unproven: true registers the wallet with zero weight." });
    }
    const key_id = "lck_" + randomHex(8);
    const rows: WalletRow[] = [];
    for (const a of wallets) {
      const f = b?.funders?.[a] ? { funder: normWallet(String(b.funders[a])), funded_at: null } : await funding(a);
      let source = a;
      if (f.funder && !ignore.has(f.funder)) {
        const [up] = await store.wallets([f.funder]);
        source = up?.source ?? rows.find((x) => x.address === f.funder)?.source ?? f.funder;
      }
      rows.push({ address: a, key_id, funder: f.funder, funded_at: f.funded_at, source, proven: proven.get(a) === true });
    }
    // Wallets registered earlier with this one as their source now join its upstream cluster.
    for (const w of rows) if (w.source !== w.address) await store.resource(w.address, w.source);
    const k: ContributorKey = {
      key_id, label, public_key: pk, wallets, own_domains: own, daily_cap: Number.isInteger(b?.daily_cap) ? b.daily_cap : null,
      share_demand: b?.share_demand === true, status: "active", forfeited: false, created_at: now(), revoked_at: null, revoke_reason: null,
    };
    await store.issue(k, rows);
    deps.log?.({ event: "contrib_key_issued", key_id });
    return json(201, { ...k, funding: rows.map(({ address, funder, source, proven: pv }) => ({ address, funder, source, proven: !!pv })), ...(missing.length ? { unproven_wallets: missing, note: "Unproven wallets are registered with zero weight until a proof is sent to /v1/contrib/me/wallet-proof." } : {}) }, noStore);
  }

  async function ownerRoutes(req: Request, path: string, raw: string): Promise<Response> {
    if (!(await ownerOk(req))) return json(401, { error: "owner_key_required", hint: deps.adminKey ? "Authorization: Bearer <CONTRIB_ADMIN_KEY>" : "Authorization: Bearer <CONTRIB_ADMIN_KEY or OWNER_MCP_KEY>" }, { ...noStore, "WWW-Authenticate": "Bearer" });
    const m = req.method, u = new URL(req.url);
    if (path === "/v1/owner/contributors" && m === "POST") return issue(raw);
    if (path === "/v1/owner/contributors" && m === "GET") {
      const [keys, tot] = await Promise.all([store.listKeys(), store.totals()]);
      const by = new Map(tot.map((x) => [x.key_id, x]));
      return json(200, {
        keys: keys.map((k) => {
          const t = by.get(k.key_id);
          return creditsOn
            ? { ...k, submissions: t?.n ?? 0, credits_usd: (t?.credit_uusd ?? 0) / 1e6, credits_month_usd: (t?.month_uusd ?? 0) / 1e6, credits_state: k.forfeited ? "forfeited" : "earned_unpaid" }
            : { ...k, submissions: t?.n ?? 0, credits_state: "disabled" };
        }),
        rules: { credits_enabled: creditsOn, ...(creditsOn ? { credits: CREDITS } : {}), caps: CAPS, min_kit_version: minKit, retired_kit_versions: [...retired], formats: ACCEPTED_FORMATS, retention_days: CONTRIB_RETENTION_DAYS },
        note: creditsOn ? "Credits are API credits, not cash. There is no payout code." : "Cash bounties are disabled: rewards are free Lumi Check credits, badges, the leaderboard and perks. There is no payout code.",
      }, noStore);
    }
    if (path === "/v1/owner/contributors/clusters" && m === "GET") {
      return json(200, { clusters: await store.clusters(), note: "Funding sources shared by wallets of more than one key. Receipts from one cluster earn once per seller per UTC day." }, noStore);
    }
    if (path === "/v1/owner/contributors/flags" && m === "GET") {
      const rows = await store.since(dayOf(now() - 7 * DAY_MS), 5000);
      const by = new Map<string, Submission[]>();
      for (const r of rows) by.set(r.endpoint_key, [...(by.get(r.endpoint_key) ?? []), r]);
      const flags = [...by.values()].map((l) => ({ endpoint: l[0].endpoint, ...boostFlag(l) })).filter((x) => "flag" in x && x.flag);
      return json(200, { window_days: 7, flags }, noStore);
    }
    if (path === "/v1/owner/contributors/demand" && m === "GET") {
      const days = Math.min(90, Math.max(1, Number(u.searchParams.get("days") ?? 30) || 30));
      const rows = (await store.since(dayOf(now() - days * DAY_MS), 20000)).filter((r) => r.demand_opt_in && r.mode === "passive");
      const by = new Map<string, { keys: Set<string>; n: number; networks: Set<string> }>();
      for (const r of rows) {
        const d = r.domain ?? "unknown", e = by.get(d) ?? { keys: new Set(), n: 0, networks: new Set() };
        e.keys.add(r.key_id); e.n++; e.networks.add(r.network); by.set(d, e);
      }
      const out = [...by.entries()].filter(([, e]) => e.keys.size >= CAPS.demand_min_contributors)
        .map(([domain, e]) => ({ domain, purchases: e.n, contributors: e.keys.size, networks: [...e.networks].sort() })).sort((a, b) => b.purchases - a.purchases);
      return json(200, { window_days: days, rows: out, privacy: `Opt-in contributors only; domains with fewer than ${CAPS.demand_min_contributors} contributors are withheld; no key ids or wallets.` }, noStore);
    }
    if (path === "/v1/owner/contributors/purge" && m === "POST") return json(200, await purge(), noStore);
    if (path === "/v1/owner/contributors/inactive" && m === "GET") return json(200, await inactiveReview(), noStore);
    if (path === "/v1/owner/contributors/reconcile" && m === "POST") {
      const rows = (await store.since(dayOf(now() - 7 * DAY_MS), 5000)).filter((r) => r.finding === "unconfirmed");
      const ops: WriteOp[] = [];
      for (const r of rows) if (await lumiRebuyNegative(r.endpoint, now())) ops.push({ op: "finding", tx_hash: r.tx_hash, finding: "confirmed" });
      await write(ops);
      return json(200, { checked: rows.length, confirmed: ops.length }, noStore);
    }
    let mm = /^\/v1\/owner\/contributors\/findings\/([0-9A-Fa-fx]{64,66})$/.exec(path);
    if (mm && m === "POST") {
      const sub = await store.byTx(mm[1]);
      if (!sub) return err(404, "not_found");
      let b: any; try { b = JSON.parse(raw || "{}"); } catch { return err(400, "invalid_json"); }
      const act = String(b?.action ?? "");
      if (act === "mark_published") {
        await store.markPublished(sub.tx_hash, now());
        return json(200, { tx_hash: sub.tx_hash, published: true }, noStore);
      }
      const next: Record<string, Finding> = { confirm: "confirmed", contradict: "contradicted", clear_dispute: isNegative(sub.outcome) ? "unconfirmed" : "counted", uphold_dispute: "contradicted", release_hold: isNegative(sub.outcome) ? "unconfirmed" : "counted" };
      if (!next[act]) return err(400, "action_invalid", { allowed: [...Object.keys(next), "mark_published"] });
      await write([{ op: "finding", tx_hash: sub.tx_hash, finding: next[act] }]);
      return json(200, { tx_hash: sub.tx_hash, finding: next[act] }, noStore);
    }
    if (path === "/v1/owner/contributors/delete" && m === "POST") {
      let b: any; try { b = JSON.parse(raw || "{}"); } catch { return err(400, "invalid_json"); }
      if (b?.confirm !== true) return err(400, "confirm_true_required");
      let id = typeof b?.key_id === "string" ? b.key_id : "";
      if (!id && typeof b?.wallet === "string") id = (await store.wallets([b.wallet.trim()]))[0]?.key_id ?? "";
      if (!/^lck_[0-9a-f]{16}$/.test(id)) return err(404, "not_found");
      const r = await eraseAccount(id, "owner");
      if (!r.found) return err(404, "not_found");
      return json(200, { ...r, request_ref: typeof b?.request_ref === "string" ? b.request_ref.slice(0, 200) : null }, noStore);
    }
    mm = /^\/v1\/owner\/contributors\/(lck_[0-9a-f]{16})\/revoke$/.exec(path);
    if (mm && m === "POST") {
      let b: any; try { b = JSON.parse(raw || "{}"); } catch { return err(400, "invalid_json"); }
      const ok = await store.revoke(mm[1], now(), String(b?.reason ?? "revoked by owner").slice(0, 200), b?.forfeit === true);
      if (!ok) return err(404, "not_found");
      deps.log?.({ event: "contrib_key_revoked", key_id: mm[1], forfeit: b?.forfeit === true });
      return json(200, { key_id: mm[1], status: "revoked", forfeited: b?.forfeit === true }, noStore);
    }
    mm = /^\/v1\/owner\/contributors\/(lck_[0-9a-f]{16})\/submissions$/.exec(path);
    if (mm && m === "GET") {
      const n = Math.min(200, Math.max(1, Number(u.searchParams.get("limit") ?? 50) || 50));
      return json(200, { submissions: (await store.recentByKey(mm[1], n)).map(publicRow) }, noStore);
    }
    return err(404, "not_found");
  }

  const publicRow = (s: Submission) => ({
    tx_hash: s.tx_hash, day: s.day, mode: s.mode, endpoint: s.endpoint, network: s.network, asset: s.asset, amount: s.amount, outcome: s.outcome,
    finding: s.finding, ...(creditsOn ? { credit_usd: s.credit_uusd / 1e6, credit_note: s.credit_note } : {}), kit_version: s.kit_version, disputed: !!s.dispute,
    metrics: s.metrics ? JSON.parse(s.metrics) : null,
  });

  async function handle(req: Request, path: string): Promise<Response | null> {
    const isContrib = path.startsWith("/v1/contrib/");
    const isOwner = path === "/v1/owner/contributors" || path.startsWith("/v1/owner/contributors/");
    if (!isContrib && !isOwner) return null;
    const len = Number(req.headers.get("Content-Length") ?? "0");
    if (len > 24_000) return err(413, "too_large");
    const raw = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
    if (raw.length > 24_000) return err(413, "too_large");
    if (isOwner) return ownerRoutes(req, path, raw);
    if (path === "/v1/contrib/disputes" && req.method === "POST") return dispute(raw);
    if (path === "/v1/contrib/bounties" && (req.method === "GET" || req.method === "HEAD")) {
      return json(200, { kind: "contributor_bounties", ...CONTRIB_BOUNTIES, wanted: [], note: "Disabled. Planned after revenue: a wanted list of fixed bounties for testing specific sellers, paid from a capped budget. Nothing pays out today; rewards are free Lumi Check credits, badges and the leaderboard." }, noStore);
    }
    if (path === "/v1/contrib/leaderboard" && (req.method === "GET" || req.method === "HEAD")) {
      const rows = (await leaderboard()).slice(0, 50).map(({ key_id: _k, ...r }) => r);
      return json(200, {
        kind: "contributor_leaderboard", window_days: CONTRIB_RETENTION_DAYS, rows, badges: CONTRIB_BADGES,
        counts: "Verified receipts only: on-ledger payment checked, finding counted or confirmed, at most one per endpoint per UTC day per contributor. Held, disputed and contradicted receipts do not count.",
        note: "Badges and rank (plus free Lumi Check credits, shown to each contributor only). No cash. Paying Lumi never changes a rank or badge. Contributors appear under a pseudonymous handle.",
      }, { "Cache-Control": "public, max-age=300" });
    }
    const a = await authContributor(req, raw);
    if (!a.ok) return a.res;
    const key = a.key, u = new URL(req.url);
    if (path === "/v1/contrib/submissions" && req.method === "POST") return submit(req, raw, key);
    if (path === "/v1/contrib/wanted" && req.method === "GET") {
      const limit = Math.min(10, Math.max(1, Number(u.searchParams.get("limit") ?? 5) || 5));
      const net = u.searchParams.get("network") ?? undefined;
      return json(200, {
        wanted: await wantedFor(key, limit, net), default_mode: "passive",
        note: "Optional. Passive receipts for purchases you already make need no extra spend. Test-buys use your own wallet within your own caps.",
      }, noStore);
    }
    if (path === "/v1/contrib/me" && req.method === "GET") {
      const t = now();
      const c = await store.counts({ key_id: key.key_id, endpoint_key: "-", source: "-", day: dayOf(t), since_recent: dayOf(t), since_month: monthStart(t), tx_hash: "-" });
      return json(200, {
        key_id: key.key_id, label: key.label, status: key.status, share_demand: key.share_demand, wallets: key.wallets,
        today: { accepted: c.key_day, cap: key.daily_cap ?? CAPS.key_daily },
        ...(creditsOn ? { credits_month_usd: c.month_credit / 1e6, credits_month_cap_usd: CREDITS.monthly_cap_uusd / 1e6 } : { rewards: "check_credits_badges_leaderboard" }),
        ...(await standing(key.key_id)),
        check_credits: (({ spends: _s, ...b }) => b)(await creditBalance(key)),
        submissions: (await store.recentByKey(key.key_id, 50)).map(publicRow),
        note: creditsOn ? "Your own submissions only. Credits are Lumi API credits, not cash." : "Your own submissions only. Rewards are free Lumi Check credits, badges, leaderboard rank, early access and higher rate limits. No cash.",
      }, noStore);
    }
    if (path === "/v1/contrib/credits" && req.method === "GET") return json(200, await creditBalance(key), noStore);
    if (path === "/v1/contrib/credits/spend" && req.method === "POST") return spendCredits(req, raw, key);
    if (path === "/v1/contrib/me" && req.method === "DELETE") {
      let b: any; try { b = JSON.parse(raw || "{}"); } catch { return err(400, "invalid_json"); }
      if (b?.confirm !== key.key_id) return err(400, "confirm_key_id_required", { hint: "Send { confirm: \"<your key_id>\" } to delete this account. This cannot be undone." });
      return json(200, await eraseAccount(key.key_id, "contributor"), noStore);
    }
    if (path === "/v1/contrib/me/wallet-proof" && req.method === "POST") {
      let b: any; try { b = JSON.parse(raw); } catch { return err(400, "invalid_json"); }
      const addr = normWallet(String(b?.address ?? ""));
      if (!key.wallets.map(normWallet).includes(addr)) return err(403, "wallet_not_registered_to_key");
      if (!verifyWalletProof(key.public_key, addr, b)) return err(401, "wallet_proof_invalid", { message_to_sign: walletProofMessage(key.public_key, addr) });
      await store.setProven(addr, key.key_id);
      return json(200, { address: addr, proven: true, note: "Receipts from this wallet count from now on. Earlier zero-weight receipts stay zero-weight." }, noStore);
    }
    if (path === "/v1/contrib/me" && req.method === "POST") {
      let b: any; try { b = JSON.parse(raw); } catch { return err(400, "invalid_json"); }
      if (typeof b?.share_demand !== "boolean") return err(400, "share_demand_boolean_required");
      await store.setShareDemand(key.key_id, b.share_demand);
      return json(200, { share_demand: b.share_demand }, noStore);
    }
    return err(404, "not_found");
  }

  // ---------------------------------------------------- rewards: badges + leaderboard (no cash)

  async function leaderboard() {
    const [rows, keys] = await Promise.all([store.since(dayOf(now() - CONTRIB_RETENTION_DAYS * DAY_MS), 50_000), store.listKeys()]);
    const active = new Set(keys.filter((k) => k.status === "active" && !k.forfeited).map((k) => k.key_id));
    const by = new Map<string, { seen: Set<string>; verified: number; confirmed: number; endpoints: Set<string> }>();
    for (const r of rows) {
      if (!active.has(r.key_id) || !weighs(r)) continue;
      const e = by.get(r.key_id) ?? { seen: new Set(), verified: 0, confirmed: 0, endpoints: new Set() };
      const slot = `${r.endpoint_key}:${r.day}`;
      if (!e.seen.has(slot)) { e.seen.add(slot); e.verified++; if (r.finding === "confirmed") e.confirmed++; e.endpoints.add(r.endpoint_key); }
      by.set(r.key_id, e);
    }
    const list = await Promise.all([...by.entries()].map(async ([key_id, e]) => ({
      key_id, handle: "contrib-" + (await sha256Hex("lumi-handle:" + key_id)).slice(0, 8), verified_receipts: e.verified, confirmed_findings: e.confirmed, endpoints: e.endpoints.size,
      badges: badgesFor(e.verified, e.confirmed),
    })));
    list.sort((a, b) => b.verified_receipts - a.verified_receipts || b.endpoints - a.endpoints || a.handle.localeCompare(b.handle));
    return list.map((x, i) => ({ rank: i + 1, ...x }));
  }
  function badgesFor(verified: number, confirmed: number) {
    const out: string[] = CONTRIB_BADGES.filter((b) => verified >= b.min).map((b) => b.id);
    if (confirmed > 0) out.push("confirmed_finding");
    return out;
  }
  async function standing(key_id: string) {
    const me = (await leaderboard()).find((x) => x.key_id === key_id);
    return { leaderboard: me ? { rank: me.rank, handle: me.handle, verified_receipts: me.verified_receipts } : { rank: null, verified_receipts: 0 }, badges: me?.badges ?? [] };
  }

  // ---------------------------------------------------- free Lumi Check credits (no cash)

  /** Expiry boundary: lots earned before this UTC day have expired. */
  const creditSince = () => dayOf(now() - CHECK_CREDIT_EXPIRY_DAYS * DAY_MS);

  /**
   * Credit lots: one per unique (seller, UTC day) with a verified, undisputed finding, worth perReceipt, expiring
   * CHECK_CREDIT_EXPIRY_DAYS after that day. Spends record which lots they consumed (oldest first); balance = what is left
   * in unexpired lots. Spends without an allocation (older rows) are allocated oldest-first here.
   */
  async function creditLedger(key: ContributorKey) {
    const since = creditSince();
    const [rows, spends] = await Promise.all([store.verifiedSince(key.key_id, since), store.spendsSince(key.key_id, since)]);
    const lots = new Map<string, { lot: string; day: string; value: number; used: number }>();
    if (!key.forfeited) for (const r of rows) {
      if (!weighs(r) || r.day < since) continue;
      const lot = `${(r.domain || r.pay_to || "?").toLowerCase()}:${r.day}`;
      if (!lots.has(lot)) lots.set(lot, { lot, day: r.day, value: perReceipt, used: 0 });
    }
    const ordered = [...lots.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.lot.localeCompare(b.lot)));
    let unallocated = 0;
    for (const sp of [...spends].sort((a, b) => a.ts - b.ts)) {
      if (sp.alloc?.length) { for (const a of sp.alloc) { const l = lots.get(a.lot); if (l) l.used += a.n; } continue; }
      let left = sp.cost;
      for (const l of ordered) { if (left <= 0) break; const take = Math.min(left, Math.max(0, l.value - l.used)); l.used += take; left -= take; }
      unallocated += left;
    }
    return { since, lots: ordered, spends, overdrawn: ordered.some((l) => l.used > l.value) || unallocated > 0 };
  }

  /** Oldest-first allocation of `cost` across unexpired lots; null if the balance is short. */
  function allocate(lots: { lot: string; value: number; used: number }[], cost: number): CreditAlloc[] | null {
    const out: CreditAlloc[] = [];
    let left = cost;
    for (const l of lots) { if (left <= 0) break; const take = Math.min(left, Math.max(0, l.value - l.used)); if (take > 0) { out.push({ lot: l.lot, n: take }); left -= take; } }
    return left > 0 ? null : out;
  }

  async function creditBalance(key: ContributorKey) {
    const L = await creditLedger(key);
    const balance = L.lots.reduce((a, l) => a + Math.max(0, l.value - l.used), 0);
    const earned = L.lots.reduce((a, l) => a + l.value, 0);
    const spent = L.spends.reduce((a, x) => a + x.cost, 0);
    const expiryOf = (day: string) => dayOf(Date.parse(day + "T00:00:00Z") + (CHECK_CREDIT_EXPIRY_DAYS + 1) * DAY_MS);
    const live = L.lots.filter((l) => l.value - l.used > 0);
    const soonDay = dayOf(now() + 7 * DAY_MS);
    return {
      kind: "lumi_check_credits", key_id: key.key_id, balance, earned, spent,
      earning_slots: L.lots.length, per_verified_receipt: perReceipt, prices, expires_after_days: CHECK_CREDIT_EXPIRY_DAYS,
      next_expiry: live.length ? { on: expiryOf(live[0].day), credits: live.filter((l) => l.day === live[0].day).reduce((a, l) => a + l.value - l.used, 0) } : null,
      expiring_within_7_days: live.filter((l) => expiryOf(l.day) <= soonDay).reduce((a, l) => a + l.value - l.used, 0),
      perks: { early_access: L.lots.length > 0, higher_rate_limit: L.lots.length > 0 ? { checks_per_minute: CONTRIB_PERK_CHECKS_PER_MINUTE } : null },
      spends: L.spends.slice(0, 20).map(({ key_id: _k, alloc: _a, ...x }) => x),
      rule: `One earning per seller per UTC day per contributor, for verified receipts only. Self-dealt, duplicate, held, disputed or contradicted receipts earn nothing. Credits are not cash, cannot be transferred or sold, are spent oldest first, and unused credits expire ${CHECK_CREDIT_EXPIRY_DAYS} days after they were earned.`,
    };
  }

  async function spendCredits(req: Request, raw: string, key: ContributorKey): Promise<Response> {
    let b: any; try { b = JSON.parse(raw); } catch { return err(400, "invalid_json"); }
    const product = b?.product as CreditProduct;
    if (!(product in prices)) return err(400, "unknown_product", { products: prices });
    if (!deps.redeem) return err(503, "redeem_unavailable");
    const input: Record<string, string> = {};
    for (const [k, v] of Object.entries(b?.input ?? {})) if (typeof v === "string" || typeof v === "number") input[k] = String(v).slice(0, 500);
    const cost = prices[product];
    const L = await creditLedger(key);
    const balanceBefore = L.lots.reduce((a, l) => a + Math.max(0, l.value - l.used), 0);
    const alloc = allocate(L.lots, cost);
    if (!alloc) return err(402, "insufficient_credits", { balance: balanceBefore, cost, hint: "Earn free Lumi Check credits with verified receipts, or pay with x402 as usual." });
    const t = now();
    const id = `spend_${t.toString(36)}_${(await sha256Hex(key.key_id + ":" + raw + ":" + Math.random())).slice(0, 10)}`;
    // Reserve first, then re-check (concurrent spends cannot overdraw a lot: the loser is rolled back).
    await store.addSpend({ id, key_id: key.key_id, ts: t, day: dayOf(t), product, cost, ref: null, alloc });
    if ((await creditLedger(key)).overdrawn) { await store.deleteSpend(id); return err(402, "insufficient_credits", { balance: balanceBefore, cost }); }
    let out: Awaited<ReturnType<NonNullable<ContributorDeps["redeem"]>>>;
    try { out = await deps.redeem(product, input, new URL(req.url).origin); } catch { out = { ok: false, status: 503, error: { error: "data_unavailable" } }; }
    if (!out.ok) { await store.deleteSpend(id); return json(out.status, { ...out.error, note: "No credits were spent." }, noStore); }
    deps.log?.({ event: "contrib_credit_spend", product, cost }); // no key id, no query
    return json(200, { ...out.body, lumi_credits: { spent: cost, balance: balanceBefore - cost, spend_id: id, note: "Paid with free Lumi Check credits. Credits never change a score, tier, ranking or badge." } }, noStore);
  }

  /** Activity for account retention: a signed check counts, recorded at most once per key per UTC day. */
  const touched = new Map<string, string>();
  async function touchActive(key: ContributorKey) {
    const d = dayOf(now());
    if (touched.get(key.key_id) === d || (key.last_active_day ?? "") >= d) return;
    touched.set(key.key_id, d);
    if (touched.size > 10_000) touched.clear();
    await store.touch(key.key_id, d).catch(() => {});
  }
  const activeSince = () => dayOf(now() - CONTRIB_ACTIVE_WINDOW_DAYS * DAY_MS);
  const isActive = (k: ContributorKey) => k.status === "active" && (k.last_active_day ?? dayOf(k.created_at)) >= activeSince();

  /** PLACEHOLDER (flagged for Bobby): lists inactive keys only. Deletes, revokes and notifies nothing. Owner route only, never the cron. */
  async function inactiveReview() {
    const keys = await store.listKeys();
    const inactive = keys.filter((k) => k.status === "active" && !isActive(k)).map((k) => ({ key_id: k.key_id, last_active_day: k.last_active_day ?? null, created_day: dayOf(k.created_at) }));
    return { kind: "contributor_inactive_review", active_window_days: CONTRIB_ACTIVE_WINDOW_DAYS, active_since: activeSince(), total_keys: keys.length, active: keys.filter(isActive).length, inactive, action: "none (placeholder: nothing is deleted, revoked or sent)" };
  }

  /** Higher /v1/check rate limit for contributors with a verified receipt (signed request). null = not a contributor request. */
  async function checkPerk(req: Request): Promise<{ ok: true } | { ok: false; res: Response } | null> {
    if (!req.headers.get("Lumi-Contributor-Key")) return null;
    const a = await authContributor(req, "");
    if (!a.ok) return null; // fall back to the anonymous free limit
    await touchActive(a.key);
    const bal = await creditBalance(a.key);
    if (!bal.perks.higher_rate_limit) return null;
    const t = now(), m = perkMinute.get(a.key.key_id);
    if (m && t - m.at < 60_000) { if (++m.n > CONTRIB_PERK_CHECKS_PER_MINUTE) return { ok: false, res: err(429, "rate_limited", { limit_per_minute: CONTRIB_PERK_CHECKS_PER_MINUTE }) }; }
    else perkMinute.set(a.key.key_id, { at: t, n: 1 });
    return { ok: true };
  }

  /** Retention: drop submissions older than CONTRIB_RETENTION_DAYS (run from the cron and the owner route). */
  async function purge() {
    const before = dayOf(now() - CONTRIB_RETENTION_DAYS * DAY_MS);
    const deleted = await store.purge(before);
    deps.log?.({ event: "contrib_purge", deleted });
    return { retention_days: CONTRIB_RETENTION_DAYS, before_day: before, deleted, accounts: `kept while active (receipt or signed check within ${CONTRIB_ACTIVE_WINDOW_DAYS} days); never purged here` };
  }

  /** Queue consumer for lumi-contrib-writes: every message's ops in ONE D1 batch. */
  async function consume(bodies: any[]) {
    let ops: WriteOp[] = bodies.flatMap((b) => (b?.kind === "contrib_write" && Array.isArray(b.ops) ? b.ops : []));
    // A queued insert must not resurrect data for a key revoked or deleted after it was accepted.
    const ids = [...new Set(ops.flatMap((o) => (o.op === "insert" ? [o.row.key_id] : [])))];
    const live = new Set<string>();
    for (const id of ids) if ((await store.getKey(id))?.status === "active") live.add(id);
    const dropped = ops.filter((o) => o.op === "insert" && !live.has(o.row.key_id));
    for (const o of dropped) if (o.op === "insert") pending.delete(o.row.tx_hash);
    ops = ops.filter((o) => !(o.op === "insert" && !live.has(o.row.key_id)));
    if (!ops.length) return 0;
    const rows = await flush(ops);
    for (const o of ops) if (o.op === "insert") pending.delete(o.row.tx_hash);
    return rows;
  }

  return { handle, consume, purge, leaderboard, checkPerk, inactiveReview, rules: { credits: CREDITS, caps: CAPS, credits_enabled: creditsOn, cash_bounties: CONTRIB_BOUNTIES, check_credits: { per_verified_receipt: perReceipt, prices, expires_after_days: CHECK_CREDIT_EXPIRY_DAYS }, retention_days: CONTRIB_RETENTION_DAYS, active_window_days: CONTRIB_ACTIVE_WINDOW_DAYS }, _boostFlag: boostFlag, _credit: credit };
}
export type Contributors = ReturnType<typeof createContributors>;
