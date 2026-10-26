import { describe, it, expect } from "vitest";
import { deriveAddress, deriveKeypair, generateSeed, sign } from "ripple-keypairs";
import { createApp } from "../src/app";
import { FACILITATOR, DATA, NOW, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";
import { MONITOR_LIMITS, PLANS, WATCH_DISCOUNTS, WATCH_FREE, WATCH_TRIAL, WATCH_TIERS, planPriceUsd, watchDiscount, watchPrice, MONITOR_PRICE_TEXT, WATCH_PRO_BUYS, WATCH_TRIAL_END, PAID_BADGE_LABEL, TRIAL_BADGE_LABEL } from "../src/commerce/plans";
import { watchEconomics } from "../src/commerce/monitor";

const BASE = "https://lumi.test";
const OWNER = "owner-key-for-tests-0123456789-abcdefghijklmnop";
const seed = generateSeed({ entropy: Uint8Array.from({ length: 16 }, (_, i) => i + 7) });
const kp = deriveKeypair(seed);
const SELLER = deriveAddress(kp.publicKey);
const DAY = 86_400_000;
const auth = { Authorization: `Bearer ${OWNER}` };
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();

function setup(extra: Record<string, string> = {}) {
  const env = { XRPL_NETWORK: "xrpl:1", PAY_TO: SELLER, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PUBLIC_BASE_URL: BASE, OWNER_MCP_KEY: OWNER, ...extra };
  let t = NOW;
  const fac = happyFacilitator();
  const inner = makeFetch(fac);
  const wellKnown = { body: "" as string };
  const fetches: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    fetches.push(url);
    if (url === `${BASE}/.well-known/lumi-monitor.txt`) return new Response(wellKnown.body || "nope", { status: wellKnown.body ? 200 : 404 });
    return inner(input, init);
  }) as typeof fetch;
  const app = createApp(env as any, { fetch: f, log: () => {}, now: () => t });
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(BASE + path, init));
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => req(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });
  return { app, req, post, fac, wellKnown, fetches, advance: (ms: number) => (t += ms), now: () => t };
}
type S = ReturnType<typeof setup>;

async function enroll(s: S, endpoints: unknown[] = [{ url: `${BASE}/v1/verdict?url=https://a.example/x` }]) {
  const { message } = await (await s.req(`/v1/monitor/challenge?pay_to=${SELLER}`)).json();
  const r = await s.post("/v1/monitor/enroll", { message, signature: sign(hex(message), kp.privateKey), public_key: kp.publicKey, endpoints });
  expect(r.status).toBe(201);
  return r.json();
}
async function quote(s: S, path: string) {
  const q = await s.req(path);
  return { status: q.status, body: await q.json() };
}
async function pay(s: S, path: string) {
  const q = await quote(s, path);
  expect(q.status).toBe(402);
  const xrp = q.body.accepts.find((a: any) => a.asset === "XRP");
  const r = await s.req(path, { headers: { "PAYMENT-SIGNATURE": paymentHeaderFor(xrp) } });
  return { status: r.status, body: await r.json() };
}
const iou = (q: any) => q.accepts.find((a: any) => a.asset !== "XRP").amount;
const settles = (s: S) => s.fac.calls.filter((c: any) => c.path === "/settle").length;
async function trialProof(s: S, domain = "lumi.test") {
  const c = await (await s.req(`/v1/monitor/trial/challenge?pay_to=${SELLER}&domain=${domain}`)).json();
  return { c, proof: { message: c.message, signature: sign(hex(c.message), kp.privateKey), public_key: kp.publicKey } };
}

