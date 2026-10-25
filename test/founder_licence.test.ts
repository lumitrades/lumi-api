import { describe, it, expect } from "vitest";
import { deriveAddress, deriveKeypair, generateSeed, sign } from "ripple-keypairs";
import { createApp } from "../src/app";
import { FACILITATOR, DATA, NOW, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";
import { MONITOR_LIMITS, PLANS, WATCH_DISCOUNTS, WATCH_FREE, WATCH_TRIAL, WATCH_TIERS, planPriceUsd, watchDiscount, watchPrice, MONITOR_PRICE_TEXT, WATCH_PRO_BUYS, WATCH_TRIAL_END, PAID_BADGE_LABEL, TRIAL_BADGE_LABEL } from "../src/commerce/plans";
import { watchEconomics } from "../src/commerce/monitor";
import { MemoryCommerceStore } from "../src/commerce/store";
import { PLATFORM_LICENCE, budgetBaseUsd, watchTier } from "../src/commerce/plans";

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


describe("Watch Plus founder offer (Phase 2)", () => {
  it("budget is set from the list price, not the founder price; no discounts; same tier as Watch Plus", () => {
    expect(PLANS.watch_plus_founder.usd).toBe("5");
    expect(PLANS.watch_plus_founder.founder).toEqual({ seats: 10, lockedTerms: 12, listPlan: "watch_plus" });
    expect(budgetBaseUsd("watch_plus_founder", 5, 3)).toBe(36);
    expect(budgetBaseUsd("watch_plus", 12, 3)).toBe(12);
    expect(watchTier("watch_plus_founder")).toBe(WATCH_TIERS.watch_plus);
    expect(watchDiscount(10, 3, "watch_plus_founder").rate).toBe(0);
    expect(watchPrice("watch_plus_founder", 10, 3)!.total_usd).toBe("150");
    // the full 30 buys at the 0.10 cap fit in 50% of the list price even at the most expensive seller
    expect(WATCH_TIERS.watch_plus.buysPerTerm * WATCH_TIERS.watch_plus.maxBuyUsd).toBeLessThanOrEqual(budgetBaseUsd("watch_plus_founder", 5, 1) * MONITOR_LIMITS.budgetShare);
    expect(PLANS.watch_plus_founder.summary).not.toMatch(/\$\d/);
  });
  it("a paid founder term gets a budget of 50% of the list price; 12 terms at most per seller", async () => {
    const s = setup();
    let n = 0;
    s.fac.settle = (b: any) => new Response(JSON.stringify({ success: true, transaction: String(++n).padStart(64, "B"), network: b.paymentRequirements.network, payer: "rPayer" }), { headers: { "Content-Type": "application/json" } });
    const e = await enroll(s);
    const q = await quote(s, `/v1/monitor/subscribe/watch_plus_founder?enrollment=${e.enrollment_id}&endpoints=1`);
    expect(q.status).toBe(402);
    const r = await pay(s, `/v1/monitor/subscribe/watch_plus_founder?enrollment=${e.enrollment_id}&endpoints=1&terms=3`);
    expect([200, 201]).toContain(r.status);
    for (let i = 0; i < 3; i++) expect([200, 201]).toContain((await pay(s, `/v1/monitor/subscribe/watch_plus_founder?enrollment=${e.enrollment_id}&endpoints=1&terms=3`)).status);
    const over = await quote(s, `/v1/monitor/subscribe/watch_plus_founder?enrollment=${e.enrollment_id}&endpoints=1`);
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ error: "founder_terms_used", terms_left: 0 });
    expect(over.body.detail).toContain("/v1/monitor/subscribe/watch_plus?");
  });
  it("budget rows: founder rows carry the list-price budget", async () => {
    const store = new MemoryCommerceStore();
    const s = setup({}, store);
    const e = await enroll(s, [{ url: `${BASE}/v1/fear-greed` }, { url: `${BASE}/v1/events` }]);
    expect([200, 201]).toContain((await pay(s, `/v1/monitor/subscribe/watch_plus_founder?enrollment=${e.enrollment_id}&endpoints=2`)).status);
    const row = (await store.plansFor(e.enrollment_id)).find((p) => p.plan === "watch_plus_founder")!;
    expect(row.usd).toBe(10);
    expect(row.budget_usd).toBe(12); // 50% of 2 x 12 list, not 50% of 10
  });
  it("closes to new sellers once 10 have taken a seat; existing founders can renew", async () => {
    const store = new MemoryCommerceStore();
    for (let i = 0; i < 10; i++) await store.addPlan({ id: `p${i}`, enrollment_id: `other${i}`, plan: "watch_plus_founder", starts_at: NOW, ends_at: NOW + 30 * DAY, paid_tx: `tx${i}`, paid_network: "xrpl:1", paid_asset: "XRP", paid_amount: "1", payer: null, usd: 5, budget_usd: 6, spent_usd: 0, is_test: false, reminded: 0, created_at: NOW, endpoints: 1, unit_usd: 5 } as any);
    const s = setup({}, store);
    const e = await enroll(s);
    const full = await quote(s, `/v1/monitor/subscribe/watch_plus_founder?enrollment=${e.enrollment_id}&endpoints=1`);
    expect(full.status).toBe(409);
    expect(full.body.error).toBe("founder_offer_full");
    expect(s.fac.calls).toHaveLength(0);
    // the list-price tier is still sold
    expect((await quote(s, `/v1/monitor/subscribe/watch_plus?enrollment=${e.enrollment_id}&endpoints=1`)).status).toBe(402);
    // test rows do not take a seat
    const store2 = new MemoryCommerceStore();
    for (let i = 0; i < 10; i++) await store2.addPlan({ id: `p${i}`, enrollment_id: `t${i}`, plan: "watch_plus_founder", paid_tx: `t${i}`, is_test: true } as any);
    expect(await store2.founderHolders("watch_plus_founder")).toEqual([]);
  });
});

