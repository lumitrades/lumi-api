/**
 * Signed test-buy receipts: `counterparty_delivery_receipt` v0.1 (proposed ARS evidence type).
 *
 * One receipt per Lumi test-buy of a seller. The body is hashed as SHA-256 of its RFC 8785-style canonical JSON
 * (with `receipt_hash` and `signer` removed) and the PAYING wallet signs `lumi-receipt:<network>:<tx_hash>:<receipt_hash>`
 * (XRPL: ripple-keypairs over the UTF-8 hex of the message; Base: EIP-191 personal_sign; Stellar: ed25519 over the UTF-8 message, base64).
 * Signing happens only on the operator box (tools/sign_receipts.ts); the Worker never holds a wallet key. It only verifies
 * and stores receipts, serves them in paid receipt lookups (/v1/trust/receipts), the paid vendor report and paid Feed catalog lookups (not in trust/check), and verifies any receipt for free.
 */
import { recoverEvmSigner, sha256Hex, verifyXrplSignature, verifyStellarSignature, xrplAddressOf, XRPL_ADDR_RE, EVM_ADDR_RE, XRPL_TX_RE, EVM_TX_RE, STELLAR_ADDR_RE, STELLAR_TX_RE } from "./verify";
import type { D1Like } from "../config";
import { dataReturnedView, deliveryState, inconclusiveReason } from "./delivery";

export const RECEIPT_TYPE = "counterparty_delivery_receipt";
export const RECEIPT_VERSION = "ars-evidence/0.1";
export const RECEIPT_OUTCOMES = ["delivered", "no_data", "empty_result", "error_status", "timeout", "wrong_data", "other", "inconclusive"] as const;
export type ReceiptNetwork = "xrpl:0" | "eip155:8453" | "stellar:pubnet";

export interface Receipt {
  type: typeof RECEIPT_TYPE;
  version: typeof RECEIPT_VERSION;
  receipt_id: string;
  issued_at: string;
  issuer: { name: string; methodology_url: string; methodology_version: string };
  seller: { vendor_id?: string; endpoint: string; domain?: string; pay_to: string };
  payment: {
    network: ReceiptNetwork; asset: string; issuer?: string; amount: string; amount_atomic?: number;
    tx_hash: string; payer: string; ledger_result: string; ledger_index?: number; block_number?: number;
  };
  /** data_returned null + outcome "inconclusive": Lumi recorded no HTTP response (Lumi-side); delivery unknown. */
  delivery: { observed_at: string; http_status: number; data_returned: boolean | null; outcome: (typeof RECEIPT_OUTCOMES)[number]; latency_ms?: number; source?: string; inconclusive_reason?: string; note?: string };
  /** A corrected receipt names the receipt it replaces; the old one stays verifiable (receipts_superseded). */
  supersedes?: { receipt_hash: string; reason: string; corrections_url?: string };
  receipt_hash: string;
  signer: { key_type: "ripple-keypairs" | "eip191" | "stellar-ed25519"; address: string; public_key?: string; message: string; signature: string };
}
export type ReceiptBody = Omit<Receipt, "receipt_hash" | "signer">;

/** RFC 8785-style canonical JSON: object keys sorted by UTF-16 code units, no whitespace, undefined members dropped. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error("non-finite number");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return "[" + v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
}

/** SHA-256 hex of the canonical body (receipt_hash and signer removed). */
export async function receiptHash(r: ReceiptBody | Receipt): Promise<string> {
  const { receipt_hash: _h, signer: _s, ...body } = r as Receipt;
  return sha256Hex(canonicalJson(body));
}

export const receiptMessage = (network: string, tx: string, hash: string) => `lumi-receipt:${network}:${tx}:${hash}`;

/** delivery.outcome from a stored test-buy row. */
export function outcomeOf(httpStatus: number | null | undefined, dataReturned: boolean, summary = "", inconclusive?: string | null): Receipt["delivery"]["outcome"] {
  // Guard: no HTTP response recorded = inconclusive (Lumi-side), never no_data / timeout / other.
  if (deliveryState({ http_status: httpStatus, data_returned: dataReturned, inconclusive }) === "inconclusive") return "inconclusive";
  if (dataReturned) return "delivered";
  if (httpStatus == null || httpStatus === 0) return /timeout|timed out|abort/i.test(summary) ? "timeout" : "other";
  if (httpStatus >= 200 && httpStatus < 300) return /empty/i.test(summary) ? "empty_result" : "no_data";
  return "error_status";
}

