import { describe, it, expect } from "vitest";
import { deriveAddress, deriveKeypair, generateSeed, sign } from "ripple-keypairs";
import { createApp } from "../src/app";
import { BAZAAR_ROUTES, BAZAAR_MAX_DESCRIPTION } from "../src/bazaar";
import { planQuote, PLANS, type PlanId } from "../src/commerce/plans";
import { SELLERS_DISCLOSURE, TEST_BADGE_LABEL } from "../src/commerce/monitor";
import { RECEIPT_OUTCOMES, MemoryReceiptStore } from "../src/trust/receipts";
import { TRIAL_SHORT, TRIAL_SUMMARY } from "../src/trial";
import { FACILITATOR, DATA, NOW, happyFacilitator, makeFetch } from "./helpers";

const BASE = "https://lumi.test";
const OWNER = "owner-key-for-tests-0123456789-abcdefghijklmnop";
const kp = deriveKeypair(generateSeed({ entropy: Uint8Array.from({ length: 16 }, (_, i) => i + 3) }));
const SELLER = deriveAddress(kp.publicKey);
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();

function setup(extra: Record<string, string> = {}, deps: Record<string, unknown> = {}) {
  const env = { XRPL_NETWORK: "xrpl:1", PAY_TO: SELLER, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PUBLIC_BASE_URL: BASE, OWNER_MCP_KEY: OWNER, ...extra };
  const app = createApp(env as any, { fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW, ...deps } as any);
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(BASE + path, init));
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => req(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });
  return { req, post };
}
async function enroll(s: ReturnType<typeof setup>) {
  const { message } = await (await s.req(`/v1/monitor/challenge?pay_to=${SELLER}`)).json();
  const r = await s.post("/v1/monitor/enroll", { message, signature: sign(hex(message), kp.privateKey), public_key: kp.publicKey, endpoints: [{ url: `${BASE}/v1/fear-greed` }] });
  expect(r.status).toBe(201);
  return (await r.json()).enrollment_id as string;
}
const text = async (s: ReturnType<typeof setup>, p: string) => (await s.req(p)).text();

describe("M-1 test-buy cadence wording", () => {
  it("no 'per vendor per day' claim; says shared caps and not every vendor every day", async () => {
    const s = setup();
    for (const p of ["/v1/trust/methodology", "/llms.txt", "/skill.md"]) {
      const t = await text(s, p);
      expect(t, p).not.toMatch(/per vendor per day|each vendor (is bought )?(every|each) day|daily test-buys? of every/i);
      expect(t, p).toMatch(/not every vendor/i);
    }
  });
});

describe("M-2 Bazaar metadata", () => {
  it("descriptions carry XRP / RLUSD / Fear and Greed keywords within the 500-char limit", () => {
    for (const [r, m] of Object.entries(BAZAAR_ROUTES)) expect(m.description.length, r).toBeLessThanOrEqual(BAZAAR_MAX_DESCRIPTION);
    expect(BAZAAR_ROUTES.fear_greed.description).toMatch(/Fear and Greed/);
  });
  it("plan quotes say seller monitoring / trust data feed", () => {
    const cfg: any = { xrpRate: { usd: 0.5 }, xrpUsdFallback: 0.5, ious: [] };
    for (const id of Object.keys(PLANS) as PlanId[]) {
      const q: any = planQuote(cfg, id, "men_x", "9", `${BASE}/x`, false);
      const d = JSON.stringify(q);
      expect(d).toMatch(PLANS[id].family === "monitor" ? /x402 seller monitoring/ : /x402 trust data feed/);
    }
  });
  it("an unfilled template on a retired route answers 410 Gone pointing at /v1/check, never a quote", async () => {
    const s = setup();
    const r = await s.req("/v1/signal/{coin}");
    expect(r.status).toBe(410);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(JSON.stringify(await r.json())).toContain("/v1/check");
  });
});

describe("M-4 public seller list and Audit plan", () => {
  it("excludes test enrolments, discloses, and badges test enrolments as tests", async () => {
    const s = setup({ SALES_TEST_WALLETS: SELLER });
    const id = await enroll(s);
    const list = await (await s.req("/v1/monitor/sellers")).json();
    expect(list.sellers).toEqual([]);
    expect(list.count).toBe(0);
    expect(JSON.stringify(list)).toContain(SELLERS_DISCLOSURE);
    expect(SELLERS_DISCLOSURE).toMatch(/Paying never changes a score/);
    expect(list.note).toBe("No paying seller yet.");
    const b = await (await s.req(`/v1/monitor/badge/${id}.json`)).json();
    expect(b.label === undefined || b.label === TEST_BADGE_LABEL).toBe(true);
  });
  it("Audit is one-off: no 30-day term", () => {
    expect(PLANS.audit.days ?? null).toBeNull();
  });
});

