import { describe, it, expect } from "vitest";
import { deriveAddress, deriveKeypair, generateSeed, sign } from "ripple-keypairs";
import { createApp } from "../src/app";
import { FACILITATOR, DATA, NOW, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";
import { MONITOR_LIMITS, PLANS, WATCH_DISCOUNTS, WATCH_FREE, WATCH_TRIAL, WATCH_TIERS, planPriceUsd, watchDiscount, watchPrice, MONITOR_PRICE_TEXT, WATCH_PRO_BUYS, WATCH_TRIAL_END, PAID_BADGE_LABEL, TRIAL_BADGE_LABEL } from "../src/commerce/plans";
import { watchEconomics } from "../src/commerce/monitor";
import { MemoryCommerceStore } from "../src/commerce/store";
import { PLATFORM_LICENCE, watchTier, PACK_LIMITS, PACK_PLANS, SOLD_MONITOR_PLANS, isPack, usd2 } from "../src/commerce/plans";
import { PACK_TERMS } from "../src/commerce/policy";

const BASE = "https://lumi.test";
const OWNER = "owner-key-for-tests-0123456789-abcdefghijklmnop";
const seed = generateSeed({ entropy: Uint8Array.from({ length: 16 }, (_, i) => i + 7) });
const kp = deriveKeypair(seed);
const SELLER = deriveAddress(kp.publicKey);
const DAY = 86_400_000;
const auth = { Authorization: `Bearer ${OWNER}` };
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();

function setup(extra: Record<string, string> = {}, commerceStore?: MemoryCommerceStore) {
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
  const app = createApp(env as any, { fetch: f, log: () => {}, now: () => t, ...(commerceStore ? { commerceStore } : {}) } as any);
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(BASE + path, init));
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => req(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });
  return { app, req, post, fac, wellKnown, fetches, advance: (ms: number) => (t += ms), now: () => t };
}
type S = ReturnType<typeof setup>;

