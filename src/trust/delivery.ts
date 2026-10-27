/**
 * Delivery state of a Lumi test-buy: delivered, not delivered (the seller answered without usable data), or
 * inconclusive. Inconclusive has two kinds of cause:
 *  - Lumi-side: Lumi never saw an HTTP response (our client gave up, our run was interrupted, another Lumi-side failure);
 *  - empty_result: the seller answered 2xx with an empty result for Lumi's test query ({}, [], null, or a data feed whose
 *    result lists were all empty). An empty list can be a correct answer to a narrow query, so it proves neither
 *    delivery nor failure;
 *  - our_query_error: the seller's 2xx error was clearly caused by Lumi's own test input (an unfilled {placeholder} in
 *    Lumi's request, or an invalid/unsupported-input error naming Lumi's parameters), so it says nothing about the seller.
 * An inconclusive buy is never shown as "no data returned", never counted as a failed delivery (it is excluded from
 * the delivery rate and the score), and never turns a trust/check verdict into warn or block.
 *
 * Guard: a stored buy with no HTTP status (null or 0) and no data is always inconclusive, whatever
 * the uploader said. Only a real HTTP response from the seller can record "no data".
 *
 * How a raw paid response is judged (delivered / not delivered / inconclusive) lives in ./judge.ts, shared
 * byte-for-byte with Lumi's test-buy runners so the API and the runners apply one rule.
 */
export { judgeResponse, JUDGE_SUMMARY, type Judgement, type JudgeInput, type JudgedReason, type JudgedState } from "./judge";
import type { Judgement } from "./judge";

export type DeliveryState = "delivered" | "not_delivered" | "inconclusive";

export const INCONCLUSIVE_REASONS = {
  lumi_client_timeout: "Lumi's client stopped waiting before the seller's response arrived (Lumi-side timeout); delivery unknown.",
  lumi_run_interrupted: "Lumi's test-buy run was interrupted before the response was recorded; delivery unknown.",
  lumi_side_error: "A Lumi-side error prevented recording the response; delivery unknown.",
  no_http_response: "Lumi recorded no HTTP response for this paid call; delivery unknown.",
  empty_result: "The seller answered with an empty result for Lumi's test query (no rows, no error); an empty result can be a correct answer, so delivery is unknown and not counted against the seller.",
  our_query_error: "The seller's error was caused by Lumi's own test input (for example an unfilled placeholder or an unsupported parameter value in Lumi's request), not by the seller; delivery unknown and not counted against the seller.",
} as const;
export type InconclusiveReason = keyof typeof INCONCLUSIVE_REASONS;
export const isInconclusiveReason = (x: unknown): x is InconclusiveReason => typeof x === "string" && Object.prototype.hasOwnProperty.call(INCONCLUSIVE_REASONS, x);
/** Inconclusive reasons that describe Lumi's own run (no response seen); empty_result is the seller's (empty) answer. */
export const LUMI_SIDE_REASONS: readonly InconclusiveReason[] = ["lumi_client_timeout", "lumi_run_interrupted", "lumi_side_error", "no_http_response"];
export const isLumiSideReason = (x: unknown) => LUMI_SIDE_REASONS.includes(x as InconclusiveReason);

const UNKNOWN_LUMI_SIDE = "delivery unknown (inconclusive, Lumi-side; not counted against the seller)";
const UNKNOWN_EMPTY_RESULT = "empty result for Lumi's test query; delivery unknown (inconclusive; not counted against the seller)";
const UNKNOWN_OUR_QUERY = "error caused by Lumi's own test input, not the seller; delivery unknown (inconclusive; not counted against the seller)";
/** Short public phrase for an inconclusive buy, by reason. */
export const inconclusiveWording = (reason: string | null | undefined) =>
  reason === "empty_result" ? UNKNOWN_EMPTY_RESULT : reason === "our_query_error" ? UNKNOWN_OUR_QUERY : UNKNOWN_LUMI_SIDE;

/** Stored-row fields for a judged response (what a runner uploads as data_returned / inconclusive). */
export function judgedRow(j: Judgement): { data_returned: boolean; inconclusive: InconclusiveReason | null } {
  if (j.state === "delivered") return { data_returned: true, inconclusive: null };
  if (j.state === "inconclusive") return { data_returned: false, inconclusive: isInconclusiveReason(j.reason) ? j.reason : "no_http_response" };
  return { data_returned: false, inconclusive: null };
}

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
  return inconclusiveWording(r.inconclusive);
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
  if (!/delivery unknown|not counted against the seller/i.test(summary)) summary = `${summary ? summary + "; " : ""}${inconclusiveWording(reason)}.`;
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
