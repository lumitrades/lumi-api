/**
 * Contributor receipt: AgenticRiskStandard `counterparty_delivery_receipt` v0.1 plus an `x_lumi_contrib` extension block.
 * The paying wallet signs `lumi-receipt:<network>:<tx_hash>:<receipt_hash>`; the hash covers the whole body incl. the extension.
 */
import { canonicalJson, sha256Hex } from "./util.js";
import { KIT_NAME, KIT_VERSION, CONTRIB_FORMAT, RECEIPT_TYPE, RECEIPT_VERSION, DEFAULT_API } from "./version.js";

export const OUTCOMES = ["delivered", "no_data", "empty_result", "error_status", "timeout", "wrong_data", "other", "inconclusive"];
export const receiptMessage = (network, tx, hash) => `lumi-receipt:${network}:${tx}:${hash}`;

export async function receiptHash(r) {
  const { receipt_hash: _h, signer: _s, ...body } = r;
  return sha256Hex(canonicalJson(body));
}

/**
 * @param p { endpoint, pay_to, network, asset, amount, issuer?, tx_hash, payer, ledger_result?, observed_at, http_status, outcome, latency_ms?, mode, measurements?, label? }
 */
export function buildReceiptBody(p, { api = DEFAULT_API, issuedAt = new Date().toISOString() } = {}) {
  if (!OUTCOMES.includes(p.outcome)) throw new Error("outcome must be one of " + OUTCOMES.join(", "));
  if (p.mode !== "passive" && p.mode !== "test_buy") throw new Error("mode must be passive or test_buy");
  let domain;
  try { domain = new URL(p.endpoint).hostname.toLowerCase(); } catch { throw new Error("endpoint must be a full URL"); }
  const chain = p.network === "xrpl:0" ? "xrpl" : p.network === "stellar:pubnet" ? "stellar" : "base";
  return {
    type: RECEIPT_TYPE,
    version: RECEIPT_VERSION,
    receipt_id: `contrib-${chain}-${p.tx_hash}`,
    issued_at: issuedAt,
    issuer: { name: p.label ? `Lumi Scanner Kit contributor (${String(p.label).slice(0, 40)})` : "Lumi Scanner Kit contributor", methodology_url: `${api}/v1/trust/methodology`, methodology_version: "v0" },
    seller: { endpoint: p.endpoint, domain, pay_to: p.pay_to },
    payment: {
      network: p.network, asset: p.asset, ...(p.issuer ? { issuer: p.issuer } : {}), amount: String(Number(p.amount)), tx_hash: p.tx_hash, payer: p.payer,
      ledger_result: p.ledger_result ?? "tesSUCCESS",
    },
    delivery: {
      observed_at: p.observed_at, http_status: p.http_status ?? 0,
      data_returned: p.outcome === "inconclusive" ? null : p.outcome === "delivered",
      outcome: p.outcome, ...(p.latency_ms != null ? { latency_ms: Math.round(p.latency_ms) } : {}), source: "contributor",
    },
    x_lumi_contrib: { format: CONTRIB_FORMAT, kit: { name: KIT_NAME, version: KIT_VERSION }, mode: p.mode, measurements: p.measurements ?? {} },
  };
}

/** Hash and sign with the paying wallet's signer (see signers.js). The signer must be the payer. */
export async function signReceipt(body, signer) {
  if (signer.network !== body.payment.network) throw new Error("signer network differs from payment network");
  const same = signer.network === "eip155:8453" ? signer.address.toLowerCase() === String(body.payment.payer).toLowerCase() : signer.address === body.payment.payer;
  if (!same) throw new Error("signer is not the payer: only the wallet that paid can sign its receipt");
  const receipt_hash = await receiptHash(body);
  const message = receiptMessage(body.payment.network, body.payment.tx_hash, receipt_hash);
  const signature = await signer.sign(message);
  return { ...body, receipt_hash, signer: { key_type: signer.key_type, address: signer.address, ...(signer.public_key ? { public_key: signer.public_key } : {}), message, signature } };
}
