import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { deriveAddress, deriveKeypair, generateSeed, sign } from "ripple-keypairs";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../src/app";
import { FACILITATOR, DATA, NOW, happyFacilitator, makeFetch, paymentHeaderFor, decodeB64Json } from "./helpers";
import { planEconomics, badgeStatus, TEST_BADGE_LABEL } from "../src/commerce/monitor";
import { isTestWallet, planPriceUsd, PLANS } from "../src/commerce/plans";

const BASE = "https://lumi.test";
const OWNER = "owner-key-for-tests-0123456789-abcdefghijklmnop";
const seed = generateSeed({ entropy: Uint8Array.from({ length: 16 }, (_, i) => i + 7) });
const kp = deriveKeypair(seed);
const SELLER = deriveAddress(kp.publicKey);
const EVM = privateKeyToAccount(("0x" + "11".repeat(32)) as `0x${string}`);

function setup(extra: Record<string, string> = {}) {
  const env = { XRPL_NETWORK: "xrpl:1", PAY_TO: SELLER, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PUBLIC_BASE_URL: BASE, OWNER_MCP_KEY: OWNER, ...extra };
  let t = NOW;
  const fac = happyFacilitator();
  const app = createApp(env as any, { fetch: makeFetch(fac), log: () => {}, now: () => t });
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(BASE + path, init));
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => req(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });
  return { app, req, post, fac, advance: (ms: number) => (t += ms), now: () => t };
}

const hex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
async function xrplProof(req: any, purpose: "monitor" | "feed") {
  const r = await req(purpose === "monitor" ? `/v1/monitor/challenge?pay_to=${SELLER}` : `/v1/feed/challenge?wallet=${SELLER}`);
  expect(r.status).toBe(200);
  const { message } = await r.json();
  return { message, signature: sign(hex(message), kp.privateKey), public_key: kp.publicKey };
}

async function enroll(s: ReturnType<typeof setup>, endpoints: unknown[], extra: Record<string, unknown> = {}) {
  const proof = await xrplProof(s.req, "monitor");
  const r = await s.post("/v1/monitor/enroll", { ...proof, endpoints, ...extra });
  return { r, body: await r.json(), proof };
}

async function pay(s: ReturnType<typeof setup>, path: string) {
  const q = await s.req(path);
  expect(q.status).toBe(402);
  const body = await q.json();
  expect(decodeB64Json(q.headers.get("PAYMENT-REQUIRED"))).toEqual(body);
  const xrp = body.accepts.find((a: any) => a.asset === "XRP");
  const r = await s.req(path, { headers: { "PAYMENT-SIGNATURE": paymentHeaderFor(xrp) } });
  return { quote: body, r, body: await r.json() };
}

