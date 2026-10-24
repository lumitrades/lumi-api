/** Passive mode: build a signed receipt for an x402 purchase you already made. No new spend. */
import { paymentFromLedger } from "./ledger.js";
import { buildReceiptBody, signReceipt } from "./receipt.js";

/**
 * @param o { endpoint, network, tx_hash, http_status, outcome, observed_at?, latency_ms?, measurements?, signer, label?, mode?, ledger? }
 */
export async function reportPurchase(o) {
  const led = o.ledger ?? (await paymentFromLedger(o.network, o.tx_hash, { payTo: o.pay_to, fetchImpl: o.fetchImpl }));
  if (o.pay_to && led.pay_to.toLowerCase() !== o.pay_to.toLowerCase()) throw new Error("tx did not pay the given pay_to");
  const body = buildReceiptBody({
    endpoint: o.endpoint, pay_to: led.pay_to, network: o.network, tx_hash: o.tx_hash, observed_at: o.observed_at ?? new Date(led.ts).toISOString(), http_status: o.http_status, outcome: o.outcome,
    latency_ms: o.latency_ms, mode: o.mode ?? "passive", measurements: o.measurements, label: o.label,
  });
  // The ledger's payer is checked locally against the signing wallet; it is not written into the receipt.
  return signReceipt(body, o.signer, { payer: led.payer });
}
