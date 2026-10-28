/**
 * Free wallet check (GET /v1/wallet/check?address=): which x402 sellers did this public wallet pay, and what has Lumi seen
 * of each one? Owner approved building it on a branch, 2026-10-28 (not deployed).
 *
 * Sources (public data only, cheap reads):
 *  - Base (0x...): Lumi's own index of public Base USDC Transfer logs INTO payTos listed in the CDP x402 Bazaar
 *    (base_inflow, recorded going forward from the index start). One indexed read by payer; no explorer, no archive RPC.
 *  - XRP Ledger (r...): one account_tx page (latest 200 transactions) from a public rippled server.
 *  - Stellar (G...): one Horizon /payments page (latest 200 operations).
 * Only outgoing payments of the queried wallet are read. Recipients are matched to Lumi's records (catalog listings and
 * curated sellers); recipients Lumi has no x402 record of are only counted, never listed (they may be personal transfers).
 *
 * Privacy rules (tested in test/wallet_check.test.ts):
 *  - The queried wallet is never stored and never logged by this module (normal request logs only).
 *  - Payments to Lumi's own wallets are never listed or counted: no Lumi customer payer data, no Lumi income.
 *  - Nothing about other payers of a seller and nothing about a seller's income: only this wallet's own outgoing payments.
 *  - Payer data older than 90 days is not shown (the payer-data retention rule).
 * Not in this version: "paid more than an equivalent seller" comparisons (not reliable enough). Paid extras (weekly
 * reports, alerts, longer history) are reserved and not built.
 */
import { rpcAny, RIPPLE_EPOCH, assetOfIou, XRPL_ADDR_RE, EVM_ADDR_RE, STELLAR_ADDR_RE, STELLAR_USDC_ISSUER } from "./verify";
import type { InflowRow } from "./evidence";

export const WALLET_CHECK_VERSION = "1";
export const WALLET_RETENTION_DAYS = 90;
/** Most distinct recipients matched against Lumi's records per call (each match is one lookup). */
export const WALLET_MAX_SELLERS = 15;
/** Two payments to the same recipient, same amount and asset, this close together: flagged as a possible duplicate. */
/** Most recipients looked up per call (busy wallets: the rest are counted as not checked). */
export const WALLET_MAX_LOOKUPS = 40;
export const DUPLICATE_WINDOW_MS = 120_000;
export const WALLET_COMING_LATER = ["weekly reports", "alerts", "longer history"] as const;

export type WalletChain = "base" | "xrpl" | "stellar";
export const CHAIN_NETWORK: Record<WalletChain, string> = { base: "eip155:8453", xrpl: "xrpl:0", stellar: "stellar:pubnet" };

export function chainOf(address: string): WalletChain | null {
  const a = address.trim();
  if (EVM_ADDR_RE.test(a)) return "base";
  if (XRPL_ADDR_RE.test(a)) return "xrpl";
  if (STELLAR_ADDR_RE.test(a)) return "stellar";
  return null;
}

/** One outgoing payment (live chains), or one aggregate row (Base index). */
export interface OutPayment { to: string; at: number; amount: string | null; asset: string; tx: string | null }
export interface Recipient {
  to: string;
  payments: number;
  first_at: number;
  last_at: number;
  last_tx: string | null;
  /** Totals per asset (this wallet's own spend to this recipient), decimal strings. */
  amounts: Record<string, string>;
  possible_duplicates: number;
}
export interface ReadResult { source: string; window: string; complete: boolean; error?: string; payments: OutPayment[]; aggregates?: Recipient[] }

const add = (a: string | undefined, b: string | null) => {
  if (b == null) return a ?? "0";
  const x = Number(a ?? 0) + Number(b);
  return Number.isFinite(x) ? String(Math.round(x * 1e6) / 1e6) : a ?? "0";
};

