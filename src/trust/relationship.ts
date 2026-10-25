/**
 * Relationship disclosure (legal review 2026-10-25, M13/M14). Shown in /v1/check and /v1/verdict and stored with a review
 * row for the human reviewer. NEVER an input to the label: labelFor() in ./verdict has no parameter for it, and
 * test/verdict_firewall.test.ts proves the outcome is identical with and without each flag.
 */
/** Other x402 trust / check services (public, from Lumi's competitor research). Matched on the host or a parent domain. */
export const COMPETITOR_DOMAINS = ["agents-trust.com", "lumierepaycheck.org", "vet402.com", "x402-doctor.fizzl.eu", "toolvet.app", "x402-trust.com"];

export interface Relationship { competitor: boolean; customer: boolean; paying_seller: boolean }

const list = (s: string | undefined) => (s ?? "").split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
const under = (host: string, ds: string[]) => ds.some((d) => host === d || host.endsWith("." + d));

/**
 * env.VERDICT_COMPETITOR_DOMAINS adds to COMPETITOR_DOMAINS; env.VERDICT_CUSTOMER_DOMAINS lists sellers that are (or run)
 * Lumi customers. The customer list is owner-set config (no default here): it names a paying customer of Lumi.
 */
export function relationshipConfig(env: Record<string, string | undefined> = {}) {
  return { competitors: [...COMPETITOR_DOMAINS, ...list(env.VERDICT_COMPETITOR_DOMAINS)], customers: list(env.VERDICT_CUSTOMER_DOMAINS) };
}

export function relationshipFor(host: string | null, commercial: unknown[] | null, cfg: ReturnType<typeof relationshipConfig>): Relationship {
  const h = (host ?? "").toLowerCase();
  return { competitor: !!h && under(h, cfg.competitors), customer: !!h && under(h, cfg.customers), paying_seller: !!commercial?.length };
}

export const relationshipTag = (r: Relationship) => [r.competitor && "competitor", r.customer && "customer", r.paying_seller && "paying_seller"].filter(Boolean).join(",") || null;