async function enroll(s: S, endpoints: unknown[] = [{ url: `${BASE}/v1/fear-greed` }]) {
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


describe("Watch Plus and its founder offer are retired (replaced by test-buy packs)", () => {
  it("are not sold, 410 before any payment, and point at the packs; $5 Watch is unchanged", async () => {
    expect(PLANS.watch_plus.retired).toBe(true);
    expect(PLANS.watch_plus_founder.retired).toBe(true);
    expect(SOLD_MONITOR_PLANS).not.toContain("watch_plus");
    expect(SOLD_MONITOR_PLANS).not.toContain("watch_plus_founder");
    expect(PLANS.watch.usd).toBe("5");
    expect(watchPrice("watch", 1, 1)!.total_usd).toBe("5");
    expect(watchTier("watch_plus_founder")).toBe(WATCH_TIERS.watch_plus); // honoured rows keep their cadence
    expect(MONITOR_PRICE_TEXT).not.toMatch(/Watch Plus \$/);
    const s = setup();
    const e = await enroll(s);
    for (const p of ["watch_plus", "watch_plus_founder"]) {
      const r = await quote(s, `/v1/monitor/subscribe/${p}?enrollment=${e.enrollment_id}&endpoints=1`);
      expect(r.status).toBe(410);
      expect(r.body.detail).toContain("/v1/monitor/packs");
    }
    expect(s.fac.calls).toHaveLength(0);
    expect((await quote(s, `/v1/monitor/subscribe/watch?enrollment=${e.enrollment_id}&endpoints=1`)).status).toBe(402);
  });
});

describe("test-buy packs: prices, terms, catalog", () => {
  it("exact prices and terms; terms text matches the plan numbers", () => {
    expect(PACK_PLANS).toEqual(["retest_pack", "founder_pack"]);
    expect(PLANS.retest_pack).toMatchObject({ usd: "6.5", pack: { buys: 30, expiryDays: 365 } });
    expect(PLANS.founder_pack).toMatchObject({ usd: "5", pack: { buys: 24, expiryDays: 365, founder: { seats: 10, maxPurchases: 12 } } });
    expect(usd2(PLANS.retest_pack.usd)).toBe("6.50");
    expect(PACK_LIMITS.maxBuyUsd).toBe(0.1);
    expect(PLANS.retest_pack.summary).toMatch(/^Fixed something\? Get re-tested now\./);
    expect(isPack("retest_pack") && isPack("founder_pack") && !isPack("watch")).toBe(true);
    for (const id of PACK_PLANS) {
      expect(planPriceUsd(id, true)).toBe(PLANS[id].usd); // test wallets pay the exact price too
      expect(planPriceUsd(id, false)).toBe(PLANS[id].usd);
    }
    const t = PACK_TERMS.terms.join(" ");
    expect(t).toContain("Re-test pack 30"); expect(t).toContain("Founder pack 24"); expect(t).toContain("$0.10"); expect(t).toContain("12 months");
    expect(t).toContain("first 10 sellers"); expect(t).toContain("up to 12 purchases"); expect(t).toContain("$5 each");
    expect(t).toMatch(/if Lumi stops selling test-buys, unused test-buys are refunded/);
  });
  it("402 quotes are exactly $6.50 / $5 (no test price, no discount)", async () => {
    const s = setup();
    const e = await enroll(s);
    const r = await quote(s, `/v1/monitor/subscribe/retest_pack?enrollment=${e.enrollment_id}`);
    expect(r.status).toBe(402);
    expect(iou(r.body)).toBe("6.5");
    const f = await quote(s, `/v1/monitor/subscribe/founder_pack?enrollment=${e.enrollment_id}`);
    expect(f.status).toBe(402);
    expect(iou(f.body)).toBe("5");
    // without an enrollment: the same list price
    expect(iou((await quote(s, "/v1/monitor/subscribe/retest_pack")).body)).toBe("6.5");
  });
  it("GET /v1/monitor/packs lists packs and terms; the single test-buy is 'coming soon' with no price", async () => {
    const s = setup();
    const r = await s.req("/v1/monitor/packs");
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.packs.map((p: any) => [p.plan, p.price_usd, p.test_buys])).toEqual([["retest_pack", "6.5", 30], ["founder_pack", "5", 24]]);
    expect(b.founder_places_left).toBe(10);
    expect(b.single_test_buy.status).toBe("coming_soon");
    expect(JSON.stringify(b.single_test_buy)).not.toMatch(/\$|usd|0\.(10|25)/i);
    expect(b.terms).toEqual(PACK_TERMS);
    expect((await s.req(`/v1/monitor/packs?enrollment=men_${"0".repeat(20)}`)).status).toBe(401);
  });
  it("no one-shot price appears anywhere a checkout does not exist", async () => {
    const s = setup();
    const docs = [await (await s.req("/v1/monitor")).text(), await (await s.req("/v1/monitor/packs")).text(), await (await s.req("/.well-known/x402")).text(), await (await s.req("/skill.md")).text(), MONITOR_PRICE_TEXT];
    for (const d of docs) {
      expect(d).not.toMatch(/\$0\.25 (per|a|for a) (single )?test-buy/i);
      expect(d).not.toMatch(/single test-buy[^.]{0,40}\$0\.\d/i);
      expect(d).not.toMatch(/Watch Plus \$12/);
    }
  });
});