describe("Watch pricing", () => {
  it("prices per endpoint per 30 days with the volume and prepay discounts", () => {
    expect([PLANS.watch.usd, PLANS.watch_plus.usd, PLANS.watch_pro.usd, PLANS.audit.usd]).toEqual(["5", "12", "20", "99"]);
    expect(watchPrice("watch", 1)!.total_usd).toBe("5");
    expect(watchPrice("watch_plus", 4)!.total_usd).toBe("48");
    expect(watchPrice("watch", 9)!.total_usd).toBe("45");
    expect(watchPrice("watch", 10)!).toMatchObject({ total_usd: "40", volume_discount: 0.2, prepay_discount: 0 });
    expect(watchPrice("watch_plus", 2, 3)!).toMatchObject({ total_usd: "64.8", prepay_discount: 0.1, list_usd: 72 });
    expect(watchPrice("watch_pro", 10, 3)!.total_usd).toBe("480"); // 20 x 10 x 3 x 0.8 (discounts do not stack)
    expect(watchPrice("watch", 0)).toBeNull();
    expect(watchPrice("watch", 21)).toBeNull();
    expect(watchPrice("watch", 1, 2)).toBeNull();
    expect(watchPrice("audit", 1)).toBeNull();
    expect(planPriceUsd("watch", false, undefined, { endpoints: 3 })).toBe("15");
    expect(planPriceUsd("watch", true, undefined, { endpoints: 3 })).toBe("0.01");
    // legacy ids keep their prices (grandfathered)
    expect([PLANS.monitor.usd, PLANS.monitor_plus.usd]).toEqual(["9", "29"]);
  });

  it("discounts do not stack: only the larger of volume (20%) and prepay (10%) applies", () => {
    expect(WATCH_DISCOUNTS).toMatchObject({ volume: 0.2, prepay: 0.1, volumeMinEndpoints: 10, prepayTerms: 3 });
    expect(watchDiscount(1, 1)).toEqual({ rate: 0, kind: null });
    expect(watchDiscount(10, 1)).toEqual({ rate: 0.2, kind: "volume" });
    expect(watchDiscount(9, 3)).toEqual({ rate: 0.1, kind: "prepay" });
    expect(watchDiscount(10, 3)).toEqual({ rate: 0.2, kind: "volume", not_stacked: "prepay" });
    expect(watchDiscount(20, 3)).toEqual({ rate: 0.2, kind: "volume", not_stacked: "prepay" });
    // both eligible: 20% off, never 0.8 x 0.9 = 28%
    for (const id of ["watch", "watch_plus", "watch_pro"] as const) {
      const p = watchPrice(id, 10, 3)!, list = Number(PLANS[id].usd) * 30;
      expect(p).toMatchObject({ list_usd: list, discount: 0.2, discount_applied: "volume", volume_discount: 0.2, prepay_discount: 0, discount_not_stacked: "prepay" });
      expect(Number(p.total_usd)).toBeCloseTo(list * 0.8, 6);
      expect(Number(p.total_usd)).not.toBeCloseTo(list * 0.72, 2);
    }
    expect(watchPrice("watch_plus", 9, 3)).toMatchObject({ total_usd: "291.6", discount_applied: "prepay", volume_discount: 0 });
    expect(watchPrice("watch", 1, 1)).toMatchObject({ discount: 0, discount_applied: null });
    expect(watchPrice("watch", 1, 1)!.discount_not_stacked).toBeUndefined();
    expect(MONITOR_PRICE_TEXT).toMatch(/do not stack/);
  });

  it("Watch Pro at the 20% volume discount: worst-case buys exceed half the fee, so the enrolment gate decides", () => {
    const t = WATCH_TIERS.watch_pro, chains = t.chains as number;
    const p = watchPrice("watch_pro", 10, 1)!;
    expect(p.per_endpoint_term_usd).toBe(16); // $20 - 20%
    const budget = p.per_endpoint_term_usd * MONITOR_LIMITS.budgetShare; // $8.00 per endpoint per term
    const worst = t.buysPerTerm * chains * t.maxBuyUsd; // 30 daily buys x 3 chains x $0.10 = $9.00
    expect(budget).toBeCloseTo(8, 6);
    expect(worst).toBeCloseTo(9, 6);
    expect(worst).toBeGreaterThan(budget);
    // at list price (or with the 10% prepay discount alone) the worst case still fits
    expect(worst).toBeLessThanOrEqual(Number(PLANS.watch_pro.usd) * MONITOR_LIMITS.budgetShare);
    expect(worst).toBeLessThanOrEqual(watchPrice("watch_pro", 1, 3)!.per_endpoint_term_usd * MONITOR_LIMITS.budgetShare + 1e-9);
    // Watch and Watch Plus fit even at 20% off
    for (const id of ["watch", "watch_plus"] as const) {
      const w = WATCH_TIERS[id];
      expect(w.buysPerTerm * w.maxBuyUsd, id).toBeLessThanOrEqual(watchPrice(id, 10, 1)!.per_endpoint_term_usd * MONITOR_LIMITS.budgetShare);
    }
    // the enrolment gate rejects a 10-endpoint Watch Pro whose 3 chains are all priced at the $0.10 cap, and accepts $0.08
    const mk = (usd: number) => ({
      id: "e1", network: "xrpl:0", pay_to: "rSeller", pay_to_lc: "rseller", domain: null, proof: "", nonce: "", webhook_url: null, webhook_secret: null, email: null, token_hash: "", is_test: false, created_at: 0,
      endpoints: Array.from({ length: 10 }, (_, i) => ({ url: `https://s.test/e${i}`, method: "GET" as const, price_usd: String(usd), asset: "USDC", amount: null, checked_at: 0, source: "seller" as const,
        chains: ["xrpl:0", "eip155:8453", "eip155:1"].map((network) => ({ network, pay_to: "x", usd, asset: "USDC", proven: true })) })),
    });
    const atCap = watchEconomics(mk(0.1) as any, "watch_pro", 10, 1) as any;
    expect(atCap).toMatchObject({ eligible: false, test_buys_planned_per_term: 900, test_buy_budget_usd_per_term: 80, est_test_buy_cost_usd_per_term: 90, volume_discount: 0.2 });
    expect(atCap.reason).toMatch(/exceed 50% of the fee/);
    const below = watchEconomics(mk(0.08) as any, "watch_pro", 10, 1) as any;
    expect(below).toMatchObject({ eligible: true, est_test_buy_cost_usd_per_term: 72 });
    // prepaying 3 terms with 10+ endpoints does not add the 10%: same per-term budget
    expect(watchEconomics(mk(0.1) as any, "watch_pro", 10, 3)).toMatchObject({ test_buy_budget_usd_per_term: 80, discount_not_stacked: "prepay" });
  });

  it("tier limits: test-buy budget at most half the fee, caps per buy", () => {
    expect(WATCH_TIERS.watch.maxBuyUsd).toBe(0.05);
    expect(WATCH_TIERS.watch_plus.maxBuyUsd).toBe(0.1);
    expect(WATCH_TIERS.watch_free).toMatchObject({ buyEveryMs: 0, buysPerTerm: 0, badge: false });
    expect(WATCH_FREE.label).toBe("free tier, no test-buys");
    expect(WATCH_TRIAL).toMatchObject({ days: 14, capUsd: 0.25 });
    // worst-case planned buys per 30 days stay within 50% of the per-endpoint fee
    for (const id of ["watch", "watch_plus", "watch_pro"] as const) {
      const t = WATCH_TIERS[id], chains = typeof t.chains === "number" ? t.chains : 1;
      expect(t.buysPerTerm * chains * t.maxBuyUsd, id).toBeLessThanOrEqual(Number(PLANS[id].usd) * 0.5);
    }
    expect(MONITOR_PRICE_TEXT).toMatch(/Watch \$5.*Watch Pro \$20/);
    expect(MONITOR_PRICE_TEXT).toMatch(/Re-test pack \$6\.50 for 30 test-buys.*Founder pack \$5 for 24 test-buys/);
  });

  it("quotes N endpoints x T terms, validates the quantity and never charges on a bad one", async () => {
    const s = setup();
    const list = await quote(s, "/v1/monitor/subscribe/watch_pro?endpoints=10&terms=3");
    expect(list.status).toBe(402);
    expect(Number(iou(list.body))).toBeCloseTo(480, 6); // 20 x 10 x 3 x 0.8: volume only, prepay not stacked
    const e = await enroll(s);
    expect(e.pay.watch).toContain("&endpoints=1");
    const q = await quote(s, `/v1/monitor/subscribe/watch?enrollment=${e.enrollment_id}&endpoints=1`);
    expect(iou(q.body)).toBe("5");
    expect(q.body.resource.description).not.toMatch(/\$\s?\d/);
    expect((await quote(s, `/v1/monitor/subscribe/watch?enrollment=${e.enrollment_id}&endpoints=2`)).body.error).toBe("endpoints_exceed_enrolled");
    expect((await s.req(`/v1/monitor/subscribe/watch?enrollment=${e.enrollment_id}&endpoints=1&terms=2`)).status).toBe(400);
    expect((await s.req(`/v1/monitor/subscribe/watch?enrollment=${e.enrollment_id}&endpoints=abc`)).status).toBe(400);
    expect(settles(s)).toBe(0);
  });

  it("prepaid terms stack as consecutive 30-day rows with a per-term budget", async () => {
    const s = setup({ SALES_TEST_WALLETS: SELLER });
    const e = await enroll(s);
    const r = await pay(s, `/v1/monitor/subscribe/watch_pro?enrollment=${e.enrollment_id}&endpoints=1&terms=3`);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ plan: "Watch Pro", terms: 3, endpoint_count: 1, auto_renew: false, discounts: { volume: 0, prepay: 0.1, applied: "prepay" } });
    expect(r.body.plan_ids).toHaveLength(3);
    expect(Date.parse(r.body.ends_at) - Date.parse(r.body.starts_at)).toBe(90 * DAY);
    // a second purchase stacks after the first block
    const r2 = await pay(s, `/v1/monitor/subscribe/watch_pro?enrollment=${e.enrollment_id}&endpoints=1`);
    expect(Date.parse(r2.body.starts_at)).toBe(Date.parse(r.body.ends_at));
    expect(settles(s)).toBe(2);
  });

  it("legacy Monitor terms bought before retirement keep running; new purchases answer 410", async () => {
    const s = setup({ SALES_TEST_WALLETS: SELLER });
    const e = await enroll(s);
    PLANS.monitor.retired = false; // simulate a purchase made before 2026-10-25
    let r;
    try {
      r = await pay(s, `/v1/monitor/subscribe/monitor?enrollment=${e.enrollment_id}`);
    } finally {
      PLANS.monitor.retired = true;
    }
    expect(r.status).toBe(201);
    expect(r.body.legacy).toMatch(/Grandfathered/);
    const gone = await s.req(`/v1/monitor/subscribe/monitor?enrollment=${e.enrollment_id}`);
    expect(gone.status).toBe(410);
    const e2 = await enroll(s);
    expect(e2.pay.monitor).toBeUndefined();
    const page = await (await s.req(`/v1/monitor/sellers/${e.enrollment_id}`)).json();
    expect(page.commercial_relationship.status).toBe("active");
  });
});