export interface ReceiptCheck {
  ok: boolean;
  hash_ok: boolean;
  signature_ok: boolean;
  signer_is_payer: boolean;
  errors: string[];
  recomputed_hash?: string;
}

/** Offline checks: shape, hash, signature, signer = payer. No network. */
/**
 * minimalPayment: contributed receipts (Lumi Check tier 2) carry only payment.network and payment.tx_hash. The amount is
 * not required, and the signer-is-payer check moves on-ledger (the caller must confirm the signer sent the tx).
 */
export async function verifyReceipt(r: any, opts: { minimalPayment?: boolean } = {}): Promise<ReceiptCheck> {
  const errors: string[] = [];
  const out: ReceiptCheck = { ok: false, hash_ok: false, signature_ok: false, signer_is_payer: false, errors };
  if (!r || typeof r !== "object") { errors.push("not_an_object"); return out; }
  if (r.type !== RECEIPT_TYPE) errors.push("type");
  if (r.version !== RECEIPT_VERSION) errors.push("version");
  for (const k of ["receipt_id", "issued_at", "issuer", "seller", "payment", "delivery", "receipt_hash", "signer"]) if (r[k] == null) errors.push("missing_" + k);
  if (errors.length) return out;
  // issuer is informational (never trusted for who paid), but it must be well formed.
  const iss = r.issuer;
  if (!iss || typeof iss !== "object" || Array.isArray(iss) || typeof iss.name !== "string" || !iss.name.trim() || iss.name.length > 100) errors.push("issuer");
  const p = r.payment, s = r.signer;
  if (p.network !== "xrpl:0" && p.network !== "eip155:8453" && p.network !== "stellar:pubnet") errors.push("payment.network");
  if (p.network === "stellar:pubnet" && !STELLAR_TX_RE.test(String(p.tx_hash))) errors.push("payment.tx_hash");
  if (p.network === "xrpl:0" && !XRPL_TX_RE.test(String(p.tx_hash))) errors.push("payment.tx_hash");
  if (p.network === "eip155:8453" && !EVM_TX_RE.test(String(p.tx_hash))) errors.push("payment.tx_hash");
  if (!opts.minimalPayment && !/^[0-9]+(\.[0-9]+)?$/.test(String(p.amount))) errors.push("payment.amount");
  if (!RECEIPT_OUTCOMES.includes(r.delivery?.outcome)) errors.push("delivery.outcome");
  if (r.delivery?.outcome === "inconclusive" ? r.delivery?.data_returned !== null : typeof r.delivery?.data_returned !== "boolean") errors.push("delivery.data_returned");
  if (r.supersedes != null && !/^[0-9a-f]{64}$/.test(String(r.supersedes?.receipt_hash))) errors.push("supersedes.receipt_hash");
  if (!/^[0-9a-f]{64}$/.test(String(r.receipt_hash))) errors.push("receipt_hash");
  let hash = "";
  try { hash = await receiptHash(r); } catch { errors.push("canonicalization"); }
  out.recomputed_hash = hash || undefined;
  out.hash_ok = !!hash && hash === r.receipt_hash;
  if (!out.hash_ok) errors.push("hash_mismatch");
  const msg = receiptMessage(p.network, String(p.tx_hash), String(r.receipt_hash));
  if (s.message !== msg) errors.push("signer.message");
  if (s.key_type === "ripple-keypairs") {
    if (p.network !== "xrpl:0") errors.push("key_type_network");
    const pk = String(s.public_key ?? "");
    out.signature_ok = !!pk && verifyXrplSignature(msg, String(s.signature), pk) && xrplAddressOf(pk) === s.address;
    if (!XRPL_ADDR_RE.test(String(s.address))) errors.push("signer.address");
    out.signer_is_payer = s.address === p.payer;
  } else if (s.key_type === "eip191") {
    if (p.network !== "eip155:8453") errors.push("key_type_network");
    const rec = recoverEvmSigner(msg, String(s.signature));
    out.signature_ok = !!rec && EVM_ADDR_RE.test(String(s.address)) && rec === String(s.address).toLowerCase();
    out.signer_is_payer = typeof p.payer === "string" && typeof s.address === "string" && s.address.toLowerCase() === p.payer.toLowerCase();
  } else if (s.key_type === "stellar-ed25519") {
    if (p.network !== "stellar:pubnet") errors.push("key_type_network");
    if (!STELLAR_ADDR_RE.test(String(s.address))) errors.push("signer.address");
    out.signature_ok = STELLAR_ADDR_RE.test(String(s.address)) && verifyStellarSignature(msg, String(s.signature), String(s.address));
    out.signer_is_payer = s.address === p.payer;
  } else errors.push("signer.key_type");
  // A valid signature over a stated hash that does not match the body proves nothing about this body.
  if (out.signature_ok && !out.hash_ok) { out.signature_ok = false; errors.push("signature_not_over_body"); }
  else if (!out.signature_ok) errors.push("signature_invalid");
  if (!out.signer_is_payer && !opts.minimalPayment) errors.push("signer_not_payer");
  out.ok = !errors.length;
  return out;
}