/** Group live payments by recipient; duplicates = same recipient, amount and asset within DUPLICATE_WINDOW_MS. */
export function groupPayments(ps: OutPayment[]): Recipient[] {
  const m = new Map<string, OutPayment[]>();
  for (const p of ps) { const k = p.to; (m.get(k) ?? m.set(k, []).get(k)!).push(p); }
  const out: Recipient[] = [];
  for (const [to, xs] of m) {
    xs.sort((a, b) => a.at - b.at);
    let dup = 0;
    for (let i = 1; i < xs.length; i++) {
      const a = xs[i - 1], b = xs[i];
      if (b.at - a.at <= DUPLICATE_WINDOW_MS && a.amount != null && a.amount === b.amount && a.asset === b.asset) dup++;
    }
    const amounts: Record<string, string> = {};
    for (const p of xs) amounts[p.asset] = add(amounts[p.asset], p.amount);
    out.push({ to, payments: xs.length, first_at: xs[0].at, last_at: xs[xs.length - 1].at, last_tx: xs[xs.length - 1].tx, amounts, possible_duplicates: dup });
  }
  return out.sort((a, b) => b.last_at - a.last_at);
}

/** Base: Lumi's index rows for this payer (aggregated per payTo), inside the retention window. */
export function recipientsFromInflow(rows: InflowRow[], since: number): Recipient[] {
  return rows.filter((r) => r.last_ts >= since).map((r) => ({
    to: r.pay_to, payments: r.n, first_at: r.first_ts, last_at: r.last_ts, last_tx: r.last_tx ?? null,
    amounts: { USDC: String(Math.round(Number(r.units)) / 1e6) }, possible_duplicates: 0,
  })).sort((a, b) => b.last_at - a.last_at);
}

/** XRPL: one account_tx page (latest 200), successful Payments sent BY this account. */
export async function readXrpl(f: typeof fetch, rpcs: string[], address: string, since: number): Promise<ReadResult> {
  const window = "the wallet's latest 200 XRP Ledger transactions";
  try {
    const j = await rpcAny(f, rpcs, { method: "account_tx", params: [{ account: address, limit: 200, forward: false, ledger_index_min: -1, ledger_index_max: -1, api_version: 2 }] });
    const r = j?.result ?? j;
    if (!r || r.error) return { source: "XRP Ledger (public rippled account_tx)", window, complete: false, error: r?.error === "actNotFound" ? "account_not_found" : "read_failed", payments: [] };
    const payments: OutPayment[] = [];
    for (const t of (r.transactions ?? []) as any[]) {
      const tx = t?.tx_json ?? t?.tx;
      const meta = t?.meta ?? t?.metaData;
      if (tx?.TransactionType !== "Payment" || tx.Account !== address || !tx.Destination || tx.Destination === address) continue;
      if (meta?.TransactionResult && meta.TransactionResult !== "tesSUCCESS") continue;
      const at = t.close_time_iso ? Date.parse(t.close_time_iso) : typeof tx.date === "number" ? (tx.date + RIPPLE_EPOCH) * 1000 : NaN;
      if (!Number.isFinite(at) || at < since) continue;
      const d = meta?.delivered_amount ?? tx.DeliverMax ?? tx.Amount;
      let amount: string | null = null, asset = "XRP";
      if (typeof d === "string") amount = String(Number(d) / 1e6);
      else if (d && typeof d === "object" && d.currency) { amount = String(d.value ?? ""); asset = assetOfIou(d); }
      payments.push({ to: String(tx.Destination), at, amount, asset, tx: String(t.hash ?? tx.hash ?? "") || null });
    }
    return { source: "XRP Ledger (public rippled account_tx)", window, complete: !r.marker, payments };
  } catch {
    return { source: "XRP Ledger (public rippled account_tx)", window, complete: false, error: "read_failed", payments: [] };
  }
}