describe("Free Watch", () => {
  it("is $0, one per payTo, no test-buys, no badge, labelled and not listed as a paying seller", async () => {
    const s = setup();
    const e = await enroll(s);
    const h = { Authorization: `Bearer ${e.management_token}` };
    expect((await s.post("/v1/monitor/free", { enrollment_id: e.enrollment_id })).status).toBe(401);
    const r = await s.post("/v1/monitor/free", { enrollment_id: e.enrollment_id }, h);
    expect(r.status).toBe(201);
    const b = await r.json();
    expect(b).toMatchObject({ price_usd: "0", label: WATCH_FREE.label, badge: false, auto_renew: false, test_buys: "none" });
    expect((await s.post("/v1/monitor/free", { enrollment_id: e.enrollment_id }, h)).status).toBe(409);
    const e2 = await enroll(s); // same payTo, another enrolment
    expect((await s.post("/v1/monitor/free", { enrollment_id: e2.enrollment_id }, { Authorization: `Bearer ${e2.management_token}` })).status).toBe(409);
    const due = await (await s.req("/v1/owner/monitor/due", { headers: auth })).json();
    expect(due.tasks.filter((t: any) => t.enrollment_id === e.enrollment_id)).toHaveLength(0);
    const res = await s.post("/v1/owner/monitor/results", { results: [{ enrollment_id: e.enrollment_id, plan_id: b.plan_id, endpoint: `${BASE}/v1/verdict?url=https://a.example/x`, network: "xrpl:1", asset: "XRP", outcome: "delivered", http_status: 200, data_returned: true, tx_hash: "D".repeat(64), cost_usd: 0.003 }] }, auth);
    expect(JSON.stringify(await res.json())).toMatch(/free|no_test_buys|rejected/i);
    const badge = await (await s.req(`/v1/monitor/badge/${e.enrollment_id}.json`)).json();
    expect(badge.status).toBe("removed");
    const st = await (await s.req(`/v1/monitor/status/${e.enrollment_id}.json`)).json();
    expect(st.tier_label).toBe("free tier, no test-buys");
    const sellers = await (await s.req("/v1/monitor/sellers")).json();
    expect(JSON.stringify(sellers)).not.toContain(e.enrollment_id);
    expect(settles(s)).toBe(0);
  });
});