// ---------------------------------------------------------------- store

export interface ReceiptStore {
  put(rows: { tx_hash: string; network: string; kind: "vendor" | "catalog"; ref: string; receipt: Receipt }[]): Promise<number>;
  byTx(txs: string[]): Promise<Map<string, Receipt>>;
  /** Stored test-buys with no receipt yet (owner backfill / forward signing). */
  pending(limit: number): Promise<PendingBuy[]>;
  /** The stored test-buy for a tx (either table), signed or not. */
  buy(tx: string): Promise<PendingBuy | null>;
  count(): Promise<number>;
  /** Keep a replaced receipt verbatim (append-only) before its correction is stored. */
  archive(row: SupersededReceipt): Promise<void>;
  /** A receipt that was replaced by a correction, by its hash. */
  superseded(hash: string): Promise<SupersededReceipt | null>;
}

export interface PendingBuy {
  kind: "vendor" | "catalog";
  ref: string; // vendor_id or catalog resource key
  endpoint: string;
  domain: string | null;
  pay_to: string | null; // known for catalog buys; vendor buys: read from the ledger by the signer
  ts: number;
  network: string;
  tx_hash: string;
  amount: string;
  asset: string;
  http_status: number | null;
  data_returned: boolean;
  latency_ms: number | null;
  summary: string;
  source: string;
  inconclusive?: string | null;
}

export interface SupersededReceipt { receipt_hash: string; tx_hash: string; receipt: Receipt; superseded_at: number; superseded_by: string; reason: string }

export class MemoryReceiptStore implements ReceiptStore {
  rows = new Map<string, { network: string; kind: string; ref: string; receipt: Receipt }>();
  buys: PendingBuy[] = [];
  async put(rows: { tx_hash: string; network: string; kind: "vendor" | "catalog"; ref: string; receipt: Receipt }[]) {
    for (const r of rows) this.rows.set(r.tx_hash, r);
    return rows.length;
  }
  async byTx(txs: string[]) {
    const m = new Map<string, Receipt>();
    for (const t of txs) { const r = this.rows.get(t); if (r) m.set(t, r.receipt); }
    return m;
  }
  async pending(limit: number) { return this.buys.filter((b) => !this.rows.has(b.tx_hash)).slice(0, limit); }
  async buy(tx: string) { return this.buys.find((b) => b.tx_hash === tx) ?? null; }
  async count() { return this.rows.size; }
  old = new Map<string, SupersededReceipt>();
  async archive(row: SupersededReceipt) { if (!this.old.has(row.receipt_hash)) this.old.set(row.receipt_hash, row); }
  async superseded(hash: string) { return this.old.get(hash) ?? null; }
}