describe("test-buy packs: purchase, balance, queue, fulfilment", () => {
  async function seededPay(s: S) { let n = 0; s.fac.settle = (b: any) => new Response(JSON.stringify({ success: true, transaction: String(++n).padStart(64, "C"), network: b.paymentRequirements.network, payer: "rPayer" }), { headers: { "Content-Type": "application/json" } }); }
  it("buying a Re-test pack records 30 credits for 12 months and queues the first re-test", async () => {
    const store = new MemoryCommerceStore();
    const s = setup({}, store);
    await seededPay(s);
    const e = await enroll(s);
    const r = await pay(s, `/v1/monitor/subscribe/retest_pack?enrollment=${e.enrollment_id}`);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ paid: true, price_usd: "6.50", test_buys: 30, balance_left: 29, auto_renew: false, max_usd_per_test_buy: 0.1, terms: PACK_TERMS });
    expect(r.body.first_retest).toMatchObject({ status: "queued", endpoint: `${BASE}/v1/fear-greed` });
    expect(Date.parse(r.body.expires_at) - NOW).toBe(365 * DAY);
    const row = (await store.plansFor(e.enrollment_id)).find((p) => p.plan === "retest_pack")!;
    expect(row).toMatchObject({ credits: 30, usd: 6.5, budget_usd: 3 });
    expect(settles(s)).toBe(1);
    // balance with the management token
    const bal = await (await s.req(`/v1/monitor/packs?enrollment=${e.enrollment_id}`, { headers: { Authorization: `Bearer ${e.management_token}` } })).json();
    expect(bal.balance.left).toBe(29);
    expect(bal.balance.jobs).toHaveLength(1);
    // same endpoint, same UTC day: refused; next day: queued
    const dup = await s.post("/v1/monitor/packs/use", { enrollment_id: e.enrollment_id }, { Authorization: `Bearer ${e.management_token}` });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toBe("already_queued_today");
    s.advance(DAY);
    const use = await s.post("/v1/monitor/packs/use", { enrollment_id: e.enrollment_id }, { Authorization: `Bearer ${e.management_token}` });
    expect(use.status).toBe(201);
    expect((await use.json()).balance_left).toBe(28);
    expect((await s.post("/v1/monitor/packs/use", { enrollment_id: e.enrollment_id }, { Authorization: "Bearer wrong" })).status).toBe(401);
  });
  it("due lists pack jobs (not scheduled tasks); results need the pack_job_id and mark the job done; cancel returns the buy", async () => {
    const store = new MemoryCommerceStore();
    const s = setup({}, store);
    await seededPay(s);
    const e = await enroll(s);
    const r = await pay(s, `/v1/monitor/subscribe/retest_pack?enrollment=${e.enrollment_id}`);
    const due = await (await s.req("/v1/owner/monitor/due", { headers: auth })).json();
    expect(due.tasks.filter((t: any) => t.plan === "retest_pack")).toHaveLength(0);
    expect(due.pack_jobs).toHaveLength(1);
    const job = due.pack_jobs[0];
    expect(job).toMatchObject({ pack_job_id: r.body.first_retest.job_id, plan_id: r.body.pack_id, mode: "buy", funding: "seller-funded (pack)" });
    expect(job.max_usd).toBeLessThanOrEqual(0.1);
    const base = { enrollment_id: e.enrollment_id, plan_id: job.plan_id, endpoint: `${BASE}/v1/fear-greed`, ts: s.now(), network: "xrpl:1", tx_hash: "A".repeat(64), http_status: 200, data_returned: true, cost_usd: 0.003, outcome: "ok" };
    const no = await (await s.post("/v1/owner/monitor/results", { results: [base] }, auth)).json();
    expect(no.recorded[0].error).toBe("pack_job_required");
    const ok = await (await s.post("/v1/owner/monitor/results", { results: [{ ...base, pack_job_id: job.pack_job_id }] }, auth)).json();
    expect(ok.recorded[0]).toMatchObject({ pack_job_id: job.pack_job_id, pack_job: "done" });
    expect((await store.packJob(job.pack_job_id))!.status).toBe("done");
    const again = await (await s.post("/v1/owner/monitor/results", { results: [{ ...base, pack_job_id: job.pack_job_id }] }, auth)).json();
    expect(again.recorded[0].error).toBe("pack_job_not_queued");
    expect((await (await s.req("/v1/owner/monitor/due", { headers: auth })).json()).pack_jobs).toHaveLength(0);
    // a job Lumi cannot run is cancelled and the buy returns to the pack
    s.advance(DAY);
    const u = await (await s.post("/v1/monitor/packs/use", { enrollment_id: e.enrollment_id }, { Authorization: `Bearer ${e.management_token}` })).json();
    expect(u.balance_left).toBe(28);
    expect((await s.post("/v1/owner/monitor/packs/cancel", { job_id: u.job.job_id, note: "runner down" })).status).toBe(401);
    const c = await s.post("/v1/owner/monitor/packs/cancel", { job_id: u.job.job_id, note: "runner down" }, auth);
    expect(c.status).toBe(200);
    const bal = await (await s.req(`/v1/monitor/packs?enrollment=${e.enrollment_id}`, { headers: { Authorization: `Bearer ${e.management_token}` } })).json();
    expect(bal.balance.left).toBe(29);
  });
  it("preflight before payment: endpoints above the $0.10 cap are refused and nothing settles", async () => {
    const store = new MemoryCommerceStore();
    const s = setup({}, store);
    const e = await enroll(s);
    (store as any).enrolls.get(e.enrollment_id).endpoints.forEach((ep: any) => { ep.price_usd = "0.25"; for (const c of ep.chains ?? []) c.usd = 0.25; });
    for (const p of PACK_PLANS) {
      const r = await quote(s, `/v1/monitor/subscribe/${p}?enrollment=${e.enrollment_id}`);
      expect(r.status).toBe(409);
      expect(r.body.error).toBe("no_endpoint_within_cap");
      const named = await quote(s, `/v1/monitor/subscribe/${p}?enrollment=${e.enrollment_id}&endpoint=${encodeURIComponent(`${BASE}/v1/fear-greed`)}`);
      expect(named.body.error).toBe("endpoint_above_cap");
    }
    expect((await quote(s, `/v1/monitor/subscribe/retest_pack?enrollment=${e.enrollment_id}&endpoint=${encodeURIComponent("https://elsewhere.example/x")}`)).body.error).toBe("endpoint_not_enrolled");
    expect(s.fac.calls).toHaveLength(0);
  });
  it("preflight: a sanctioned payTo is refused before any 402, and its queued jobs never reach the runner", async () => {
    const store = new MemoryCommerceStore();
    const s = setup({}, store);
    await (async () => { let n = 0; s.fac.settle = (b: any) => new Response(JSON.stringify({ success: true, transaction: String(++n).padStart(64, "E"), network: b.paymentRequirements.network, payer: "rPayer" }), { headers: { "Content-Type": "application/json" } }); })();
    const e = await enroll(s);
    expect((await pay(s, `/v1/monitor/subscribe/retest_pack?enrollment=${e.enrollment_id}`)).status).toBe(201);
    const calls = s.fac.calls.length;
    const row = (store as any).enrolls.get(e.enrollment_id);
    row.pay_to = "rnXyVQzgxZe7TR1EPzTkGj2jxH4LMJYh66"; row.pay_to_lc = row.pay_to.toLowerCase(); // listed after enrolment
    for (const p of PACK_PLANS) {
      const r = await quote(s, `/v1/monitor/subscribe/${p}?enrollment=${e.enrollment_id}`);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("sanctioned_address");
    }
    s.advance(DAY);
    expect((await s.post("/v1/monitor/packs/use", { enrollment_id: e.enrollment_id }, { Authorization: `Bearer ${e.management_token}` })).status).toBe(403);
    expect((await (await s.req("/v1/owner/monitor/due", { headers: auth })).json()).pack_jobs).toHaveLength(0);
    expect(s.fac.calls.length).toBe(calls);
  });
});

