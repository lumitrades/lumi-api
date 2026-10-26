/**
 * Delivery state of a Lumi test-buy: delivered, not delivered (the seller answered without usable data), or
 * inconclusive (Lumi never saw an HTTP response: our client gave up, our run was interrupted, or another Lumi-side
 * failure). An inconclusive buy is a dated fact about Lumi's own run, not about the seller: it is never shown as
 * "no data returned", never counted as a failed delivery, and never turns a trust/check verdict into warn or block.
 *
 * Guard: a stored buy with no HTTP status (null or 0) and no data is always inconclusive, whatever
 * the uploader said. Only a real HTTP response from the seller can record "no data".
 */
export type DeliveryState = "delivered" | "not_delivered" | "inconclusive";

export const INCONCLUSIVE_REASONS = {
  lumi_client_timeout: "Lumi's client stopped waiting before the seller's response arrived (Lumi-side timeout); delivery unknown.",
  lumi_run_interrupted: "Lumi's test-buy run was interrupted before the response was recorded; delivery unknown.",
  lumi_side_error: "A Lumi-side error prevented recording the response; delivery unknown.",
  no_http_response: "Lumi recorded no HTTP response for this paid call; delivery unknown.",
} as const;
export type InconclusiveReason = keyof typeof INCONCLUSIVE_REASONS;
export const isInconclusiveReason = (x: unknown): x is InconclusiveReason => typeof x === "string" && Object.prototype.hasOwnProperty.call(INCONCLUSIVE_REASONS, x);

export interface DeliveryLike { http_status: number | null | undefined; data_returned: boolean; inconclusive?: string | null }

const noStatus = (s: number | null | undefined) => s == null || s === 0;

export function deliveryState(r: DeliveryLike): DeliveryState {
  if (r.inconclusive) return "inconclusive";
  if (r.data_returned) return "delivered";
  if (noStatus(r.http_status)) return "inconclusive";
  return "not_delivered";
}

/** Public tri-state: true = data, false = seller answered without data, null = unknown (inconclusive, Lumi-side). */
export function dataReturnedView(r: DeliveryLike): boolean | null {
  const s = deliveryState(r);
  return s === "delivered" ? true : s === "not_delivered" ? false : null;
}

export function inconclusiveReason(r: DeliveryLike): InconclusiveReason | null {
  if (deliveryState(r) !== "inconclusive") return null;
  return isInconclusiveReason(r.inconclusive) ? r.inconclusive : "no_http_response";
}

/** Short public wording for a buy's delivery (never "no data" for an inconclusive buy). */
export function deliveryText(r: DeliveryLike): string {
  const s = deliveryState(r);
  if (s === "delivered") return "response contained data";
  if (s === "not_delivered") return "response contained no usable data";
  return "delivery unknown (inconclusive, Lumi-side; not counted against the seller)";
}

const NO_DATA_WORDING = /[,;]?\s*(no (usable )?data (was )?returned|returned no data|contained no data|got no (usable )?data|no data)\.?/gi;

/**
 * Ingest guard: normalise a buy before it is stored. A buy with no HTTP status and no data becomes inconclusive
 * (reason kept if the uploader gave a valid one), and "no data returned"-style wording is replaced in its summary.
 */
export function guardBuy<T extends DeliveryLike & { summary: string }>(row: T): T & { inconclusive: string | null } {
  const explicit = isInconclusiveReason(row.inconclusive) ? row.inconclusive : null;
  if (!explicit && (row.data_returned || !noStatus(row.http_status))) return { ...row, inconclusive: null };
  const reason: InconclusiveReason = explicit ?? "no_http_response";
  let summary = String(row.summary ?? "").replace(NO_DATA_WORDING, "").replace(/\s+/g, " ").trim().replace(/[,;.]+$/, "");
  if (!/delivery unknown/i.test(summary)) summary = `${summary ? summary + "; " : ""}delivery unknown (inconclusive, Lumi-side; not counted against the seller).`;
  else if (!/[.)]$/.test(summary)) summary += ".";
  return { ...row, data_returned: false, inconclusive: reason, summary: summary.slice(0, 300) };
}

/** Counts over a set of buys: inconclusive ones are reported but excluded from the delivery rate. */
export function deliveryCounts(rows: DeliveryLike[]) {
  let delivered = 0, not_delivered = 0, inconclusive = 0;
  for (const r of rows) {
    const s = deliveryState(r);
    if (s === "delivered") delivered++;
    else if (s === "not_delivered") not_delivered++;
    else inconclusive++;
  }
  return { delivered, not_delivered, inconclusive, conclusive: delivered + not_delivered };
}