export class D1ReceiptStore implements ReceiptStore {
  constructor(private db: D1Like) {}
  async put(rows: { tx_hash: string; network: string; kind: "vendor" | "catalog"; ref: string; receipt: Receipt }[]) {
    if (!rows.length) return 0;
    await this.db.batch(rows.map((r) =>
      this.db.prepare("INSERT OR REPLACE INTO receipts (tx_hash, network, kind, ref, receipt_hash, receipt, stored_at) VALUES (?,?,?,?,?,?,?)")
        .bind(r.tx_hash, r.network, r.kind, r.ref, r.receipt.receipt_hash, JSON.stringify(r.receipt), Date.now())));
    return rows.length;
  }
  async byTx(txs: string[]) {
    const m = new Map<string, Receipt>();
    const all = [...new Set(txs)].slice(0, 450);
    for (let i = 0; i < all.length; i += 90) {
      const u = all.slice(i, i + 90);
      const res = await this.db.prepare(`SELECT tx_hash, receipt FROM receipts WHERE tx_hash IN (${u.map(() => "?").join(",")})`).bind(...u).all<{ tx_hash: string; receipt: string }>();
      for (const r of res.results ?? []) { try { m.set(r.tx_hash, JSON.parse(r.receipt)); } catch { /* skip */ } }
    }
    return m;
  }
  async pending(limit: number) {
    const n = Math.max(1, Math.min(200, limit));
    const res = await this.db.prepare(
      `SELECT 'vendor' kind, vendor_id ref, endpoint, NULL domain, NULL pay_to, ts, network, tx_hash, amount, asset, http_status, data_returned, latency_ms, summary, source, inconclusive
         FROM observations o WHERE NOT EXISTS (SELECT 1 FROM receipts r WHERE r.tx_hash = o.tx_hash)
       UNION ALL
       SELECT 'catalog', resource, resource, domain, pay_to, ts, network, tx_hash, amount, asset, http_status, data_returned, latency_ms, summary, 'lumi_catalog_buy', inconclusive
         FROM catalog_buys b WHERE NOT EXISTS (SELECT 1 FROM receipts r WHERE r.tx_hash = b.tx_hash)
       ORDER BY ts LIMIT ?`).bind(n).all<any>();
    return (res.results ?? []).map((r: any) => ({ ...r, data_returned: !!r.data_returned }));
  }
  async buy(tx: string) {
    const r = await this.db.prepare(
      `SELECT 'vendor' kind, vendor_id ref, endpoint, NULL domain, NULL pay_to, ts, network, tx_hash, amount, asset, http_status, data_returned, latency_ms, summary, source, inconclusive FROM observations WHERE tx_hash = ?1
       UNION ALL
       SELECT 'catalog', resource, resource, domain, pay_to, ts, network, tx_hash, amount, asset, http_status, data_returned, latency_ms, summary, 'lumi_catalog_buy', inconclusive FROM catalog_buys WHERE tx_hash = ?1 LIMIT 1`).bind(tx).first<any>();
    return r ? { ...r, data_returned: !!r.data_returned } : null;
  }
  async count() {
    return (await this.db.prepare("SELECT COUNT(*) n FROM receipts").first<{ n: number }>())?.n ?? 0;
  }
  async archive(r: SupersededReceipt) {
    await this.db.prepare("INSERT OR IGNORE INTO receipts_superseded (receipt_hash, tx_hash, receipt, superseded_at, superseded_by, reason) VALUES (?,?,?,?,?,?)")
      .bind(r.receipt_hash, r.tx_hash, JSON.stringify(r.receipt), r.superseded_at, r.superseded_by, r.reason).run();
  }
  async superseded(hash: string) {
    const r = await this.db.prepare("SELECT * FROM receipts_superseded WHERE receipt_hash = ?1").bind(hash).first<any>();
    if (!r) return null;
    try { return { ...r, receipt: JSON.parse(r.receipt) } as SupersededReceipt; } catch { return null; }
  }
}