describe("Watch trial (internal id watch_plus_trial)", () => {
  it("needs a signed challenge for the domain and payTo plus a published token; one per seller", async () => {
    const s = setup();
    const e = await enroll(s);
    const h = { Authorization: `Bearer ${e.management_token}` };
    expect((await s.req(`/v1/monitor/trial/challenge?pay_to=${SELLER}`)).status).toBe(400);
    const { c, proof } = await trialProof(s);
    expect(c.trial).toMatchObject({ days: 14, test_buy_cap_usd: 0.25, card_required: false, auto_converts: false });
    expect(c.message).toContain("domain: lumi.test");
    // token not published yet
    const no = await s.post("/v1/monitor/trial", { enrollment_id: e.enrollment_id, ...proof }, h);
    expect(no.status).toBe(403);
    expect((await no.json()).error).toBe("domain_not_proven");
    // wrong domain: not an enrolled endpoint host
    const other = await trialProof(s, "example.com");
    expect((await s.post("/v1/monitor/trial", { enrollment_id: e.enrollment_id, ...other.proof }, h)).status).toBe(403);
    // tampered domain line breaks the MAC
    const forged = { ...proof, message: proof.message.replace("domain: lumi.test", "domain: lumi2.test") };
    expect((await s.post("/v1/monitor/trial", { enrollment_id: e.enrollment_id, ...forged }, h)).status).toBe(403);
    s.wellKnown.body = `lumi-monitor-verify=${c.prove_domain.token}\n`;
    const fresh = await trialProof(s);
    const ok = await s.post("/v1/monitor/trial", { enrollment_id: e.enrollment_id, ...fresh.proof }, h);
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ trial: true, price_usd: "0", test_buy_cap_usd: 0.25, card_required: false, auto_converts: false, funding: "lumi-funded (free trial)" });
    // one per seller: same payTo/domain again, also from another enrolment
    const again = await trialProof(s);
    expect((await s.post("/v1/monitor/trial", { enrollment_id: e.enrollment_id, ...again.proof }, h)).status).toBe(409);
    const e2 = await enroll(s);
    const again2 = await trialProof(s);
    expect((await s.post("/v1/monitor/trial", { enrollment_id: e2.enrollment_id, ...again2.proof }, { Authorization: `Bearer ${e2.management_token}` })).status).toBe(409);
    expect(settles(s)).toBe(0);
  });

  it("caps test-buys at the trial total, freezes read-only at the end and never converts", async () => {
    const s = setup({ PRICE_INSTITUTIONAL_XRP: "0.03", PRICE_INSTITUTIONAL_RLUSD: "0.09", PRICE_INSTITUTIONAL_USDC: "0.09" });
    const ep = `${BASE}/v1/trust/check?url=https://a.example/x`;
    const e = await enroll(s, [{ url: ep }]);
    const h = { Authorization: `Bearer ${e.management_token}` };
    const { c } = await trialProof(s);
    s.wellKnown.body = `lumi-monitor-verify=${c.prove_domain.token}`;
    const { proof } = await trialProof(s);
    const t = await (await s.post("/v1/monitor/trial", { enrollment_id: e.enrollment_id, ...proof }, h)).json();
    const base = { enrollment_id: e.enrollment_id, plan_id: t.plan_id, endpoint: ep, network: "xrpl:1", asset: "XRP", quote_pay_to: SELLER, outcome: "delivered", http_status: 200, data_returned: true };
    // spend the trial budget, then due() stops offering buys
    let spent = 0, buys = 0, stopped: any = null;
    for (let i = 0; i < 14; i++) {
      const due = await (await s.req("/v1/owner/monitor/due", { headers: auth })).json();
      const mine = due.tasks.filter((x: any) => x.enrollment_id === e.enrollment_id);
      const task = mine.find((x: any) => x.mode === "buy");
      if (!task) { stopped = mine[0]; break; }
      expect(task.funding).toBe("lumi-funded (free trial)");
      expect(spent + task.max_usd).toBeLessThanOrEqual(WATCH_TRIAL.capUsd + 1e-9);
      await s.post("/v1/owner/monitor/results", { results: [{ ...base, network: task.network, asset: task.network.startsWith("xrpl") ? "XRP" : "USDC", quote_pay_to: task.pay_to, tx_hash: (i + 1).toString(16).repeat(64).slice(0, 64), cost_usd: task.max_usd }] }, auth);
      spent += task.max_usd; buys++;
      s.advance(DAY + 60_000);
    }
    expect(buys).toBeGreaterThan(0);
    expect(spent).toBeLessThanOrEqual(WATCH_TRIAL.capUsd + 1e-9);
    expect(stopped?.why ?? "").toMatch(/trial test-buy cap/); // the cap, not the 14 days, ended the buys
    const page = await (await s.req(`/v1/monitor/sellers/${e.enrollment_id}`)).json();
    expect(page.test_buys.every((x: any) => x.funding === "lumi-funded (free trial)")).toBe(true);
    expect(page.commercial_relationship.unpaid).toBe(true);
    const tb = await (await s.req(`/v1/monitor/badge/${e.enrollment_id}.json`)).json();
    if (tb.status !== "removed") expect(tb).toMatchObject({ label: TRIAL_BADGE_LABEL, paid: false });
    s.advance(15 * DAY);
    const st = await (await s.req(`/v1/monitor/status/${e.enrollment_id}.json`)).json();
    expect(st.frozen).toBe(true);
    expect(st.tier).toBeNull();
    const late = await (await s.post("/v1/owner/monitor/results", { results: [{ ...base, tx_hash: "F".repeat(64), cost_usd: 0.01 }] }, auth)).json();
    expect(JSON.stringify(late)).toContain("plan_frozen");
    const html = await (await s.req(`/v1/monitor/status/${e.enrollment_id}`)).text();
    expect(html).toContain("read-only since");
    // day 14 spelled out: nothing charged, checks stop, badge off, history read-only; never a stale "Operational"
    expect(st.status).toMatch(/^Trial ended \d{4}-\d{2}-\d{2}, not monitored$/);
    expect(st.frozen_note).toContain(WATCH_TRIAL_END);
    expect(html).toContain("not monitored");
    expect(html).not.toContain(">Operational<");
    expect((await (await s.req(`/v1/monitor/badge/${e.enrollment_id}.json`)).json()).status).toBe("removed");
    const probesAfter = await (await s.req("/v1/owner/monitor/probes", { headers: auth })).json();
    expect(probesAfter.targets.some((x: any) => x.enrollment_id === e.enrollment_id)).toBe(false);
    // nothing was ever charged and no paid plan appeared
    expect(settles(s)).toBe(0);
    expect(page.commercial_relationship.plans.every((p: any) => p.unpaid)).toBe(true);
  });
});