describe("seller monitoring (legacy Monitor terms, simulated as bought before the 2026-10-25 retirement)", () => {
  // Monitor and Monitor Plus are no longer sold (test/monitor_retired.test.ts). These tests un-retire them only to exercise
  // the code paths that grandfathered rows still run through.
  beforeEach(() => { PLANS.monitor.retired = false; PLANS.monitor_plus.retired = false; });
  afterEach(() => { PLANS.monitor.retired = true; PLANS.monitor_plus.retired = true; });
  it("enrols with an XRPL payTo proof, rejects reused nonces and endpoints above the cap", async () => {
    const s = setup({ PRICE_INSTITUTIONAL_XRP: "0.19", PRICE_INSTITUTIONAL_RLUSD: "0.25", PRICE_INSTITUTIONAL_USDC: "0.25" }); // above the $0.10 test-buy cap
    const { r, body, proof } = await enroll(s, [{ url: `${BASE}/v1/fear-greed` }, { url: `${BASE}/v1/institutional` }]);
    expect(r.status).toBe(201);
    expect(body.enrollment_id).toMatch(/^men_[a-f0-9]{24}$/);
    expect(body.management_token).toMatch(/^lumi_mt_/);
    expect(body.endpoints.map((e: any) => e.url)).toEqual([`${BASE}/v1/fear-greed`]);
    expect(body.rejected[0].url).toBe(`${BASE}/v1/institutional`);
    expect(body.rejected[0].reason).toMatch(/unprofitable/);
    expect(body.test).toBeUndefined();
    // same challenge again
    const again = await s.post("/v1/monitor/enroll", { ...proof, endpoints: [{ url: `${BASE}/v1/fear-greed` }] });
    expect(again.status).toBe(409);
    // bad signature
    const bad = await s.post("/v1/monitor/enroll", { ...(await xrplProof(s.req, "monitor")), signature: "00", endpoints: [{ url: `${BASE}/v1/fear-greed` }] });
    expect(bad.status).toBe(403);
    // seller page stays private until a plan is paid
    expect((await s.req(`/v1/monitor/sellers/${body.enrollment_id}`)).status).toBe(404);
  });

  it("subscribe: list-price quote without enrollment, refused before settle when paid without one", async () => {
    const s = setup();
    const q = await s.req("/v1/monitor/subscribe/monitor");
    expect(q.status).toBe(402);
    const qb = await q.json();
    const usdc = qb.accepts.find((a: any) => a.extra?.symbol === "RLUSD" || a.asset !== "XRP");
    expect(usdc?.amount ?? "9").toBeDefined();
    const xrp = qb.accepts.find((a: any) => a.asset === "XRP");
    const paid = await s.req("/v1/monitor/subscribe/monitor", { headers: { "PAYMENT-SIGNATURE": paymentHeaderFor(xrp) } });
    expect(paid.status).toBe(400);
    expect(s.fac.calls.filter((c: any) => String(c.url ?? c).includes("settle"))).toHaveLength(0);
    expect((await s.req("/v1/monitor/subscribe/%7Bplan%7D")).status).toBe(400);
  });

  it("charges the list price to sellers and the test price only to owner-flagged test wallets", async () => {
    const list = setup();
    const e1 = await enroll(list, [{ url: `${BASE}/v1/fear-greed` }]);
    const q1 = await (await list.req(`/v1/monitor/subscribe/monitor?enrollment=${e1.body.enrollment_id}`)).json();
    const iou1 = q1.accepts.find((a: any) => a.asset !== "XRP");
    expect(iou1.amount).toBe("9");

    const test = setup({ SALES_TEST_WALLETS: SELLER });
    const e2 = await enroll(test, [{ url: `${BASE}/v1/fear-greed` }], { webhook_url: "https://hooks.example.com/lumi" });
    expect(e2.body.test).toMatch(/test wallet/);
    const { quote, r, body } = await pay(test, `/v1/monitor/subscribe/monitor?enrollment=${e2.body.enrollment_id}`);
    expect(quote.accepts.find((a: any) => a.asset !== "XRP").amount).toBe("0.01");
    expect(quote.resource.description).toMatch(/TEST price/);
    expect(r.status).toBe(201);
    expect(body).toMatchObject({ paid: true, plan: "Monitor", test: true, price_usd: "0.01", auto_renew: false });

    // public entry: disclosure, test label, badge not yet earned (no test-buy)
    const page = await (await test.req(`/v1/monitor/sellers/${e2.body.enrollment_id}`)).json();
    expect(page.commercial_relationship.disclosure).toMatch(/pays Lumi for monitoring/);
    expect(page.test).toBe(true);
    const b0 = await (await test.req(`/v1/monitor/badge/${e2.body.enrollment_id}.json`)).json();
    expect(b0.status).toBe("removed");

    // owner posts a delivered run -> badge live; then a paid-no-data run -> finding + badge removed
    const auth = { Authorization: `Bearer ${OWNER}` };
    const dueR = await test.req("/v1/owner/monitor/due", { headers: auth });
    const due = await dueR.json();
    expect(due.tasks).toHaveLength(1);
    expect(due.tasks[0]).toMatchObject({ mode: "buy", test: true });
    const base = { enrollment_id: e2.body.enrollment_id, plan_id: body.plan_id, endpoint: `${BASE}/v1/fear-greed`, network: "xrpl:1", asset: "XRP", quote_pay_to: SELLER };
    // Paying with another option of the same quote (enrolled RLUSD/XRP vs bought XRP) at the same USD price is not a price change.
    const listed = e2.body.endpoints[0].listed_price_usd;
    const r1 = await test.post("/v1/owner/monitor/results", { results: [{ ...base, asset: e2.body.endpoints[0].asset === "XRP" ? "RLUSD" : "XRP", amount: "1", quote_price_usd: listed, outcome: "delivered", http_status: 200, data_returned: true, tx_hash: "B".repeat(64), cost_usd: 0.003 }] }, auth);
    expect(r1.status).toBe(200);
    expect((await r1.json()).recorded[0].findings).not.toContain("price_changed");
    const b1 = await (await test.req(`/v1/monitor/badge/${e2.body.enrollment_id}.json`)).json();
    expect(b1).toMatchObject({ status: "monitored", label: TEST_BADGE_LABEL, result: expect.any(String) });
    const svg = await (await test.req(`/v1/monitor/badge/${e2.body.enrollment_id}.svg`)).text();
    expect(svg).toContain(TEST_BADGE_LABEL);
    // one counted buy per endpoint per UTC day: a failure the next day is the latest counted result and removes the badge
    test.advance(24 * 3_600_000);
    await test.post("/v1/owner/monitor/results", { results: [{ ...base, outcome: "no_data", http_status: 200, data_returned: false, tx_hash: "C".repeat(64), cost_usd: 0.003 }] }, auth);
    const b2 = await (await test.req(`/v1/monitor/badge/${e2.body.enrollment_id}.json`)).json();
    expect(b2.status).toBe("removed");
    const page2 = await (await test.req(`/v1/monitor/sellers/${e2.body.enrollment_id}`)).json();
    const f = page2.findings.find((x: any) => x.kind === "paid_no_data");
    expect(f).toBeDefined();
    expect(page2.test_buys.every((t: any) => t.funding === "seller-funded")).toBe(true);
    expect(JSON.stringify(page2)).not.toContain("B".repeat(64)); // answer-only

    // replies need the management token; findings cannot be removed
    expect((await test.post("/v1/monitor/replies", { enrollment_id: e2.body.enrollment_id, finding_id: f.id, text: "Fixed." })).status).toBe(401);
    expect((await test.post("/v1/monitor/replies", { enrollment_id: e2.body.enrollment_id, finding_id: f.id, text: "Fixed." }, { Authorization: `Bearer ${e2.body.management_token}` })).status).toBe(201);
    const page3 = await (await test.req(`/v1/monitor/sellers/${e2.body.enrollment_id}`)).json();
    expect(page3.findings.find((x: any) => x.id === f.id).replies[0].text).toBe("Fixed.");

    // lapse: badge removed with plan_lapsed
    test.advance(31 * 86_400_000);
    const b3 = await (await test.req(`/v1/monitor/badge/${e2.body.enrollment_id}.json`)).json();
    expect(b3).toMatchObject({ status: "removed", reason: "plan_lapsed" });
  });

  it("paying never changes the trust answer: only commercial_relationship is added", async () => {
    const s = setup({ SALES_TEST_WALLETS: SELLER });
    const before = await (await s.req(`/v1/trust/vendors?payTo=${SELLER}`)).json();
    const e = await enroll(s, [{ url: `${BASE}/v1/fear-greed` }]);
    await pay(s, `/v1/monitor/subscribe/monitor?enrollment=${e.body.enrollment_id}`);
    const after = await (await s.req(`/v1/trust/vendors?payTo=${SELLER}`)).json();
    const strip = (x: any) => JSON.parse(JSON.stringify(x, (k, v) => (k === "commercial_relationship" || k === "generated_at" || k === "as_of" ? undefined : v)));
    expect(strip(after)).toEqual(strip(before));
    expect(JSON.stringify(after)).toContain("commercial_relationship");
  });

  it("plan economics and pricing helpers", () => {
    expect(planPriceUsd("monitor_plus", false)).toBe("29");
    expect(planPriceUsd("monitor_plus", true)).toBe("0.01");
    expect(isTestWallet("rM8kmmnz5qPMg7V3r7SHYXgDGvm8PhzLvM")).toBe(true);
    expect(isTestWallet(SELLER)).toBe(false);
    expect(PLANS.audit.usd).toBe("99");
    const e: any = { endpoints: Array.from({ length: 3 }, (_, i) => ({ url: `https://x.test/${i}`, method: "GET", price_usd: "0.05", source: "seller" })) };
    const econ: any = planEconomics(e);
    expect(econ.monitor.eligible).toBe(true);
    expect(econ.monitor_plus.eligible).toBe(true);
    expect(badgeStatus({ endpoints: [] } as any, [], [], NOW).ok).toBe(false);
  });
});