/** The stored buy a receipt must describe (owner upload check). */
export function receiptMatchesBuy(r: Receipt, b: PendingBuy): string | null {
  if (r.payment.network !== b.network) return "network_mismatch";
  if (r.payment.tx_hash !== b.tx_hash) return "tx_mismatch";
  if (Math.abs(Number(r.payment.amount) - Number(b.amount)) > 1e-9) return "amount_mismatch";
  if (r.payment.asset !== b.asset) return "asset_mismatch";
  if (b.pay_to && r.seller.pay_to.toLowerCase() !== b.pay_to.toLowerCase()) return "pay_to_mismatch";
  if (r.delivery.data_returned !== dataReturnedView(b)) return "delivery_mismatch";
  if ((r.delivery.outcome === "inconclusive") !== (deliveryState(b) === "inconclusive")) return "delivery_mismatch";
  if (r.delivery.http_status !== (b.http_status ?? 0)) return "http_status_mismatch";
  return null;
}

/** Free doc: how to verify a receipt yourself. */
export function receiptVerifyDoc(base: string) {
  return {
    kind: "receipt_verification",
    type: RECEIPT_TYPE,
    version: RECEIPT_VERSION,
    status: "PROPOSED evidence format (v0.1); Lumi issues one per test-buy of a seller.",
    where_receipts_are: `Paid only: ${base}/v1/trust/receipts?seller= (receipts[].receipt, Lumi's test-buys of one seller), ${base}/v1/trust/vendors/{id}/report ($0.02; paid_test_buys.history[].receipt) and paid catalog lookups, POST ${base}/v1/feed/lookup on the Feed and Feed Pro plans (results[].entries[].purchases[].receipt). ${base}/v1/trust/check returns a verdict, not receipts. Free lookups stay answer-only.`,
    verify_online: `POST ${base}/v1/trust/receipts/verify with the receipt JSON as the body (free). Returns hash/signature checks and, with ?ledger=1, an on-chain check of the payment.`,
    verify_yourself: [
      "1. receipt_hash: remove receipt_hash and signer, serialise the rest as RFC 8785-style canonical JSON (keys sorted, no whitespace), SHA-256, lowercase hex. It must equal receipt_hash.",
      "2. message: signer.message must equal `lumi-receipt:<payment.network>:<payment.tx_hash>:<receipt_hash>`.",
      "3. signature: XRPL (key_type ripple-keypairs): ripple-keypairs verify(<UTF-8 bytes of message as uppercase hex>, signature, public_key), and deriveAddress(public_key) = signer.address. Base (key_type eip191): EIP-191 personal_sign recovery of message gives signer.address. Stellar (key_type stellar-ed25519): ed25519 verify of the UTF-8 message bytes with the base64 signature against the public key inside signer.address (G-address, StrKey).",
      "4. signer.address must equal payment.payer.",
      `4b. payer: payment.payer must be on Lumi's published test-buy wallet list for payment.network, ${base}/.well-known/lumi-test-buy-wallets.json (also ${base}/v1/check/wallets). Do not rely on issuer.name; anyone can write any name there. A receipt that passes 1-4 but fails 4b was paid and signed by some other wallet and is not a Lumi receipt.`,
      "5. ledger: fetch payment.tx_hash. XRPL: validated, tesSUCCESS, Account = payer, Destination = seller.pay_to, delivered_amount = amount/asset, and SigningPubKey = signer.public_key. Base: status success with a USDC (0x8335…2913) Transfer from payer to seller.pay_to for amount. Stellar: Horizon /transactions/<tx_hash> successful, and its operations show a USDC (issuer GA5Z…KZVN, SAC CCW67…MI75) transfer from payer to seller.pay_to for amount.",
      "6. delivery.* is the tester's signed statement about what the paid call returned. It cannot be proven on-chain; the seller can answer via the right to reply.",
    ],
    example_code_js: [
      "import { verify, deriveAddress } from 'ripple-keypairs'; import { recoverMessageAddress, sha256, toHex } from 'viem';",
      "const canon = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';",
      "const { receipt_hash, signer, ...body } = receipt; const h = sha256(toHex(canon(body))).slice(2); // must equal receipt_hash",
      "// XRPL: verify(Buffer.from(signer.message, 'utf8').toString('hex').toUpperCase(), signer.signature, signer.public_key) && deriveAddress(signer.public_key) === signer.address",
      "// Base: (await recoverMessageAddress({ message: signer.message, signature: signer.signature })).toLowerCase() === signer.address.toLowerCase()",
      "// Stellar: import { Keypair } from '@stellar/stellar-sdk'; Keypair.fromPublicKey(signer.address).verify(Buffer.from(signer.message, 'utf8'), Buffer.from(signer.signature, 'base64'))",
    ],
    keys: "Signed on Lumi's operator box with the wallet that paid. Lumi's API never holds or exposes wallet keys.",
    methodology: `${base}/v1/trust/methodology`,
  };
}