describe("legal wording (review 2026-10-23)", () => {
  it("the paid badge says it is a paid plan, on the SVG and in the JSON", async () => {
    const s = setup();
    const e = await enroll(s);
    const paid = await pay(s, `/v1/monitor/subscribe/watch?enrollment=${e.enrollment_id}&endpoints=1`);
    const planId = paid.body.plan_id ?? paid.body.plans?.[0]?.plan_id;
    const r = await s.post("/v1/owner/monitor/results", { results: [{ enrollment_id: e.enrollment_id, plan_id: planId, endpoint: `${BASE}/v1/verdict?url=https://a.example/x`, network: "xrpl:1", asset: "XRP", quote_pay_to: SELLER, outcome: "delivered", http_status: 200, data_returned: true, tx_hash: "A".repeat(64), cost_usd: 0.003 }] }, auth);
    expect(r.status).toBe(200);
    const b = await (await s.req(`/v1/monitor/badge/${e.enrollment_id}.json`)).json();
    expect(b).toMatchObject({ label: PAID_BADGE_LABEL, paid: true });
    const svg = await (await s.req(`/v1/monitor/badge/${e.enrollment_id}.svg`)).text();
    expect(svg).toContain("paid plan");
  });
  it("Watch Pro, Watch Plus cadence and the trial end read the same everywhere", async () => {
    expect(WATCH_PRO_BUYS).toBe("daily buys on up to 3 chains, limited by the test-buy budget");
    expect(WATCH_TIERS.watch_plus.probeEveryMs).toBe(30 * 60_000);
    expect(MONITOR_PRICE_TEXT).toContain(WATCH_PRO_BUYS);
    expect(PLANS.watch_pro.summary).toContain(WATCH_PRO_BUYS);
    const s = setup();
    const texts = [MONITOR_PRICE_TEXT, PLANS.watch_plus.summary, await (await s.req("/llms.txt")).text(), JSON.stringify(await (await s.req("/v1/monitor")).json())];
    for (const t of texts) { expect(t).not.toContain("15-30"); expect(t).not.toMatch(/approved by/i); if (process.env.LUMI_OWNER_NAME) expect(t).not.toContain(process.env.LUMI_OWNER_NAME); }
    expect(texts[2]).toContain(WATCH_PRO_BUYS);
    expect(texts[2]).toContain(WATCH_TRIAL_END);
  });
});