/** Stellar: one Horizon payments page (latest 200), payments sent BY this account. */
export async function readStellar(f: typeof fetch, horizon: string, address: string, since: number): Promise<ReadResult> {
  const window = "the wallet's latest 200 Stellar payment operations";
  const source = "Stellar (public Horizon payments)";
  try {
    const r = await f(`${horizon.replace(/\/+$/, "")}/accounts/${address}/payments?order=desc&limit=200`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (r.status === 404) return { source, window, complete: false, error: "account_not_found", payments: [] };
    if (!r.ok) return { source, window, complete: false, error: "read_failed", payments: [] };
    const j: any = await r.json();
    const recs: any[] = j?._embedded?.records ?? [];
    const payments: OutPayment[] = [];
    for (const p of recs) {
      if (p?.transaction_successful === false) continue;
      const at = Date.parse(p?.created_at);
      if (!Number.isFinite(at) || at < since) continue;
      if ((p.type === "payment" || p.type === "path_payment_strict_send" || p.type === "path_payment_strict_receive") && p.from === address && p.to && p.to !== address) {
        const asset = p.asset_type === "native" ? "XLM" : p.asset_code === "USDC" && p.asset_issuer === STELLAR_USDC_ISSUER ? "USDC" : `${p.asset_code}.${p.asset_issuer}`;
        payments.push({ to: String(p.to), at, amount: p.amount != null ? String(p.amount) : null, asset, tx: p.transaction_hash ?? null });
      }
    }
    return { source, window, complete: recs.length < 200, payments };
  } catch {
    return { source, window, complete: false, error: "read_failed", payments: [] };
  }
}

/** "3 payments" / "1 payment". */
const nPay = (n: number) => (n === 1 ? "1 payment" : `${n} payments`);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const day = (t: number) => { const d = new Date(t); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };

export interface WalletFlag { code: string; detail: string }

/**
 * Simple, factual flags for one matched seller. No price comparisons, no judgement words. `entries` are the catalog
 * listings at this payTo (lookup view), `label` the shared check label.
 */
export function sellerFlags(rec: Recipient, entries: any[], label: string | null): WalletFlag[] {
  const flags: WalletFlag[] = [];
  const dead = entries.filter((e) => e?.reachability?.status === "listing_looks_dead" || e?.reachability?.flag === "listing_looks_dead");
  if (dead.length) flags.push({ code: "listing_looks_dead", detail: `Lumi's last 3 checks of ${dead.length === 1 ? "a listing" : `${dead.length} listings`} at this address got no working answer (${dead.slice(0, 3).map((e) => e.resource).join(", ")}).` });
  if (entries.length && entries.every((e) => e?.listed_until)) {
    const last = entries.map((e) => Date.parse(e.listed_until)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    flags.push({ code: "no_longer_listed", detail: `This seller's listings are no longer in the CDP x402 Bazaar${last ? ` (last seen ${day(last)})` : ""}.` });
  }
  if (label === "checks_failed") flags.push({ code: "recent_checks_failed", detail: "Lumi's recent checks of this seller failed (see summary)." });
  if (rec.payments >= 2) flags.push({ code: "repeat_payments", detail: `This wallet paid this address ${rec.payments} times between ${day(rec.first_at)} and ${day(rec.last_at)}.` });
  if (rec.possible_duplicates > 0) flags.push({ code: "possible_duplicate_payment", detail: `${rec.possible_duplicates} payment${rec.possible_duplicates === 1 ? " was" : "s were"} the same amount to this address within ${DUPLICATE_WINDOW_MS / 1000} s of the previous one.` });
  return flags;
}

/** One plain line for the whole answer. Facts only. */
export function walletSummary(chain: WalletChain, sellers: { flags: WalletFlag[]; tested: boolean }[], other: number, more: number): string {
  const net = chain === "base" ? "Base" : chain === "xrpl" ? "XRP Ledger" : "Stellar";
  if (!sellers.length) return `Lumi found no payments from this ${net} wallet to x402 sellers it has a record of in the last ${WALLET_RETENTION_DAYS} days${other ? ` (${other} other recipient${other === 1 ? "" : "s"} not in Lumi's records)` : ""}. No record is not a negative finding.`;
  const n = sellers.length + more;
  const tested = sellers.filter((s) => s.tested).length;
  const flagged = sellers.filter((s) => s.flags.some((f) => f.code !== "repeat_payments")).length;
  return `This ${net} wallet paid ${n} x402 seller${n === 1 ? "" : "s"} Lumi has a record of in the last ${WALLET_RETENTION_DAYS} days; Lumi has test-bought ${tested} of ${sellers.length === n ? n : `the ${sellers.length} shown`}${flagged ? `; ${flagged} ha${flagged === 1 ? "s" : "ve"} a flag (dead or delisted listing, failed checks or a possible duplicate payment)` : ""}. Not a guarantee.`;
}

export const paymentsLine = (r: Recipient) => `${nPay(r.payments)}, last on ${day(r.last_at)}`;
