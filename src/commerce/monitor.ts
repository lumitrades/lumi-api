/**
 * Seller monitoring: sellers prove control of their payTo, enrol endpoints, pay a plan via x402, and Lumi test-buys
 * their endpoints (seller-funded, capped per buy) from the operator box, posting results back here. Findings are
 * append-only and alert the seller (HMAC-signed webhook and/or email). Nothing here is read by any trust score.
 */
import { canonicalJson, json, requirePayment, assetLabel, paymentRequiredResponse, HEADER_PAYMENT_SIGNATURE, HEADER_X_PAYMENT, type Settlement, type PaymentRequirements } from "../x402";
import { verifyXrplSignature, xrplAddressOf } from "../trust/verify";
import { explorerFor } from "../trust/catalog";
import { sendPlainEmail } from "../sales";
import { DAY_MS, MONITOR_LIMITS, MONITOR_PLANS, PLANS, TEST_PRICE_USD, hmacHex, iso, isTestWallet, planPriceUsd, planQuote, randHex, sha256, type PlanId } from "./plans";
import { MONITOR_METHODOLOGY, MONITOR_SAFEGUARDS, MONITOR_TERMS } from "./policy";
import { makeChallenge, verifyProof } from "./proof";
import { NO_STORE, acceptAsset, acceptUsd, bad, bearer, parse402, readJson, safeEmail, safeHttpsUrl, type CommerceDeps, type WaitUntil } from "./common";
import type { Enrollment, FindingRow, MonitorEndpoint, PlanRow, RunRow } from "./store";

const ENROLL_ID_RE = /^men_[a-f0-9]{24}$/;
const OK_OUTCOMES = new Set(["delivered"]);
const MONITORING = new Set(["monitor", "monitor_plus"]);
const ENDPOINT_TIMEOUT_MS = 10_000;
const MAX_SELLER_ENDPOINTS = 20;
const ENROLL_PER_PAYTO_PER_DAY = 5;

/** Badge label for Lumi's own owner-flagged test enrolment (never shown as a real "Monitored by Lumi" seller). */
export const TEST_BADGE_LABEL = "Lumi test enrolment";
export const SELLERS_DISCLOSURE = "Sellers listed here have paid Lumi for a monitoring plan (active or past). Lumi's own test enrolments are excluded from this list. Paying never changes a score.";
export const MONITOR_POST_PATHS = ["/v1/monitor/enroll", "/v1/monitor/replies", "/v1/owner/monitor/results", "/v1/owner/monitor/report", "/v1/owner/corrections"];

function failed(r: RunRow | undefined) { return !!r && r.outcome !== "skipped" && r.outcome !== "quote_only" && !OK_OUTCOMES.has(r.outcome); }

/** Endpoints a plan covers (Monitor: the first seller endpoint; Plus: up to 20 seller endpoints; Audit: all incl. catalog listings). */
export function planEndpoints(e: Enrollment, plan: string): MonitorEndpoint[] {
  const seller = e.endpoints.filter((x) => x.source === "seller");
  if (plan === "monitor") return seller.slice(0, 1);
  if (plan === "monitor_plus") return seller.slice(0, MONITOR_LIMITS.endpoints.monitor_plus);
  return e.endpoints.slice(0, MONITOR_LIMITS.endpoints.audit);
}

/** Test-buy economics per plan: endpoints covered, planned spend, and whether it fits the fee (list price). */
export function planEconomics(e: Enrollment) {
  const out: Record<string, unknown> = {};
  for (const id of MONITOR_PLANS) {
    const eps = planEndpoints(e, id);
    const buyable = eps.filter((x) => x.price_usd != null && Number(x.price_usd) <= MONITOR_LIMITS.maxBuyUsd);
    const quoteOnly = eps.length - buyable.length;
    const est = buyable.reduce((s, x) => s + Number(x.price_usd) * MONITOR_LIMITS.buysPerEndpoint[id], 0);
    const budget = Number(PLANS[id].usd) * MONITOR_LIMITS.budgetShare;
    const eligible = buyable.length > 0 && est <= budget;
    out[id] = {
      price_usd: PLANS[id].usd,
      ...(e.is_test ? { test_price_usd: TEST_PRICE_USD } : {}),
      endpoints_covered: eps.length,
      test_buys_planned: buyable.length * MONITOR_LIMITS.buysPerEndpoint[id],
      ...(quoteOnly ? { quote_checked_only: quoteOnly } : {}),
      est_test_buy_cost_usd: Math.round(est * 10_000) / 10_000,
      test_buy_budget_usd: budget,
      eligible,
      ...(!eligible ? { reason: buyable.length ? `Planned test-buys ($${est.toFixed(4)}) exceed ${MONITOR_LIMITS.budgetShare * 100}% of the fee: the plan would be unprofitable.` : "No endpoint priced within the $0.10 per-test-buy cap." } : {}),
    };
  }
  return out;
}

export function badgeStatus(e: Enrollment, plans: PlanRow[], runs: RunRow[], now: number) {
  const active = plans.find((p) => MONITORING.has(p.plan) && p.starts_at <= now && now < p.ends_at);
  if (!active) return { ok: false as const, reason: plans.some((p) => MONITORING.has(p.plan)) ? "plan_lapsed" : "no_monitoring_plan" };
  const eps = planEndpoints(e, active.plan).map((x) => x.url);
  const latest = eps.map((u) => runs.find((r) => r.endpoint === u && r.outcome !== "skipped"));
  const seen = latest.filter((x): x is RunRow => !!x);
  if (!seen.length) return { ok: false as const, reason: "no_test_yet", plan: active };
  const last = Math.max(...seen.map((r) => r.ts));
  if (seen.some((r) => failed(r))) return { ok: false as const, reason: "monitoring_failed", plan: active, last_test: last };
  if (now - last > MONITOR_LIMITS.badgeFreshMs[active.plan]) return { ok: false as const, reason: "no_recent_test", plan: active, last_test: last };
  return { ok: true as const, plan: active, last_test: last, result: seen.length < eps.length ? "pass (partial)" : "pass" };
}

const REASON_TEXT: Record<string, string> = {
  plan_lapsed: "plan lapsed", no_monitoring_plan: "not monitored", no_test_yet: "no test yet", monitoring_failed: "latest test failed", no_recent_test: "no recent test",
};

function esc(s: string) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }

export function badgeSvg(left: string, right: string, ok: boolean): string {
  const w = (s: string) => Math.round(s.length * 6.4 + 14);
  const lw = w(left), rw = w(right), W = lw + rw;
  const rc = ok ? "url(#g)" : "#6b7280";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="20" role="img" aria-label="${esc(left)}: ${esc(right)}"><title>${esc(left)}: ${esc(right)}</title>` +
    `<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>` +
    `<rect width="${lw}" height="20" rx="3" fill="#0b0f1a"/><rect x="${lw}" width="${rw}" height="20" rx="3" fill="${rc}"/><rect x="${lw - 3}" width="6" height="20" fill="${rc}"/>` +
    `<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="7" y="14">${esc(left)}</text><text x="${lw + 7}" y="14">${esc(right)}</text></g></svg>`;
}

export function createMonitor(deps: CommerceDeps) {
  const { store, now } = deps;

  async function ownerOnly(request: Request) {
    if (await deps.isOwner(request)) return null;
    return json(401, { error: "owner_key_required", hint: "Authorization: Bearer <OWNER_MCP_KEY>" }, { ...NO_STORE, "WWW-Authenticate": "Bearer" });
  }

  function doc(base: string) {
    return {
      kind: "lumi_seller_monitoring",
      summary: "Opt-in monitoring for x402 sellers (XRPL first, Base supported): Lumi test-buys your endpoints with real payments and alerts you when something breaks.",
      plans: MONITOR_PLANS.map((id) => ({ plan: id, name: PLANS[id].name, price_usd: PLANS[id].usd, term_days: PLANS[id].days, auto_renew: false, pay: `${base}${PLANS[id].path}?enrollment=<enrollment_id>`, summary: PLANS[id].summary })),
      payment: "x402 on XRPL (XRP, RLUSD, USDC) or Base (USDC). One payment = one term; renew by paying again (stacks after the current term). Reminders 3 days before the end.",
      steps: [
        `1. GET ${base}/v1/monitor/challenge?pay_to=<your payTo> (free): a message to sign. XRPL: sign the UTF-8 hex of the message with the payTo's master or regular key (ripple-keypairs) and send public_key. Base: EIP-191 personal_sign from the payTo (smart-contract wallets/EIP-1271 are not supported yet).`,
        `2. POST ${base}/v1/monitor/enroll {message, signature, public_key?, endpoints:[{url, method?, body?}], webhook_url?, email?} (free). Each endpoint is quote-checked: it must pay the proven payTo and cost ≤ $${MONITOR_LIMITS.maxBuyUsd} per buy, or it is rejected with the reason. Returns enrollment_id, a management token and the webhook signing secret (shown once).`,
        `3. Pay a plan: GET ${base}/v1/monitor/subscribe/{monitor|monitor_plus|audit}?enrollment=<id> (x402).`,
        `4. Public entry: ${base}/v1/monitor/sellers/<id>; badge: ${base}/v1/monitor/badge/<id>.svg (or .json).`,
      ],
      alerts: {
        kinds: ["paid_no_data", "paid_invalid_data", "http_5xx", "http_error", "timeout", "pay_to_changed", "price_changed", "schema_changed", "recovered", "renewal_due", "plan_lapsed"],
        webhook: "POST JSON {type:'lumi.monitor.finding', enrollment_id, finding, seller_page}; header X-Lumi-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + '.' + body)>.",
        email: "Plain-text email to the address given at enrolment (kept private, never shown publicly).",
      },
      replies: `POST ${base}/v1/monitor/replies {enrollment_id, finding_id, text} with Authorization: Bearer <management token>. Replies are shown next to the finding; findings cannot be removed.`,
      methodology: { ...MONITOR_METHODOLOGY, full: `${base}/v1/trust/methodology` },
      safeguards: MONITOR_SAFEGUARDS,
      corrections: `${base}/v1/monitor/corrections`,
      sellers: `${base}/v1/monitor/sellers`,
      refunds: `${MONITOR_TERMS.terms[0]} Contact via lumitrades.io.`,
      audit_reports: MONITOR_TERMS.terms[1],
      terms: MONITOR_TERMS,
      disclaimer: "Monitoring results are dated observations, not an endorsement, audit opinion or guarantee. Not financial advice.",
    };
  }

  // ---------------- enrolment

  /** OFAC SDN screen: a listed payTo is refused (and logged); Lumi never enrols, bills or test-buys it. */
  async function sanctioned(where: string, payTo: string | null | undefined, extra: Record<string, unknown> = {}) {
    if (!deps.sanctions || !payTo) return null;
    await deps.sanctions.ready();
    const hit = deps.sanctions.check(payTo);
    if (hit) deps.sanctions.refuse(where, hit, extra);
    return hit;
  }
  const sanctionedRes = (hit: { normalized: string; publication_date: string | null }) =>
    json(403, { error: "sanctioned_address", reason: "sanctioned_address", pay_to: hit.normalized, list: "OFAC SDN", publication_date: hit.publication_date, detail: "This payTo is listed on the U.S. Treasury OFAC SDN list. Lumi does not enrol, bill or test-buy it.", note: "Not charged." }, NO_STORE);

  async function checkEndpoint(raw: any, e: { address: string; network: string }, rate: number): Promise<{ ok: true; ep: MonitorEndpoint } | { ok: false; url: string; reason: string }> {
    const url = safeHttpsUrl(raw?.url);
    if (!url) return { ok: false, url: String(raw?.url ?? "").slice(0, 200), reason: "https URL with a public DNS name required" };
    const method = String(raw?.method ?? "GET").toUpperCase() === "POST" ? "POST" : "GET";
    const body = method === "POST" && raw?.body && typeof raw.body === "object" ? (raw.body as Record<string, unknown>) : undefined;
    let r: Response;
    try {
      r = await deps.endpointFetch(url, {
        method,
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), "User-Agent": "LumiMonitor/1.0 (+https://api.lumitrades.io/v1/monitor)" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
        redirect: "manual",
      });
    } catch {
      return { ok: false, url, reason: "no answer within 10 s" };
    }
    if (r.status !== 402) return { ok: false, url, reason: `expected an unpaid 402 quote, got HTTP ${r.status}` };
    const terms = await parse402(r);
    if (!terms) return { ok: false, url, reason: "402 without x402 accepts[]" };
    // The proven network, or Lumi's own configured network of the same family (identical to it in production).
    const fam = (n: string) => n.split(":")[0];
    const nets = new Set<string>([e.network, ...([deps.cfg.network, deps.cfg.evm?.network] as (string | undefined)[]).filter((n): n is string => !!n && fam(n) === fam(e.network))]);
    for (const a of terms.accepts as any[]) if (await sanctioned("monitor_enroll_quote", String(a?.payTo ?? ""), { url })) return { ok: false, url, reason: "sanctioned_address: the quote pays an OFAC SDN-listed address" };
    const mine = terms.accepts.filter((a: any) => nets.has(String(a?.network ?? "")) && String(a?.payTo ?? "").toLowerCase() === e.address.toLowerCase());
    if (!mine.length) return { ok: false, url, reason: `the quote does not pay the proven payTo on ${e.network}` };
    const priced = mine.map((a: any) => ({ a, usd: acceptUsd(a, rate) })).filter((x: any) => x.usd != null).sort((x: any, y: any) => x.usd - y.usd);
    if (!priced.length) return { ok: false, url, reason: "the quoted asset cannot be priced in USD (XRP, RLUSD, USDC supported)" };
    const best = priced[0] as { a: any; usd: number };
    if (best.usd > MONITOR_LIMITS.maxBuyUsd) {
      return { ok: false, url, reason: `price $${best.usd.toFixed(4)} per call exceeds the $${MONITOR_LIMITS.maxBuyUsd} per-test-buy cap funded from the plan fee: monitoring it would make the plan unprofitable` };
    }
    return { ok: true, ep: { url, method, ...(body ? { body } : {}), price_usd: String(Math.round(best.usd * 1e6) / 1e6), asset: acceptAsset(best.a), amount: String(best.a.amount ?? ""), checked_at: now(), source: "seller" } };
  }

  async function enroll(request: Request, base: string) {
    const b = await readJson(request);
    if (!b) return bad("invalid_json", "POST a JSON object (max 32 KB).");
    const proof = await verifyProof(deps.cfg.invoiceSecret, "monitor-enroll", b, now(), deps.fetch, deps.xrplRpc);
    if (!proof.ok) return json(proof.reason === "ledger_unavailable_retry" ? 503 : 403, { error: "payto_proof_failed", reason: proof.reason, challenge: `${base}/v1/monitor/challenge?pay_to=<payTo>` }, NO_STORE);
    const lc = proof.address.toLowerCase();
    const sx = await sanctioned("monitor_enroll", proof.address);
    if (sx) return sanctionedRes(sx);
    const recent = (await store.enrollmentsByPayTo([lc])).filter((x) => x.created_at > now() - DAY_MS);
    if (recent.length >= ENROLL_PER_PAYTO_PER_DAY) return json(429, { error: "too_many_enrollments", detail: `At most ${ENROLL_PER_PAYTO_PER_DAY} enrolments per payTo per day.` }, NO_STORE);
    const webhook = b.webhook_url == null || b.webhook_url === "" ? null : safeHttpsUrl(b.webhook_url);
    if (b.webhook_url && !webhook) return bad("invalid_webhook_url", "https URL with a public DNS name required.");
    const email = b.email == null || b.email === "" ? null : safeEmail(b.email);
    if (b.email && !email) return bad("invalid_email");
    const raw: any[] = Array.isArray(b.endpoints) ? b.endpoints : [];
    if (raw.length > MAX_SELLER_ENDPOINTS) return bad("too_many_endpoints", `At most ${MAX_SELLER_ENDPOINTS} endpoints per enrolment.`);
    const uniq = [...new Map(raw.map((x) => [`${String(x?.method ?? "GET").toUpperCase()} ${x?.url}`, x])).values()];
    const rate = deps.cfg.xrpRate?.usd ?? deps.cfg.xrpUsdFallback;
    const checks = await Promise.all(uniq.map((x) => checkEndpoint(x, proof, rate)));
    const accepted = checks.filter((c): c is { ok: true; ep: MonitorEndpoint } => c.ok).map((c) => c.ep);
    const rejected = checks.filter((c): c is { ok: false; url: string; reason: string } => !c.ok).map(({ url, reason }) => ({ url, reason }));
    // Audit scope also covers every catalog listing that pays this payTo (quote-checked at audit time).
    const listed = await deps.catalogStore.byPayTos([lc], MONITOR_LIMITS.endpoints.audit).catch(() => []);
    const have = new Set(accepted.map((x) => x.url));
    const catalogEps: MonitorEndpoint[] = listed.filter((r) => !have.has(r.resource) && r.method !== "MCP").map((r) => ({
      url: r.resource, method: r.method === "POST" ? "POST" : "GET", price_usd: r.price_usd == null ? null : String(r.price_usd), asset: null, amount: null, checked_at: null, source: "catalog" as const,
    }));
    if (!accepted.length && !catalogEps.length) {
      return json(422, { error: "no_monitorable_endpoint", rejected, detail: "Nothing was enrolled. Fix the endpoints above and enrol again with a fresh challenge.", note: "Not charged." }, NO_STORE);
    }
    const token = `lumi_mt_${randHex(24)}`;
    const secret = webhook ? `lumi_whs_${randHex(24)}` : null;
    let domain: string | null = null;
    try { domain = accepted[0] ? new URL(accepted[0].url).hostname : catalogEps[0] ? new URL(catalogEps[0].url).hostname : null; } catch { /* none */ }
    const e: Enrollment = {
      id: `men_${randHex(12)}`, network: proof.network, pay_to: proof.address, pay_to_lc: lc, domain,
      proof: JSON.stringify({ challenge: b.message, signature: b.signature, public_key: b.public_key ?? null, signer: proof.signer }), nonce: proof.nonce,
      endpoints: [...accepted, ...catalogEps], webhook_url: webhook, webhook_secret: secret, email, token_hash: await sha256(token),
      is_test: isTestWallet(proof.address, deps.extraTestWallets), created_at: now(),
    };
    if ((await store.addEnrollment(e)) === "nonce_used") return json(409, { error: "challenge_already_used", detail: "Request a fresh challenge." }, NO_STORE);
    return json(201, {
      enrollment_id: e.id,
      pay_to: e.pay_to,
      network: e.network,
      ...(e.is_test ? { test: "Owner-flagged Lumi test wallet: plans quote the test price and are shown publicly as tests." } : {}),
      endpoints: e.endpoints.map(epView),
      rejected,
      plans: planEconomics(e),
      pay: Object.fromEntries(MONITOR_PLANS.map((id) => [id, `${base}${PLANS[id].path}?enrollment=${e.id}`])),
      management_token: token,
      ...(secret ? { webhook_secret: secret } : {}),
      alerts: { webhook: !!webhook, email: !!email },
      seller_page: `${base}/v1/monitor/sellers/${e.id}`,
      note: "Store the management token (replies, full audit report) and webhook secret now: Lumi keeps only hashes / cannot show them again. The seller page goes public once a plan is paid.",
    }, NO_STORE);
  }

  const epView = (x: MonitorEndpoint) => ({ url: x.url, method: x.method, source: x.source, listed_price_usd: x.price_usd, ...(x.asset ? { asset: x.asset } : {}) });

  // ---------------- subscribe (x402)

  async function subscribe(request: Request, url: URL, plan: PlanId, base: string, ctx?: WaitUntil) {
    const id = url.searchParams.get("enrollment") ?? "";
    const paid = !!(request.headers.get(HEADER_PAYMENT_SIGNATURE) || request.headers.get(HEADER_X_PAYMENT));
    const e = ENROLL_ID_RE.test(id) ? await store.enrollment(id) : null;
    const resourceUrl = `${base}${PLANS[plan].path}`;
    if (!e) {
      if (paid) return id
        ? bad("enrollment_unknown", `enrollment ${id.slice(0, 40)} is unknown. Enrol first (POST ${base}/v1/monitor/enroll); the payment was not settled.`, { docs: `${base}/v1/monitor` })
        : bad("enrollment_required", `Missing ?enrollment=. Enrol first (POST ${base}/v1/monitor/enroll); the payment was not settled.`, { docs: `${base}/v1/monitor` });
      const q = planQuote(deps.cfg, plan, "none", PLANS[plan].usd, resourceUrl, false);
      q.note = id
        ? `List price. enrollment_unknown: enrollment ${id.slice(0, 40)} is unknown. Pass an enrollment_id from POST ${base}/v1/monitor/enroll (free, requires a payTo signature). A payment without a valid enrollment is refused before settlement.`
        : `List price. Add ?enrollment=<enrollment_id> from POST ${base}/v1/monitor/enroll (free, requires a payTo signature). A payment without a valid enrollment is refused before settlement.`;
      return paymentRequiredResponse(deps.cfg, q, id ? "enrollment_unknown" : "PAYMENT-SIGNATURE header is required");
    }
    const sx = await sanctioned("monitor_subscribe", e.pay_to, { enrollment_id: e.id });
    if (sx) return sanctionedRes(sx); // before any 402 or settlement
    const econ = planEconomics(e)[plan] as { eligible: boolean; reason?: string };
    if (!econ.eligible) return json(409, { error: "plan_not_eligible", plan, reason: econ.reason, enrollment_id: e.id, note: "Not charged." }, NO_STORE);
    const usd = planPriceUsd(plan, e.is_test, deps.testPriceUsd);
    const quote = planQuote(deps.cfg, plan, e.id, usd, `${resourceUrl}?enrollment=${e.id}`, e.is_test);
    return requirePayment(request, deps.cfg, deps.paywall(ctx), quote, async (s: Settlement, req: PaymentRequirements) => {
      const t = now();
      const prev = (await store.plansFor(e.id)).filter((p) => p.plan === plan && p.ends_at > t);
      const start = plan === "audit" ? t : Math.max(t, ...prev.map((p) => p.ends_at));
      const row: PlanRow = {
        id: `mpl_${randHex(10)}`, enrollment_id: e.id, plan, starts_at: start, ends_at: start + 30 * DAY_MS, paid_tx: s.transaction || `unknown_${randHex(8)}`,
        paid_network: s.network, paid_asset: assetLabel(req), paid_amount: String(req.amount), payer: s.payer ?? null, usd: Number(usd),
        budget_usd: Number(PLANS[plan].usd) * MONITOR_LIMITS.budgetShare, spent_usd: 0, is_test: e.is_test, reminded: 0, created_at: t,
      };
      const ins = await store.addPlan(row).catch((err) => { deps.log({ event: "monitor_plan_error", error: String(err) }); return "error" as const; });
      deps.log({ event: "monitor_plan_paid", plan, enrollment: e.id, test: e.is_test, inserted: ins });
      return json(201, {
        paid: true, plan: PLANS[plan].name, plan_id: row.id, enrollment_id: e.id, ...(e.is_test ? { test: true, price_usd: usd } : { price_usd: usd }),
        starts_at: iso(row.starts_at), ...(plan === "audit" ? { one_off: true, report_due_by: iso(row.starts_at + 2 * DAY_MS) } : { ends_at: iso(row.ends_at) }), auto_renew: false,
        ...(plan === "audit" ? {} : { renew: `${resourceUrl}?enrollment=${e.id}` }), endpoints: planEndpoints(e, plan).map(epView),
        seller_page: `${base}/v1/monitor/sellers/${e.id}`, badge: `${base}/v1/monitor/badge/${e.id}.svg`,
        note: plan === "audit" ? "The audit runs within 48 h; the signed report appears on your seller page (full report with your management token)." : "First test-buy within 24 h. Alerts go to the webhook/email given at enrolment.",
      }, NO_STORE);
    });
  }

  // ---------------- public entries

  /** Public plan row. One-off Audit plans have no term, so they show no `until`. */
  function planView(p: PlanRow) {
    const oneOff = PLANS[p.plan as PlanId]?.days == null;
    return { plan: p.plan, from: iso(p.starts_at), ...(oneOff ? { one_off: true } : { until: iso(p.ends_at) }), ...(p.is_test ? { test: true } : {}) };
  }

  async function sellerBundle(id: string) {
    if (!ENROLL_ID_RE.test(id)) return null;
    const e = await store.enrollment(id);
    if (!e) return null;
    const plans = await store.plansFor(id);
    if (!plans.length) return null; // not public until a plan is paid
    const [runs, findings, replies] = await Promise.all([store.runsFor(id, 200), store.findingsFor(id, 100), store.repliesFor(id)]);
    return { e, plans, runs, findings, replies };
  }

  function relationshipView(e: Enrollment, plans: PlanRow[], base: string) {
    const t = now();
    const cur = plans.filter((p) => p.starts_at <= t && t < p.ends_at);
    return {
      type: "seller_monitoring",
      status: cur.length ? "active" : "past",
      plans: plans.slice(0, 10).map(planView),
      disclosure: "This seller pays Lumi for monitoring (seller-funded test-buys). Paying never changes Lumi's score, tier or labels.",
      seller_page: `${base}/v1/monitor/sellers/${e.id}`,
      ...(e.is_test ? { test: "Lumi's own wallet, enrolled as a test" } : {}),
    };
  }

  async function sellerPage(id: string, base: string) {
    const x = await sellerBundle(id);
    if (!x) return json(404, { error: "not_found", detail: "Unknown enrollment, or no plan paid yet (entries are public once a plan is paid)." }, { "Cache-Control": "public, max-age=60" });
    const { e, plans, runs, findings, replies } = x;
    const badge = badgeStatus(e, plans, runs, now());
    const reports = await Promise.all(plans.filter((p) => p.plan === "audit").map((p) => store.report(p.id)));
    return json(200, {
      kind: "lumi_monitored_seller",
      enrollment_id: e.id,
      pay_to: e.pay_to,
      network: e.network,
      domain: e.domain,
      ...(e.is_test ? { test: true } : {}),
      commercial_relationship: relationshipView(e, plans, base),
      badge: { ...badgeJson(e, badge), svg: `${base}/v1/monitor/badge/${e.id}.svg`, json: `${base}/v1/monitor/badge/${e.id}.json` },
      endpoints: e.endpoints.map(epView),
      test_buys: runs.slice(0, 30).map((r) => ({ endpoint: r.endpoint, tested_at: iso(r.ts), outcome: r.outcome, http_status: r.http_status, data_returned: r.data_returned, funding: r.funding })),
      findings: findings.map((f) => ({ id: f.id, at: iso(f.ts), kind: f.kind, endpoint: f.endpoint, detail: f.detail, replies: replies.filter((r) => r.finding_id === f.id).map((r) => ({ at: iso(r.ts), by: "seller", text: r.text })) })),
      audit_reports: reports.filter((r): r is NonNullable<typeof r> => !!r).map((r) => ({ plan_id: r.plan_id, signed_at: iso(r.created_at), report_hash: r.report_hash, signer: r.signer, signature: r.signature, public_key: r.public_key, signed_message: `lumi-audit-report:${r.plan_id}:${r.report_hash}`, full_report: `${base}/v1/monitor/sellers/${e.id}/report?plan_id=${r.plan_id} (management token or the seller's own copy)` })),
      evidence: "Answer-only: test-buy outcomes and dates. Tx hashes are in the seller's signed audit report and Lumi's paid trust products.",
      safeguards: MONITOR_SAFEGUARDS,
      corrections: `${base}/v1/monitor/corrections`,
      disclaimer: "Dated observations, not an endorsement or guarantee. Not financial advice.",
    }, { "Cache-Control": "public, max-age=60" });
  }

  function badgeJson(e: Enrollment, b: ReturnType<typeof badgeStatus>) {
    if (b.ok) return { status: "monitored", label: e.is_test ? TEST_BADGE_LABEL : "Monitored by Lumi", last_test: iso(b.last_test), result: b.result, plan: b.plan.plan, ...(e.is_test ? { test: true } : {}) };
    return { status: "removed", label: "Lumi monitoring", reason: b.reason, reason_text: REASON_TEXT[b.reason], ...("last_test" in b && b.last_test ? { last_test: iso(b.last_test) } : {}) };
  }

  async function badge(id: string, fmt: string, base: string) {
    const x = await sellerBundle(id);
    const hdr = { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" };
    if (!x) {
      if (fmt === "json") return json(404, { status: "unknown", detail: "No monitored seller with this id." }, hdr);
      return new Response(badgeSvg("Lumi monitoring", "unknown seller", false), { status: 404, headers: { ...hdr, "Content-Type": "image/svg+xml" } });
    }
    const b = badgeStatus(x.e, x.plans, x.runs, now());
    const j = { ...badgeJson(x.e, b), enrollment_id: id, seller_page: `${base}/v1/monitor/sellers/${id}`, live: true, note: "Computed on every request: removed automatically when a test fails, no recent test exists, or the plan lapses." };
    if (fmt === "json") return json(200, j, hdr);
    const right = b.ok ? `last test ${iso(b.last_test)!.slice(0, 10)} · ${b.result}${x.e.is_test ? " · test" : ""}` : `badge removed: ${REASON_TEXT[b.reason]}`;
    return new Response(badgeSvg(b.ok ? (x.e.is_test ? TEST_BADGE_LABEL : "Monitored by Lumi") : "Lumi monitoring", right, b.ok), { headers: { ...hdr, "Content-Type": "image/svg+xml" } });
  }

  async function sellers(base: string) {
    const all = await store.enrollments(200);
    const t = now();
    const out = [];
    let tests = 0;
    for (const e of all.slice(0, 40)) {
      const plans = await store.plansFor(e.id);
      if (!plans.length) continue;
      if (e.is_test) { tests++; continue; } // Lumi's own test enrolments are not paying sellers
      out.push({ enrollment_id: e.id, pay_to: e.pay_to, network: e.network, domain: e.domain, status: plans.some((p) => p.starts_at <= t && t < p.ends_at) ? "active" : "past", ...(e.is_test ? { test: true } : {}), page: `${base}/v1/monitor/sellers/${e.id}` });
    }
    return json(200, { kind: "lumi_monitored_sellers", sellers: out, count: out.length, excluded_test_enrollments: tests,
      disclosure: SELLERS_DISCLOSURE, ...(out.length ? {} : { note: "No paying seller yet." }), docs: `${base}/v1/monitor` }, { "Cache-Control": "public, max-age=120" });
  }

  async function tokenOk(request: Request, e: Enrollment) {
    const t = bearer(request);
    return !!t && (await sha256(t)) === e.token_hash;
  }

  async function reply(request: Request) {
    // No credentials at all -> 401 up front (audit 2026-10-23b L-12), so an unauthenticated caller never sees 404 unknown_enrollment
    if (!bearer(request)) return json(401, { error: "management_token_required", hint: "Authorization: Bearer <management token from enrolment>" }, { ...NO_STORE, "WWW-Authenticate": "Bearer" });
    const b = await readJson(request, 8000);
    if (!b) return bad("invalid_json");
    const e = ENROLL_ID_RE.test(String(b.enrollment_id ?? "")) ? await store.enrollment(String(b.enrollment_id)) : null;
    if (!e) return json(404, { error: "unknown_enrollment" }, NO_STORE);
    if (!(await tokenOk(request, e))) return json(401, { error: "management_token_required", hint: "Authorization: Bearer <management token from enrolment>" }, NO_STORE);
    const text = typeof b.text === "string" ? b.text.trim().replace(/[\u0000-\u0008\u000b-\u001f]/g, "") : "";
    if (!text || text.length > 1000) return bad("text_required", "1-1000 characters.");
    const fid = Number(b.finding_id);
    const f = (await store.findingsFor(e.id, 500)).find((x) => x.id === fid);
    if (!f) return json(404, { error: "unknown_finding" }, NO_STORE);
    const id = await store.addReply({ enrollment_id: e.id, finding_id: fid, ts: now(), text });
    return json(201, { replied: true, reply_id: id, note: "Shown next to the finding. Findings themselves cannot be edited or removed." }, NO_STORE);
  }

  async function sellerReport(request: Request, id: string, url: URL) {
    const e = ENROLL_ID_RE.test(id) ? await store.enrollment(id) : null;
    if (!e) return json(404, { error: "not_found" }, NO_STORE);
    if (!(await tokenOk(request, e)) && !(await deps.isOwner(request))) return json(401, { error: "management_token_required" }, NO_STORE);
    const r = await store.report(url.searchParams.get("plan_id") ?? "");
    if (!r || r.enrollment_id !== e.id) return json(404, { error: "no_report" }, NO_STORE);
    return json(200, { report: JSON.parse(r.report), report_hash: r.report_hash, signed_message: `lumi-audit-report:${r.plan_id}:${r.report_hash}`, signature: r.signature, public_key: r.public_key, signer: r.signer, verify: "sha256(canonical JSON of report) = report_hash; ripple-keypairs verify(utf8hex(signed_message), signature, public_key) and deriveAddress(public_key) = signer (Lumi's XRPL payTo)." }, NO_STORE);
  }

  async function corrections() {
    const c = await store.corrections(200);
    return json(200, { kind: "lumi_correction_log", corrections: c.map((x) => ({ id: x.id, at: iso(x.ts), subject: x.subject, summary: x.summary, ref: x.ref })), note: "Append-only. Every correction Lumi makes to published observations is listed here." }, { "Cache-Control": "public, max-age=120" });
  }

  // ---------------- alerts

  async function deliver(e: Enrollment, f: FindingRow, base: string): Promise<string[]> {
    const via: string[] = [];
    const page = `${base}/v1/monitor/sellers/${e.id}`;
    if (e.webhook_url && e.webhook_secret) {
      const body = JSON.stringify({ type: "lumi.monitor.finding", enrollment_id: e.id, finding: { id: f.id, kind: f.kind, endpoint: f.endpoint, detail: f.detail, at: iso(f.ts) }, seller_page: page, ...(e.is_test ? { test: true } : {}) });
      const ts = Math.floor(now() / 1000);
      const sig = await hmacHex(e.webhook_secret, `${ts}.${body}`);
      try {
        const r = await deps.fetch(e.webhook_url, { method: "POST", headers: { "Content-Type": "application/json", "X-Lumi-Signature": `t=${ts},v1=${sig}`, "User-Agent": "LumiMonitor/1.0" }, body, signal: AbortSignal.timeout(8000), redirect: "manual" });
        if (r.ok) via.push("webhook");
      } catch { /* best effort */ }
    }
    if (e.email) {
      const text = `Lumi monitoring alert (${f.kind})${e.is_test ? " [test]" : ""}\n\n${f.endpoint ? `Endpoint: ${f.endpoint}\n` : ""}${f.detail}\n\nSeller page: ${page}\nReply to a finding: POST ${base}/v1/monitor/replies with your management token.\n`;
      if (await sendPlainEmail({ emailFrom: deps.email.from, emailBinding: deps.email.binding, makeMessage: deps.email.makeMessage }, e.email, `Lumi monitor: ${f.kind}${f.endpoint ? ` ${f.endpoint}` : ""}`, text, `mon.${e.id}.${f.id}.${f.ts}`)) via.push("email");
    }
    if (f.id) await store.setDelivered(f.id, via.join(",") || "none").catch(() => {});
    return via;
  }

  // ---------------- owner: due tasks, results, reports

  async function due(base: string) {
    const t = now();
    const plans = (await store.plansEndingAfter(t)).filter((p) => p.starts_at <= t).slice(0, 10);
    const tasks: Record<string, unknown>[] = [];
    for (const p of plans) {
      const e = await store.enrollment(p.enrollment_id);
      if (!e) continue;
      if (p.plan === "audit" && (await store.report(p.id))) continue;
      if (await sanctioned("monitor_due", e.pay_to, { enrollment_id: e.id, plan_id: p.id })) continue; // never hand a listed payTo to the test-buy runner
      const runs = (await store.runsFor(e.id, 400)).filter((r) => r.plan_id === p.id);
      let budgetLeft = p.budget_usd - p.spent_usd;
      for (const ep of planEndpoints(e, p.plan)) {
        const mine = runs.filter((r) => r.endpoint === ep.url);
        const last = mine[0];
        let isDue = false;
        if (p.plan === "monitor") isDue = mine.length === 0 || (mine.length === 1 && failed(last) && t - last.ts > 3_600_000);
        else if (p.plan === "monitor_plus") isDue = mine.length < MONITOR_LIMITS.buysPerEndpoint.monitor_plus && (!last || t - last.ts >= MONITOR_LIMITS.everyMs.monitor_plus - 3_600_000);
        else isDue = mine.length === 0;
        if (!isDue) continue;
        const price = ep.price_usd == null ? null : Number(ep.price_usd);
        const buy = price != null && price <= MONITOR_LIMITS.maxBuyUsd && price <= budgetLeft;
        if (buy) budgetLeft -= price!;
        tasks.push({
          plan_id: p.id, plan: p.plan, enrollment_id: e.id, network: e.network, pay_to: e.pay_to, endpoint: { url: ep.url, method: ep.method, ...(ep.body ? { body: ep.body } : {}) },
          mode: buy ? "buy" : "quote_only", max_usd: buy ? Math.min(MONITOR_LIMITS.maxBuyUsd, price! * 1.15) : 0, enrolled_price_usd: ep.price_usd, ...(p.is_test ? { test: true } : {}),
          ...(!buy ? { why: price == null ? "unpriced listing" : price > MONITOR_LIMITS.maxBuyUsd ? "above the $0.10 cap" : "plan test-buy budget used" } : {}),
        });
        if (tasks.length >= 25) break;
      }
      if (tasks.length >= 25) break;
    }
    return json(200, { kind: "monitor_due", generated_at: iso(t), tasks, post_results: `${base}/v1/owner/monitor/results` }, NO_STORE);
  }

  /** XRP amounts are stored in drops; show them in XRP. */
  const amt = (a: string | null, asset: string | null) => (a == null ? "?" : asset === "XRP" && /^\d+$/.test(a) ? `${Number(a) / 1e6} XRP` : `${a} ${asset ?? ""}`.trim());

  function priceChanged(prev: { amount: string | null; asset: string | null; usd: number | null }, cur: { amount: string | null; asset: string | null; usd: number | null }) {
    if (!cur.asset || !prev.asset) return false;
    if (prev.asset !== cur.asset) {
      // A different payment option of the same quote (e.g. enrolled RLUSD, bought XRP): compare in USD, never by asset alone.
      if (prev.usd == null || cur.usd == null || prev.usd === 0) return false;
      return Math.abs(cur.usd - prev.usd) / prev.usd > 0.1;
    }
    if (prev.amount === cur.amount) return false;
    if (prev.usd == null || cur.usd == null || prev.usd === 0) return prev.amount !== cur.amount;
    return Math.abs(cur.usd - prev.usd) / prev.usd > 0.1;
  }

  async function results(request: Request, base: string, ctx?: WaitUntil) {
    const b = await readJson(request, 64_000);
    const list: any[] = Array.isArray(b?.results) ? b!.results.slice(0, 25) : [];
    if (!list.length) return bad("results_required");
    const t = now();
    const out: unknown[] = [];
    const cache = new Map<string, { e: Enrollment; plans: PlanRow[]; runs: RunRow[] }>();
    const alerts: Promise<unknown>[] = [];
    for (const x of list) {
      const eid = String(x?.enrollment_id ?? "");
      let c = cache.get(eid);
      if (!c) {
        const e = ENROLL_ID_RE.test(eid) ? await store.enrollment(eid) : null;
        if (!e) { out.push({ error: "unknown_enrollment", enrollment_id: eid }); continue; }
        c = { e, plans: await store.plansFor(eid), runs: await store.runsFor(eid, 200) };
        cache.set(eid, c);
      }
      const plan = c.plans.find((p) => p.id === x.plan_id);
      const ep = c.e.endpoints.find((y) => y.url === x.endpoint);
      if (!plan || !ep) { out.push({ error: "unknown_plan_or_endpoint", plan_id: x.plan_id, endpoint: x.endpoint }); continue; }
      const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
      const str = (v: unknown, n = 200) => (v == null || v === "" ? null : String(v).slice(0, n));
      const cost = Math.max(0, Math.min(MONITOR_LIMITS.maxBuyUsd, num(x.cost_usd) ?? 0));
      const run: RunRow = {
        enrollment_id: c.e.id, plan_id: plan.id, endpoint: ep.url, ts: num(x.ts) ?? t, network: str(x.network, 40), tx_hash: str(x.tx_hash, 100), amount: str(x.amount, 40), asset: str(x.asset, 60),
        cost_usd: x.tx_hash ? cost : 0, http_status: num(x.http_status), data_returned: x.data_returned === true, latency_ms: num(x.latency_ms),
        outcome: ["delivered", "no_data", "invalid_data", "error_status", "timeout", "quote_failed", "quote_only", "skipped"].includes(x.outcome) ? x.outcome : "skipped",
        quote_pay_to: str(x.quote_pay_to, 80), quote_price_usd: str(x.quote_price_usd, 20), schema_hash: str(x.schema_hash, 80), note: str(x.note, 300), funding: "seller-funded",
      };
      const prev = c.runs.find((r) => r.endpoint === ep.url && r.outcome !== "skipped");
      const runId = await store.addRun(run);
      run.id = runId;
      if (run.cost_usd) await store.addSpent(plan.id, run.cost_usd);
      const kinds: { kind: string; detail: string }[] = [];
      const paidNote = run.tx_hash ? "Payment settled" : "Paid retry";
      if (run.outcome === "no_data") kinds.push({ kind: "paid_no_data", detail: `${paidNote} but no data came back (HTTP ${run.http_status ?? "?"}).` });
      if (run.outcome === "invalid_data") kinds.push({ kind: "paid_invalid_data", detail: `${paidNote} but the body was not valid data (${run.note ?? "unparseable"}).` });
      if (run.outcome === "error_status") kinds.push({ kind: (run.http_status ?? 0) >= 500 ? "http_5xx" : "http_error", detail: `${paidNote}; the endpoint answered HTTP ${run.http_status ?? "?"}.` });
      if (run.outcome === "timeout") kinds.push({ kind: "timeout", detail: "No answer within 20 s." });
      if (run.outcome === "quote_failed") kinds.push({ kind: "http_error", detail: `The unpaid request did not return a valid x402 quote (${run.note ?? "no 402"}).` });
      if (run.quote_pay_to && run.quote_pay_to.toLowerCase() !== c.e.pay_to_lc && (!prev || (prev.quote_pay_to ?? "").toLowerCase() !== run.quote_pay_to.toLowerCase())) {
        kinds.push({ kind: "pay_to_changed", detail: `The quote now pays ${run.quote_pay_to}, not the enrolled payTo ${c.e.pay_to}.` });
      }
      const base0 = prev ? { amount: prev.amount, asset: prev.asset, usd: num(prev.quote_price_usd) } : { amount: ep.amount, asset: ep.asset, usd: num(ep.price_usd) };
      if (priceChanged(base0, { amount: run.amount, asset: run.asset, usd: num(run.quote_price_usd) })) {
        kinds.push({ kind: "price_changed", detail: `Quoted price changed from ${amt(base0.amount, base0.asset)} (~$${base0.usd ?? "?"}) to ${amt(run.amount, run.asset)} (~$${run.quote_price_usd ?? "?"}).` });
      }
      if (prev?.schema_hash && run.schema_hash && prev.schema_hash !== run.schema_hash && run.outcome === "delivered") kinds.push({ kind: "schema_changed", detail: "The structure (keys/types) of the paid response changed since the previous test." });
      if (failed(prev) && run.outcome === "delivered") kinds.push({ kind: "recovered", detail: "The endpoint delivers again after a failed test." });
      const fids: number[] = [];
      for (const k of kinds) {
        const f: FindingRow = { enrollment_id: c.e.id, endpoint: ep.url, ts: run.ts, kind: k.kind, detail: k.detail, run_id: runId, delivered: null };
        f.id = await store.addFinding(f);
        fids.push(f.id);
        alerts.push(deliver(c.e, f, base));
      }
      c.runs.unshift(run);
      out.push({ run_id: runId, endpoint: ep.url, outcome: run.outcome, findings: kinds.map((k) => k.kind), finding_ids: fids });
    }
    const all = Promise.allSettled(alerts);
    if (ctx) ctx.waitUntil(all); else await all;
    return json(200, { recorded: out }, NO_STORE);
  }

  async function reportDraft(url: URL) {
    const pid = url.searchParams.get("plan_id") ?? "";
    const eid = url.searchParams.get("enrollment_id") ?? "";
    const e = ENROLL_ID_RE.test(eid) ? await store.enrollment(eid) : null;
    const plan = e ? (await store.plansFor(e.id)).find((p) => p.id === pid && p.plan === "audit") : undefined;
    if (!e || !plan) return json(404, { error: "unknown_audit_plan" }, NO_STORE);
    const runs = (await store.runsFor(e.id, 400)).filter((r) => r.plan_id === plan.id);
    const findings = (await store.findingsFor(e.id, 200)).filter((f) => runs.some((r) => r.id === f.run_id));
    const eps = planEndpoints(e, "audit").map((ep) => {
      const r = runs.find((x) => x.endpoint === ep.url);
      return {
        url: ep.url, method: ep.method, source: ep.source, enrolled_price_usd: ep.price_usd,
        result: r ? { tested_at: iso(r.ts), outcome: r.outcome, http_status: r.http_status, data_returned: r.data_returned, latency_ms: r.latency_ms, quote_pay_to: r.quote_pay_to, pays_enrolled_pay_to: r.quote_pay_to ? r.quote_pay_to.toLowerCase() === e.pay_to_lc : null, quoted: r.amount ? `${r.amount} ${r.asset}` : null, quote_price_usd: r.quote_price_usd, tx_hash: r.tx_hash, explorer: r.tx_hash && r.network ? explorerFor(r.network, r.tx_hash) : null, cost_usd: r.cost_usd, funding: r.funding, note: r.note } : { outcome: "not_tested" },
      };
    });
    const count = (o: string) => eps.filter((x) => (x.result as any).outcome === o).length;
    const report = {
      kind: "lumi_audit_report", version: 1, plan_id: plan.id, enrollment_id: e.id,
      seller: { pay_to: e.pay_to, network: e.network, domain: e.domain }, ...(plan.is_test ? { test: true } : {}),
      paid: { tx: plan.paid_tx, network: plan.paid_network, asset: plan.paid_asset, amount: plan.paid_amount, at: iso(plan.created_at) },
      summary: { endpoints: eps.length, bought: eps.filter((x) => (x.result as any).tx_hash).length, delivered: count("delivered"), failed: eps.filter((x) => failed({ outcome: (x.result as any).outcome } as RunRow) && (x.result as any).outcome !== "not_tested").length, quote_only: count("quote_only"), not_tested: count("not_tested"), test_buy_spend_usd: Math.round(runs.reduce((s, r) => s + r.cost_usd, 0) * 1e6) / 1e6 },
      endpoints: eps,
      findings: findings.map((f) => ({ kind: f.kind, endpoint: f.endpoint, at: iso(f.ts), detail: f.detail })),
      funding: "seller-funded",
      methodology: MONITOR_METHODOLOGY.checks,
      disclaimer: "Dated observations of single test-buys, not an endorsement, audit opinion or guarantee. Not financial advice.",
      generated_at: iso(now()),
    };
    const report_hash = await sha256(canonicalJson(report));
    return json(200, { report, report_hash, message: `lumi-audit-report:${plan.id}:${report_hash}`, sign_with: deps.reportSigners[0] }, NO_STORE);
  }

  async function putReport(request: Request) {
    const b = await readJson(request, 200_000);
    if (!b?.report || typeof b.report !== "object") return bad("report_required");
    const hash = await sha256(canonicalJson(b.report));
    if (hash !== b.report_hash) return bad("report_hash_mismatch");
    const pid = String(b.report.plan_id ?? ""), eid = String(b.report.enrollment_id ?? "");
    const plan = ENROLL_ID_RE.test(eid) ? (await store.plansFor(eid)).find((p) => p.id === pid && p.plan === "audit") : undefined;
    if (!plan) return json(404, { error: "unknown_audit_plan" }, NO_STORE);
    const msg = `lumi-audit-report:${pid}:${hash}`;
    const pk = String(b.public_key ?? ""), sig = String(b.signature ?? "");
    const signer = pk ? xrplAddressOf(pk) : null;
    if (!signer || !deps.reportSigners.includes(signer) || !verifyXrplSignature(msg, sig, pk)) return json(403, { error: "bad_report_signature", detail: "Must be signed by Lumi's XRPL payTo key." }, NO_STORE);
    await store.putReport({ plan_id: pid, enrollment_id: eid, report: canonicalJson(b.report), report_hash: hash, signature: sig, public_key: pk, signer, created_at: now() });
    return json(201, { stored: true, plan_id: pid, report_hash: hash, signer }, NO_STORE);
  }

  async function owner(base: string) {
    const es = await store.enrollments(50);
    const t = now();
    const rows = [];
    for (const e of es.slice(0, 20)) {
      const plans = await store.plansFor(e.id);
      rows.push({ enrollment_id: e.id, pay_to: e.pay_to, network: e.network, test: e.is_test, alerts: { webhook: !!e.webhook_url, email: !!e.email }, endpoints: e.endpoints.length, created_at: iso(e.created_at),
        plans: plans.map((p) => ({ id: p.id, plan: p.plan, active: p.starts_at <= t && t < p.ends_at, starts_at: iso(p.starts_at), ends_at: iso(p.ends_at), usd: p.usd, test: p.is_test, budget_usd: p.budget_usd, spent_usd: p.spent_usd, paid_tx: p.paid_tx, payer: p.payer })) });
    }
    return json(200, { kind: "owner_monitor", enrollments: rows, due: `${base}/v1/owner/monitor/due` }, NO_STORE);
  }

  // ---------------- cron: renewal reminders + lapse notices (capped per run)

  async function cron(base: string) {
    const t = now();
    const plans = (await store.plansEndingAfter(t - 7 * DAY_MS)).filter((p) => MONITORING.has(p.plan));
    let sent = 0;
    for (const p of plans) {
      if (sent >= 5) break;
      const later = plans.some((q) => q.enrollment_id === p.enrollment_id && q.plan === p.plan && q.ends_at > p.ends_at);
      if (later) continue;
      const remind = p.reminded < 1 && p.ends_at > t && p.ends_at - t <= MONITOR_LIMITS.reminderBeforeMs;
      const lapse = p.reminded < 2 && p.ends_at <= t && !plans.some((q) => q.enrollment_id === p.enrollment_id && MONITORING.has(q.plan) && q.starts_at <= t && t < q.ends_at);
      if (!remind && !lapse) continue;
      const e = await store.enrollment(p.enrollment_id);
      if (!e) continue;
      const f: FindingRow = remind
        ? { enrollment_id: e.id, endpoint: null, ts: t, kind: "renewal_due", detail: `${PLANS[p.plan as PlanId].name} ends ${iso(p.ends_at)}. No auto-renew: renew by paying again at ${base}${PLANS[p.plan as PlanId].path}?enrollment=${e.id}.`, run_id: null, delivered: null }
        : { enrollment_id: e.id, endpoint: null, ts: t, kind: "plan_lapsed", detail: `${PLANS[p.plan as PlanId].name} ended ${iso(p.ends_at)}; monitoring stopped and the badge was removed. Renew: ${base}${PLANS[p.plan as PlanId].path}?enrollment=${e.id}.`, run_id: null, delivered: null };
      f.id = await store.addFinding(f);
      await deliver(e, f, base);
      await store.setReminded(p.id, remind ? 1 : 2);
      sent++;
    }
    return { reminders_or_lapses: sent };
  }

  /** Disclosure for lookups: payTo (lowercase) -> commercial relationship. */
  async function relationships(payTos: string[], base: string): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    const lc = [...new Set(payTos.map((p) => p.toLowerCase()))];
    if (!lc.length) return out;
    const es = await store.enrollmentsByPayTo(lc);
    for (const e of es.slice(0, 5)) {
      const plans = await store.plansFor(e.id);
      if (!plans.length) continue;
      const v = relationshipView(e, plans, base);
      const cur = out.get(e.pay_to_lc);
      if (!cur || (cur.status !== "active" && v.status === "active")) out.set(e.pay_to_lc, { pay_to: e.pay_to, ...v });
    }
    return out;
  }

  async function handle(request: Request, path: string, url: URL, base: string, ctx?: WaitUntil): Promise<Response | null> {
    const m = request.method;
    const get = m === "GET" || m === "HEAD";
    if (path === "/v1/monitor" && get) return json(200, doc(base), { "Cache-Control": "public, max-age=600" });
    if (path === "/v1/monitor/challenge" && get) {
      const a = (url.searchParams.get("pay_to") ?? url.searchParams.get("payTo") ?? "").trim();
      const sx = await sanctioned("monitor_challenge", a);
      if (sx) return sanctionedRes(sx);
      const c = await makeChallenge(deps.cfg.invoiceSecret, "monitor-enroll", a, now());
      if (!c) return a ? bad("invalid_pay_to", "pay_to is not a valid XRPL r-address or Base 0x address.", { example: "?pay_to=<XRPL r-address or Base 0x address>" }) : bad("pay_to_required", "?pay_to=<XRPL r-address or Base 0x address>");
      return json(200, { ...c, sign: c.network === "xrpl:0" ? "ripple-keypairs sign(utf8 hex of message, privateKey) with the payTo's master or regular key; send public_key too" : "EIP-191 personal_sign(message) from the payTo", next: `POST ${base}/v1/monitor/enroll` }, NO_STORE);
    }
    if (path === "/v1/monitor/enroll") return m === "POST" ? enroll(request, base) : json(405, { error: "method_not_allowed", detail: `POST JSON. Docs: ${base}/v1/monitor` }, { Allow: "POST, OPTIONS" });
    if (path === "/v1/monitor/replies") return m === "POST" ? reply(request) : json(405, { error: "method_not_allowed" }, { Allow: "POST, OPTIONS" });
    const sub = path.match(/^\/v1\/monitor\/subscribe\/([^/]+)$/);
    if (sub && get) {
      const p = sub[1];
      if ((MONITOR_PLANS as string[]).includes(p)) return subscribe(request, url, p as PlanId, base, ctx);
      if (/[{}<>:[\]$]/.test(decodeURIComponent(p))) return bad("path_template_not_filled", "Use monitor, monitor_plus or audit.", { example: `${base}/v1/monitor/subscribe/monitor?enrollment=<enrollment_id>` });
      return json(404, { error: "unknown_plan", plans: MONITOR_PLANS }, NO_STORE);
    }
    if (path === "/v1/monitor/sellers" && get) return sellers(base);
    const sp = path.match(/^\/v1\/monitor\/sellers\/([^/]+)$/);
    if (sp && get) return sellerPage(sp[1], base);
    const rp = path.match(/^\/v1\/monitor\/sellers\/([^/]+)\/report$/);
    if (rp && get) return sellerReport(request, rp[1], url);
    const bp = path.match(/^\/v1\/monitor\/badge\/([^/.]+)\.(svg|json)$/);
    if (bp && get) return badge(bp[1], bp[2], base);
    if (path === "/v1/monitor/corrections" && get) return corrections();
    if (path.startsWith("/v1/owner/monitor") || path === "/v1/owner/corrections") {
      const deny = await ownerOnly(request);
      if (deny) return deny;
      if (path === "/v1/owner/monitor" && get) return owner(base);
      if (path === "/v1/owner/monitor/due" && get) return due(base);
      if (path === "/v1/owner/monitor/results" && m === "POST") return results(request, base, ctx);
      if (path === "/v1/owner/monitor/report-draft" && get) return reportDraft(url);
      if (path === "/v1/owner/monitor/report" && m === "POST") return putReport(request);
      if (path === "/v1/owner/corrections" && m === "POST") {
        const b = await readJson(request);
        const subject = String(b?.subject ?? "").slice(0, 200), summary = String(b?.summary ?? "").slice(0, 2000);
        if (!subject || !summary) return bad("subject_and_summary_required");
        const id = await store.addCorrection({ ts: now(), subject, summary, ref: b?.ref ? String(b.ref).slice(0, 300) : null });
        return json(201, { id }, NO_STORE);
      }
      return json(404, { error: "not_found" }, NO_STORE);
    }
    return null;
  }

  return { handle, cron, relationships, doc };
}