describe("L-9 error codes", () => {
  it("invalid pay_to vs missing pay_to", async () => {
    const s = setup();
    const a = await (await s.req("/v1/monitor/challenge?pay_to=nope")).json();
    expect(a.error).toBe("invalid_pay_to");
    const b = await (await s.req("/v1/monitor/challenge")).json();
    expect(b.error).toBe("pay_to_required");
  });
  it("unknown enrolment id says enrollment_unknown (unpaid 402 and paid)", async () => {
    const s = setup();
    const r = await s.req("/v1/monitor/subscribe/watch?endpoints=1&enrollment=men_" + "0".repeat(24));
    const j = await r.json();
    expect(JSON.stringify(j)).toContain("enrollment_unknown");
    const paid = await s.req("/v1/monitor/subscribe/watch?endpoints=1&enrollment=men_" + "0".repeat(24), { headers: { "PAYMENT-SIGNATURE": "eyJ4IjoxfQ==" } });
    expect(JSON.stringify(await paid.json())).toContain("enrollment_unknown");
    const missing = await s.req("/v1/monitor/subscribe/watch?endpoints=1", { headers: { "PAYMENT-SIGNATURE": "eyJ4IjoxfQ==" } });
    expect(JSON.stringify(await missing.json())).toContain("enrollment_required");
  });
});

describe("L-1 trial text", () => {
  it("states the Base 0.01 USDC condition and the XRPL trial (one per wallet)", async () => {
    expect(TRIAL_SHORT).toMatch(/Base/);
    expect(TRIAL_SHORT).toMatch(/0\.01 USDC/);
    expect(TRIAL_SHORT).toMatch(/activated XRP Ledger account/);
    expect(TRIAL_SHORT).toMatch(/one trial per wallet/);
    expect(TRIAL_SHORT).not.toMatch(/no trial/);
    expect(TRIAL_SUMMARY).toMatch(/XRP Ledger/);
    expect(TRIAL_SUMMARY).not.toMatch(/no free trial/);
    const s = setup({ EVM_PAY_TO: "0x5E617bac19912e6d212CB303ae84655E9E203532" });
    const root = await (await s.req("/", { headers: { Accept: "application/json" } })).json();
    expect(JSON.stringify(root)).toMatch(/activated XRP Ledger account/);
    expect(JSON.stringify(root)).not.toMatch(/XRPL-only wallets get no/);
    const init = await (await s.post("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, { Accept: "application/json, text/event-stream" })).json();
    expect(init.result.instructions).toMatch(/activated XRP Ledger account/);
    expect(init.result.instructions).not.toMatch(/no trial/);
  });
});

describe("L-5 agent card coin counts", () => {
  it("no longer advertises per-coin signals or levels or coin counts (retired 2026-10-25)", async () => {
    const card = await text(setup(), "/.well-known/agent-card.json");
    expect(card).not.toMatch(/\b(49|50|51) coins|13 watchlist|signals cover|\/v1\/(signal|levels|lite|scan|slate|brief|coins)\b/);
  });
});

describe("I-3 openapi", () => {
  it("free lookup vs paid check wording; data_returned nullable; outcome enum = receipt outcomes", async () => {
    const o = await (await setup().req("/openapi.json")).json();
    expect(o.info.description).toMatch(/free lookup; paid pre-payment check/);
    const sch = o.paths["/v1/trust/receipts/verify"].post.requestBody.content["application/json"].schema;
    const d = sch.properties.delivery;
    expect(d.properties.data_returned.type).toEqual(["boolean", "null"]);
    expect(d.properties.outcome.enum).toEqual([...RECEIPT_OUTCOMES]);
  });
});

describe("H-1 pending ?tx returns the current receipt", () => {
  it("current_receipt is null when none is stored", async () => {
    const rs = new MemoryReceiptStore();
    rs.buys = [{ kind: "vendor", ref: "v", endpoint: "https://s.example/x", domain: null, pay_to: null, ts: NOW - 1000, network: "xrpl:0", tx_hash: "AB".repeat(32), amount: "0.01", asset: "RLUSD", http_status: 0, data_returned: false, latency_ms: 0, summary: "", source: "lumi_test_buy" } as any];
    const s = setup({}, { receiptStore: rs });
    const r = await s.req(`/v1/trust/receipts/pending?tx=${"AB".repeat(32)}`, { headers: { Authorization: `Bearer ${OWNER}` } });
    const j = await r.json();
    expect(j).toHaveProperty("current_receipt", null);
    expect(j).toHaveProperty("current_receipt_hash", null);
  });
});