describe("uptime rollups and status page", () => {
  it("accepts daily rollups inside the plan period, turns transitions into findings and renders a status page", async () => {
    const s = setup({ SALES_TEST_WALLETS: SELLER });
    const e = await enroll(s);
    const ep = `${BASE}/v1/verdict?url=https://a.example/x`;
    await pay(s, `/v1/monitor/subscribe/watch?enrollment=${e.enrollment_id}&endpoints=1`);
    const today = new Date(s.now()).toISOString().slice(0, 10);
    const probes = await (await s.req("/v1/owner/monitor/probes", { headers: auth })).json();
    expect(probes.targets.find((x: any) => x.enrollment_id === e.enrollment_id)).toMatchObject({ endpoint: ep, plan: "watch", every_ms: WATCH_TIERS.watch.probeEveryMs });
    expect((await s.req("/v1/owner/monitor/probes")).status).toBe(401);
    const r = await (await s.post("/v1/owner/monitor/uptime", {
      days: [{ enrollment_id: e.enrollment_id, endpoint: ep, day: today, checks: 24, ok: 24, p50_ms: 120, p95_ms: 300 }, { enrollment_id: e.enrollment_id, endpoint: ep, day: "2020-01-01", checks: 24, ok: 24 }],
      transitions: [{ enrollment_id: e.enrollment_id, endpoint: ep, kind: "latency_p95_high" }],
    }, auth)).json();
    expect(r.written).toBe(1);
    expect(r.rejected.map((x: any) => x.error)).toEqual(["outside_plan_period", "tier_has_no_latency_alerts"]);
    const st = await s.req(`/v1/monitor/status/${e.enrollment_id}.json`);
    expect(st.headers.get("Cache-Control")).toContain("max-age=300");
    const sb = await st.json();
    expect(sb).toMatchObject({ status: "Operational", tier: "watch" });
    expect(sb.endpoints[0]).toMatchObject({ quote_uptime: 100, checks: 24, p95_ms: 300 });
    const down = await (await s.post("/v1/owner/monitor/uptime", { transitions: [{ enrollment_id: e.enrollment_id, endpoint: ep, kind: "quote_down" }], days: [{ enrollment_id: e.enrollment_id, endpoint: ep, day: today, checks: 30, ok: 24 }] }, auth)).json();
    expect(down.findings[0].kind).toBe("quote_down");
    expect((await (await s.req(`/v1/monitor/status/${e.enrollment_id}.json`)).json()).status).toBe("Degraded");
    expect((await s.post("/v1/owner/monitor/uptime", { days: [] })).status).toBe(401);
    expect((await s.req(`/v1/monitor/status/men_${"0".repeat(24)}.json`)).status).toBe(404);
  });
});

