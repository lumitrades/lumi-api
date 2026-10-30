/**
 * XRPL DestinationTag per Lumi product (see docs/xrpl-destination-tags.md for the table).
 *
 * Lumi's own XRPL x402 quotes carry `extra.destinationTag` so every settlement into Lumi's payTo says which product it paid
 * for (the t54 facilitator rejects a payment whose DestinationTag differs: `destination_tag_mismatch`). The product key is
 * the Quote.routeKey prefix (everything before the first ":"), e.g. "receipts:probe" -> "receipts", "watch:<id>:n1:t1" ->
 * "watch". Tags are permanent once used on mainnet: never renumber, only append. 1xxx = trust API calls,
 * 2xxx = monitor plans/packs, 3xxx = feed plans. 9000 = any paid product not in the table (should not happen; tests check).
 */
export const XRPL_DESTINATION_TAGS: Readonly<Record<string, number>> = Object.freeze({
  // Trust API (per call)
  vendor_report: 1001,
  high_value_check: 1002,
  verdict: 1003,
  receipts: 1004,
  batch_check: 1005,
  // Monitor plans and packs
  monitor: 2001,
  monitor_plus: 2002,
  watch: 2003,
  watch_plus: 2004,
  watch_plus_founder: 2005,
  watch_pro: 2006,
  audit: 2007,
  retest_pack: 2008,
  founder_pack: 2009,
  // Feed
  feed: 3001,
  feed_pro: 3002,
  feed_credits: 3003,
});

export const XRPL_DESTINATION_TAG_UNMAPPED = 9000;

export function productOfRouteKey(routeKey: string): string {
  const i = routeKey.indexOf(":");
  return i < 0 ? routeKey : routeKey.slice(0, i);
}

export function destinationTagFor(routeKey: string): number {
  return XRPL_DESTINATION_TAGS[productOfRouteKey(routeKey)] ?? XRPL_DESTINATION_TAG_UNMAPPED;
}

/** Reverse lookup for reporting: DestinationTag -> product key (undefined for unknown tags). */
export function productOfDestinationTag(tag: number | null | undefined): string | undefined {
  if (tag == null) return undefined;
  for (const [k, v] of Object.entries(XRPL_DESTINATION_TAGS)) if (v === tag) return k;
  return undefined;
}