describe("Founder pack: first 10 sellers, one place per company, 12 purchases", () => {
  const fp = (i: number, enrollment_id: string) => ({ id: `fp${enrollment_id}${i}`, enrollment_id, plan: "founder_pack", starts_at: NOW, ends_at: NOW + 365 * DAY, paid_tx: `tx${enrollment_id}${i}`, paid_network: "xrpl:1", paid_asset: "XRP", paid_amount: "1", payer: null, usd: 5, budget_usd: 2.4, spent_usd: 0, is_test: false, reminded: 0, created_at: NOW, credits: 24 }) as any;
  const en = (id: string, pay_to: string, domain: string | null, url = `https://api.${id}.com/x`) => ({ id, network: "xrpl:1", pay_to, pay_to_lc: pay_to.toLowerCase(), domain, proof: "", nonce: id, endpoints: [{ url, method: "GET", price_usd: "0.01", asset: null, amount: null, checked_at: null, source: "seller" }], webhook_url: null, webhook_secret: null, email: null, token_hash: "h" + id, is_test: false, created_at: NOW }) as any;
  const path = (id: string) => `/v1/monitor/subscribe/founder_pack?enrollment=${id}`;
  async function fill(store: MemoryCommerceStore, n: number, start = 0) {
    for (let i = start; i < start + n; i++) { await store.addEnrollment(en(`co${i}`, `rCompany${i}xxxxxxxxxxxxxxxxxxxx`, null)); await store.addPlan(fp(0, `co${i}`)); }
  }
  it("closes to new companies once 10 hold a place; the Re-test pack is still sold; test rows take no place", async () => {
    const store = new MemoryCommerceStore();
    await fill(store, 10);
    const s = setup({}, store);
    const e = await enroll(s);
    const full = await quote(s, path(e.enrollment_id));
    expect(full.status).toBe(409);
    expect(full.body.error).toBe("founder_offer_full");
    expect(full.body.detail).toContain("/v1/monitor/subscribe/retest_pack?");
    expect((await quote(s, `/v1/monitor/subscribe/retest_pack?enrollment=${e.enrollment_id}`)).status).toBe(402);
    expect((await (await s.req("/v1/monitor/packs")).json()).founder_places_left).toBe(0);
    expect(s.fac.calls).toHaveLength(0);
    const store2 = new MemoryCommerceStore();
    for (let i = 0; i < 10; i++) await store2.addPlan({ ...fp(i, `t${i}`), is_test: true });
    expect(await store2.founderHolders("founder_pack")).toEqual([]);
  });
  it("a holder can rebuy up to 12 times in total; the 13th is refused before payment", async () => {
    const store = new MemoryCommerceStore();
    await fill(store, 9);
    await store.addEnrollment(en("mineOld", SELLER, null, "https://api.mineold.com/x"));
    for (let i = 0; i < 11; i++) await store.addPlan(fp(i, "mineOld"));
    const s = setup({}, store);
    await (async () => { let n = 0; s.fac.settle = (b: any) => new Response(JSON.stringify({ success: true, transaction: String(++n).padStart(64, "D"), network: b.paymentRequirements.network, payer: "rPayer" }), { headers: { "Content-Type": "application/json" } }); })();
    const e = await enroll(s); // same payTo as mineOld: same company, so not refused as full
    const r = await pay(s, path(e.enrollment_id));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ price_usd: "5", test_buys: 24 });
    const over = await quote(s, path(e.enrollment_id));
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ error: "founder_purchases_used", purchases_left: 0 });
  });
  it("a different payTo on a shared domain is the same company (one place)", async () => {
    const store = new MemoryCommerceStore();
    await fill(store, 9);
    await store.addEnrollment(en("sameDomain", "rSomeOtherWalletxxxxxxxxxxxxxxx", null, `${BASE}/v1/events`));
    await store.addPlan(fp(0, "sameDomain"));
    const s = setup({}, store);
    const e = await enroll(s); // endpoint on lumi.test, as sameDomain
    expect((await quote(s, path(e.enrollment_id))).status).toBe(402); // 10 places taken, but this company holds one
    await store.addEnrollment(en("co77", "rCompany77xxxxxxxxxxxxxxxxxxxx", null));
    const s2 = setup({}, store);
    expect((await (await s2.req("/v1/monitor/packs")).json()).founder_places_left).toBe(0);
  });
});

describe("platform licence listing", () => {
  it("is listed in the root doc and the feed doc as contact-to-buy, never as an x402 resource", async () => {
    expect(PLATFORM_LICENCE).toMatchObject({ from_usd: "499", term_days: 30, how_to_buy: "contact" });
    const s = setup();
    const root = await (await s.req("/")).json();
    expect(root.platform_licence).toMatchObject({ from_usd: "499", how_to_buy: "contact" });
    const feed = JSON.stringify(await (await s.req("/v1/feed")).json());
    expect(feed).toContain("platform_licence");
    const wk = JSON.stringify(await (await s.req("/.well-known/x402")).json());
    expect(wk).not.toContain("platform_licence");
  });
});