describe("founder places: one per payTo wallet and per domain", () => {
  const fp = (i: number, enrollment_id: string) => ({ id: `fp${enrollment_id}${i}`, enrollment_id, plan: "watch_plus_founder", starts_at: NOW, ends_at: NOW + 30 * DAY, paid_tx: `tx${enrollment_id}${i}`, paid_network: "xrpl:1", paid_asset: "XRP", paid_amount: "1", payer: null, usd: 5, budget_usd: 6, spent_usd: 0, is_test: false, reminded: 0, created_at: NOW, endpoints: 1, unit_usd: 5 }) as any;
  const en = (id: string, pay_to: string, domain: string | null, url = `https://api.${id}.com/x`) => ({ id, network: "xrpl:1", pay_to, pay_to_lc: pay_to.toLowerCase(), domain, proof: "", nonce: id, endpoints: [{ url, method: "GET", price_usd: null, asset: null, amount: null, checked_at: null, source: "seller" }], webhook_url: null, webhook_secret: null, email: null, token_hash: "h" + id, is_test: false, created_at: NOW }) as any;
  const path = (id: string, extra = "") => `/v1/monitor/subscribe/watch_plus_founder?enrollment=${id}&endpoints=1${extra}`;
  async function fill(store: MemoryCommerceStore, n: number, start = 0) {
    for (let i = start; i < start + n; i++) { await store.addEnrollment(en(`co${i}`, `rCompany${i}xxxxxxxxxxxxxxxxxxxx`, null)); await store.addPlan(fp(0, `co${i}`)); }
  }
  it("a second enrolment with the same payTo shares the place (not taken when full) and its 12 terms", async () => {
    const store = new MemoryCommerceStore();
    await fill(store, 9);
    await store.addEnrollment(en("mineOld", SELLER, null, "https://api.mineold.com/x"));
    for (let i = 0; i < 12; i++) await store.addPlan(fp(i, "mineOld"));
    const s = setup({}, store);
    const e = await enroll(s);
    const q = await quote(s, path(e.enrollment_id));
    expect(q.status).toBe(409);
    expect(q.body).toMatchObject({ error: "founder_terms_used", terms_left: 0 }); // not founder_offer_full: same place
  });
  it("a different payTo on the same domain shares the place and its terms", async () => {
    const store = new MemoryCommerceStore();
    await fill(store, 9);
    await store.addEnrollment(en("sameDomain", "rSomeOtherWalletxxxxxxxxxxxxxxx", null, `${BASE}/v1/events`));
    for (let i = 0; i < 10; i++) await store.addPlan(fp(i, "sameDomain"));
    const s = setup({}, store);
    const e = await enroll(s); // endpoint on lumi.test, a different wallet would be another company only with another domain
    const three = await quote(s, path(e.enrollment_id, "&terms=3"));
    expect(three.status).toBe(409);
    expect(three.body).toMatchObject({ error: "founder_terms_used", terms_left: 2 });
    expect((await quote(s, path(e.enrollment_id))).status).toBe(402); // the shared terms that are left
  });
  it("the enrolled domain counts too; enrolments sharing a wallet or domain count as one place", async () => {
    const store = new MemoryCommerceStore();
    await fill(store, 8);
    // two enrolments of one company (same wallet), then a third of the same company by domain: one place between them
    await store.addEnrollment(en("a1", "rSharedWalletxxxxxxxxxxxxxxxxxx", "shared.io", "https://api.shared.io/a"));
    await store.addEnrollment(en("a2", "rSharedWalletxxxxxxxxxxxxxxxxxx", null, "https://api.other1.com/a"));
    await store.addEnrollment(en("a3", "rThirdWalletxxxxxxxxxxxxxxxxxxx", "shared.io", "https://api.other2.com/a"));
    for (const id of ["a1", "a2", "a3"]) await store.addPlan(fp(0, id));
    const s = setup({}, store);
    const e = await enroll(s);
    expect((await quote(s, path(e.enrollment_id))).status).toBe(402); // 9 places taken, the 10th is free
    await store.addEnrollment(en("co99", "rCompany99xxxxxxxxxxxxxxxxxxxx", null));
    await store.addPlan(fp(0, "co99"));
    const full = await quote(s, path(e.enrollment_id));
    expect(full.status).toBe(409);
    expect(full.body.error).toBe("founder_offer_full");
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