describe("trust data feed", () => {
  it("issues a free key with an EIP-191 signature, meters usage and enforces the quota", async () => {
    const s = setup();
    const ch = await (await s.req(`/v1/feed/challenge?wallet=${EVM.address}`)).json();
    const signature = await EVM.signMessage({ message: ch.message });
    const r = await s.post("/v1/feed/keys", { message: ch.message, signature });
    expect(r.status).toBe(201);
    const k = await r.json();
    expect(k.api_key).toMatch(/^lumi_fk_/);
    const auth = { Authorization: `Bearer ${k.api_key}` };
    expect((await s.post("/v1/feed/lookup", { items: [{ url: "https://x.test/a" }] })).status).toBe(401);
    const look = await s.post("/v1/feed/lookup", { items: [{ url: "https://x.test/a" }, { payTo: SELLER }] }, auth);
    expect(look.status).toBe(200);
    const lb = await look.json();
    expect(lb).toMatchObject({ tier: "free", evidence: "answer-only" });
    expect(lb.attribution).toBeDefined();
    const usage = await (await s.req("/v1/feed/usage", { headers: auth })).json();
    expect(JSON.stringify(usage)).toContain("2");
    // Free tier: no delta / snapshot
    expect((await s.req("/v1/feed/delta", { headers: auth })).status).toBe(403);
    expect((await s.req("/v1/feed/snapshot", { headers: auth })).status).toBe(403);
    // Quota: 1,000 per month
    let last: Response | undefined;
    for (let i = 0; i < 25; i++) {
      s.advance(61_000);
      last = await s.post("/v1/feed/lookup", { items: Array.from({ length: 50 }, (_, j) => ({ url: `https://x.test/${i}/${j}` })) }, auth);
      if (last.status !== 200) break;
    }
    expect(last!.status).toBe(429);
    expect((await last!.json()).note).toMatch(/Not charged/);
  });

  it("credits need a key_id; Feed without key_id issues a key (test price for own wallets)", async () => {
    const s = setup({ SALES_TEST_WALLETS: SELLER });
    const q = await s.req("/v1/feed/credits");
    expect(q.status).toBe(402);
    const xrp = (await q.json()).accepts.find((a: any) => a.asset === "XRP");
    expect((await s.req("/v1/feed/credits", { headers: { "PAYMENT-SIGNATURE": paymentHeaderFor(xrp) } })).status).toBe(400);
    const list = await (await s.req("/v1/feed/subscribe/feed_pro")).json();
    expect(list.accepts.find((a: any) => a.asset !== "XRP").amount).toBe("199");

    const proof = await xrplProof(s.req, "feed");
    const k = await (await s.post("/v1/feed/keys", proof)).json();
    expect(k.api_key).toMatch(/^lumi_fk_/);
    const { quote, r, body } = await pay(s, `/v1/feed/subscribe/feed_pro?key_id=${k.key_id}`);
    expect(quote.accepts.find((a: any) => a.asset !== "XRP").amount).toBe("0.01");
    expect(r.status).toBe(201);
    expect(body).toMatchObject({ paid: true });
    const auth = { Authorization: `Bearer ${k.api_key}` };
    const look = await (await s.post("/v1/feed/lookup", { items: [{ payTo: SELLER }] }, auth)).json();
    expect(look).toMatchObject({ tier: "feed_pro", evidence: "full" });
    expect((await s.req("/v1/feed/delta", { headers: auth })).status).toBe(200);
    const snap = await s.req("/v1/feed/snapshot", { headers: auth });
    expect(snap.status).toBe(200);
    expect(JSON.stringify(await snap.json())).toMatch(/resale/i);
  });

  it("serves the styled licence page and JSON terms", async () => {
    const s = setup();
    const r = await s.req("/v1/feed/license", { headers: { Accept: "text/html" } });
    const html = await r.text();
    expect(r.headers.get("content-type")).toMatch(/html/);
    expect(html).toContain("https://lumitrades.io");
    expect(html).toMatch(/resale/i);
    expect(html).toMatch(/linear-gradient/);
    const j = await (await s.req("/v1/feed/license", { headers: { Accept: "application/json" } })).json();
    expect(JSON.stringify(j)).toMatch(/attribution/i);
  });
});