describe("the 14-day free trial is called the Watch trial everywhere user-facing", () => {
  it("no public doc says 'Watch Plus trial'; the internal id stays watch_plus_trial", async () => {
    const s = setup();
    let seen = "";
    for (const p of ["/", "/llms.txt", "/skill.md", "/openapi.json", "/.well-known/x402", "/v1/monitor", "/v1/feed"]) {
      const t = await (await s.req(p)).text();
      expect(t, p).not.toMatch(/Watch Plus (free )?trial/);
      seen += t;
    }
    expect(seen).toContain("Watch trial");
    expect(WATCH_TRIAL.label).toBe("Watch free trial");
    expect(WATCH_TIERS.watch_plus_trial.name).toBe("Watch free trial"); // internal id kept for existing rows
  });
});

describe("independence: no tier changes a score", () => {
  it("trust answers are identical before and after free, trial, Watch, Watch Pro, Audit and a test-buy pack", async () => {
    const strip = (x: any) => JSON.parse(JSON.stringify(x, (k, v) => (k === "commercial_relationship" || k === "generated_at" || k === "as_of" ? undefined : v)));
    for (const tier of ["watch_free", "watch_plus_trial", "watch", "watch_pro", "audit", "retest_pack"]) {
      const s = setup({ SALES_TEST_WALLETS: SELLER });
      const before = await (await s.req(`/v1/trust/vendors?payTo=${SELLER}`)).json();
      const catBefore = await (await s.req("/v1/trust/catalog")).json();
      const e = await enroll(s);
      const h = { Authorization: `Bearer ${e.management_token}` };
      if (tier === "watch_free") expect((await s.post("/v1/monitor/free", { enrollment_id: e.enrollment_id }, h)).status).toBe(201);
      else if (tier === "watch_plus_trial") {
        const { c } = await trialProof(s);
        s.wellKnown.body = `lumi-monitor-verify=${c.prove_domain.token}`;
        const { proof } = await trialProof(s);
        expect((await s.post("/v1/monitor/trial", { enrollment_id: e.enrollment_id, ...proof }, h)).status).toBe(201);
      } else {
        const qs = PLANS[tier as keyof typeof PLANS].perEndpoint ? "&endpoints=1" : "";
        expect((await pay(s, `/v1/monitor/subscribe/${tier}?enrollment=${e.enrollment_id}${qs}`)).status).toBe(201);
      }
      if (tier === "retest_pack") {
        // a pack result is posted (delivered, then a paid retry the same day): it dates the seller badge, never a score
        const job = (await (await s.req("/v1/owner/monitor/due", { headers: auth })).json()).pack_jobs[0];
        const res = { enrollment_id: e.enrollment_id, plan_id: job.plan_id, endpoint: job.endpoint.url ?? job.endpoint, ts: s.now(), network: "xrpl:1", tx_hash: "E".repeat(64), http_status: 200, data_returned: true, cost_usd: 0.003, outcome: "delivered", pack_job_id: job.pack_job_id };
        const rec = (await (await s.post("/v1/owner/monitor/results", { results: [res] }, auth)).json()).recorded[0]; expect(rec, JSON.stringify(rec)).toMatchObject({ pack_job: "done" });
        const badge = await (await s.req(`/v1/monitor/badge/${e.enrollment_id}.json`)).json();
        expect(badge).toMatchObject({ status: "monitored", plan: "retest_pack", last_test: new Date(s.now()).toISOString() }); // owner-flagged test wallet here, so labelled test
        const page = await (await s.req(`/v1/monitor/sellers/${e.enrollment_id}`)).json();
        expect(page.test_buys[0]).toMatchObject({ counted: true, funding: "seller-funded" });
        expect(page.counting.rule).toContain("UTC day");
      }
      const after = await (await s.req(`/v1/trust/vendors?payTo=${SELLER}`)).json();
      const catAfter = await (await s.req("/v1/trust/catalog")).json();
      expect(strip(after), tier).toEqual(strip(before));
      expect(strip(catAfter), tier).toEqual(strip(catBefore));
    }
  });
});