/** Build the unsigned receipt body for a stored test-buy plus what the ledger says about the payment. */
export function buildReceiptBody(
  b: PendingBuy,
  chain: { payer: string; pay_to: string; ledger_result: string; ledger_index?: number; block_number?: number; iou_issuer?: string },
  opts: { base?: string; issuedAt: string; supersedes?: { receipt_hash: string; reason: string } },
): ReceiptBody {
  const base = opts.base ?? "https://api.lumitrades.io";
  const xrpl = b.network === "xrpl:0";
  const stellar = b.network === "stellar:pubnet";
  const chainLabel = xrpl ? "XRPL" : stellar ? "Stellar" : "Base";
  let domain = b.domain ?? undefined;
  let endpoint = b.endpoint;
  if (!/^https?:\/\//i.test(endpoint)) endpoint = "https://" + endpoint;
  try { domain = domain ?? new URL(endpoint).hostname.toLowerCase(); } catch { /* keep */ }
  const rail = `${chainLabel} ${b.asset}`;
  const atomic = b.asset === "XRP" ? Math.round(Number(b.amount) * 1e6) : b.asset === "USDC" ? Math.round(Number(b.amount) * (stellar ? 1e7 : 1e6)) : undefined;
  return {
    type: RECEIPT_TYPE,
    version: RECEIPT_VERSION,
    receipt_id: `lumi-${xrpl ? "xrpl" : stellar ? "stellar" : "base"}-${b.tx_hash}`,
    issued_at: opts.issuedAt,
    issuer: { name: "Lumi", methodology_url: `${base}/v1/trust/methodology`, methodology_version: "v0" },
    seller: { ...(b.kind === "vendor" ? { vendor_id: b.ref } : {}), endpoint, ...(domain ? { domain } : {}), pay_to: chain.pay_to },
    payment: {
      network: b.network as ReceiptNetwork,
      asset: b.asset,
      ...(chain.iou_issuer ? { issuer: chain.iou_issuer } : {}),
      amount: String(Number(b.amount)),
      ...(atomic != null && Number.isFinite(atomic) ? { amount_atomic: atomic } : {}),
      tx_hash: b.tx_hash,
      payer: chain.payer,
      ledger_result: chain.ledger_result,
      ...(chain.ledger_index != null ? { ledger_index: chain.ledger_index } : {}),
      ...(chain.block_number != null ? { block_number: chain.block_number } : {}),
    },
    delivery: {
      observed_at: new Date(b.ts).toISOString(),
      http_status: b.http_status ?? 0,
      data_returned: dataReturnedView(b),
      outcome: outcomeOf(b.http_status, b.data_returned, b.summary, b.inconclusive),
      ...(inconclusiveReason(b) ? { inconclusive_reason: inconclusiveReason(b)!, note: inconclusiveReason(b) === "empty_result" ? "The seller answered with an empty result for Lumi's test query; delivery unknown. Not counted against the seller." : "Lumi recorded no HTTP response for this paid call (Lumi-side); delivery unknown. Not counted against the seller." } : {}),
      ...(b.latency_ms != null ? { latency_ms: b.latency_ms } : {}),
      // Label from the buy's own chain and asset (an XRPL catalog buy is not "Base USDC").
      source: b.kind === "catalog" ? `Lumi catalog test-buy (${rail})` : b.source === "lumi_buy" ? "Lumi paid buy (seeded)" : `Lumi daily test-buy (${xrpl ? "XRPL" : rail})`,
    },
    ...(opts.supersedes ? { supersedes: { ...opts.supersedes, corrections_url: `${base}/v1/monitor/corrections` } } : {}),
  };
}