describe("commerce discovery", () => {
  it("lists every plan in /.well-known/x402 and openapi with matching prices", async () => {
    const s = setup();
    const wk = await (await s.req("/.well-known/x402")).json();
    const oa = await (await s.req("/openapi.json")).json();
    for (const [id, p] of Object.entries(PLANS)) {
      const r0 = wk.resources.find((x: any) => x.url === `${BASE}${p.path}`);
      if (p.retired) {
        expect(r0, id).toBeUndefined();
        expect(oa.paths[p.path], id).toBeUndefined();
        expect((await s.req(p.path)).status, id).toBe(410);
        continue;
      }
      const r = wk.resources.find((x: any) => x.url === `${BASE}${p.path}`);
      expect(r, id).toBeDefined();
      expect(r.accepts.find((a: any) => a.asset !== "XRP").amount).toBe(p.usd);
      expect(oa.paths[p.path].get["x-payment-info"].price.amount).toBe(p.usd);
      // the concrete URL quotes the same list price
      const q = await (await s.req(p.path)).json();
      expect(q.accepts.find((a: any) => a.asset !== "XRP").amount, id).toBe(p.usd);
    }
    const urls = wk.resources.map((r: any) => r.url);
    expect(new Set(urls).size).toBe(urls.length);
    const skill = await (await s.req("/skill.md")).text();
    expect(skill).toContain("Watch Plus");
    expect(skill).not.toMatch(/Monitor Plus \$|\$29/);
    expect(skill).toContain("$1.5 per 1,000");
  });
});
