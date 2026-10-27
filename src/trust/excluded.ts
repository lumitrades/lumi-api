/**
 * Permanent seller exclusions (owner decision 2026-10-26). An excluded seller is never imported from any directory
 * (CDP Bazaar or ext:*), never recorded as a test-buy, never probed, scored, ranked or shown in any catalog output.
 * Internal filter only: matching rows are simply absent (no public label or reason). Case-insensitive.
 */
// excluded-seller-1: host and every subdomain of this suffix, plus its payTo wallet.
export const EXCLUDED_HOST_SUFFIXES: readonly string[] = ["agentchecklist.workers.dev"];
export const EXCLUDED_PAY_TOS: readonly string[] = ["0x9dbe9ae85f9e518d4df0a8b10bbb0c786726d05a"];

export function isExcludedHost(host: string | null | undefined): boolean {
  const h = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
  return !!h && EXCLUDED_HOST_SUFFIXES.some((s) => h === s || h.endsWith("." + s));
}
export function isExcludedUrl(u: string | null | undefined): boolean {
  if (!u) return false;
  try { return isExcludedHost(new URL(String(u)).hostname); } catch { return isExcludedHost(String(u).replace(/^[a-z]+:\/\//i, "").split(/[/?#:]/)[0]); }
}
export function isExcludedPayTo(p: string | null | undefined): boolean {
  return EXCLUDED_PAY_TOS.includes(String(p ?? "").trim().toLowerCase());
}
/** Any listing / catalog row / buy row: resource URL, host, registrable domain or any payTo. */
export function isExcludedEntry(r: { resource?: string | null; domain?: string | null; reg_domain?: string | null; pay_tos?: string | string[] | null; pay_to?: string | null }): boolean {
  const pts = Array.isArray(r.pay_tos) ? r.pay_tos : String(r.pay_tos ?? "").split(",");
  return isExcludedUrl(r.resource) || isExcludedHost(r.domain) || isExcludedHost(r.reg_domain) || isExcludedPayTo(r.pay_to) || pts.some(isExcludedPayTo);
}
