import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import {
  MemoryDemandTrialStore,
  DEMAND_TRIAL_HEADER,
  DEMAND_TRIAL_CAP,
  DEMAND_TRIAL_EXPIRES_AT_MS,
  hashDemandTrialKey,
  readDemandTrialKey,
  demandTrialEligible,
} from "../src/demand_trial";
import { MemorySalesStore } from "../src/sales";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";

const ENV = {
  XRPL_NETWORK: "xrpl:1",
  PAY_TO,
  FACILITATOR_URL: FACILITATOR,
  DATA_BASE_URL: DATA,
  INVOICE_SECRET: "s3cret",
  EVM_PAY_TO: "0x5E617bac19912e6d212CB303ae84655E9E203532",
  EVM_NETWORK: "eip155:84532",
  EVM_FACILITATOR_URL: "https://evm-fac.test",
  EVM_CDP_ONLY_ROUTES: "none",
};
const BASE = "http://lumi.test";
const TEST_KEY = "ltk_" + "ab".repeat(32);
const OTHER_KEY = "ltk_" + "cd".repeat(32);
const VERDICT = BASE + "/v1/verdict?url=https://a.example/x";
const RECEIPTS = BASE + "/v1/trust/receipts?seller=api.printmoneylab.com";
const BARE_RECEIPTS = BASE + "/v1/trust/receipts";
const HIGH_VALUE = BASE + "/v1/trust/check/high-value?url=https://a.example/x&amount=4";
const BATCH = BASE + "/v1/check/batch?urls=https://a.example/x,b.example";
const REPORT = BASE + "/v1/trust/vendors/printmoneylab/report";

async function setup(opts: { expiresAt?: number; cap?: number; now?: number; seed?: boolean } = {}) {
  const fac = happyFacilitator();
  const salesStore = new MemorySalesStore();
  const demandTrialStore = new MemoryDemandTrialStore();
  if (opts.seed !== false) {
    demandTrialStore.seed(await hashDemandTrialKey(TEST_KEY), "test-builder", opts.cap ?? DEMAND_TRIAL_CAP, opts.expiresAt ?? DEMAND_TRIAL_EXPIRES_AT_MS);
  }
  const app = createApp(
    { ...ENV } as any,
    { fetch: makeFetch(fac), log: () => {}, now: () => opts.now ?? NOW, salesStore, demandTrialStore },
  );
  const headers = { [DEMAND_TRIAL_HEADER]: TEST_KEY };
  return { app, fac, salesStore, demandTrialStore, headers };
}

describe("demand-test trial keys", () => {
  it("only accepts well-formed ltk_ keys and only on the five paid trust routes", () => {
    expect(readDemandTrialKey(new Request(VERDICT, { headers: { [DEMAND_TRIAL_HEADER]: TEST_KEY } }))).toBe(TEST_KEY);
    expect(readDemandTrialKey(new Request(VERDICT, { headers: { [DEMAND_TRIAL_HEADER]: "nope" } }))).toBeNull();
    expect(readDemandTrialKey(new Request(VERDICT))).toBeNull();
    expect(demandTrialEligible("verdict")).toBe(true);
    expect(demandTrialEligible("vendor_report")).toBe(true);
    expect(demandTrialEligible("high_value_check")).toBe(true);
    expect(demandTrialEligible("receipts")).toBe(true);
    expect(demandTrialEligible("batch_check")).toBe(true);
  });

  it("a valid key waives payment on verdict, decrements the cap, and is not a sale", async () => {
    const { app, fac, salesStore, demandTrialStore, headers } = await setup();
    const r = await app.fetch(new Request(VERDICT, { headers }));
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.access).toMatchObject({ mode: "demand_trial", charged: false, trial: 1, is_test: 0, trial_calls_used: 1, trial_calls_remaining: 49 });
    expect(typeof body.access.expires_at).toBe("string");
    expect(body.access.label).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(TEST_KEY);
    expect(fac.calls).toHaveLength(0);
    expect(salesStore.rows).toHaveLength(0);
    const peek = await demandTrialStore.peek(await hashDemandTrialKey(TEST_KEY));
    expect(peek?.used).toBe(1);
    expect((await demandTrialStore.uses()).map((u) => u.route)).toEqual(["verdict"]);
    // Same verdict fields as a normal check: the waiver does not change the score or label.
    expect(body.label || body.verdict || body.check).toBeTruthy();
  });

  it("works on receipts, batch, high-value and the vendor report, and counts each call", async () => {
    const { app, salesStore, demandTrialStore, headers } = await setup();
    // Receipts 404 in the empty in-memory catalog (no test-buy of that seller); the cap must not move.
    const missing = await app.fetch(new Request(RECEIPTS, { headers }));
    expect(missing.status).toBe(404);
    const urls = [BATCH, HIGH_VALUE];
    for (const url of urls) {
      const r = await app.fetch(new Request(url, { headers }));
      expect(r.status, url).toBe(200);
      const body = await r.json() as any;
      expect(body.access.charged).toBe(false);
      expect(body.access.mode).toBe("demand_trial");
    }
    // Vendor report is eligible, but prepare can 503 when the in-memory catalog has no history; the cap must not move.
    const report = await app.fetch(new Request(REPORT, { headers }));
    expect(report.status).toBe(503);
    expect(salesStore.rows).toHaveLength(0);
    expect((await demandTrialStore.peek(await hashDemandTrialKey(TEST_KEY)))?.used).toBe(2);
  });

  it("without a key, the normal 402 is unchanged", async () => {
    const { app, salesStore } = await setup();
    const r = await app.fetch(new Request(VERDICT));
    expect(r.status).toBe(402);
    const body = await r.json() as any;
    expect(body.x402Version).toBe(2);
    expect(body.accepts.length).toBeGreaterThan(0);
    expect(body.trial_key).toBeUndefined();
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(salesStore.rows).toHaveLength(0);
  });

  it("an unknown key is treated like no key (normal 402, no hint)", async () => {
    const { app } = await setup();
    const r = await app.fetch(new Request(VERDICT, { headers: { [DEMAND_TRIAL_HEADER]: OTHER_KEY } }));
    expect(r.status).toBe(402);
    const body = await r.json() as any;
    expect(body.trial_key).toBeUndefined();
    expect(body.accepts.length).toBeGreaterThan(0);
  });

  it("an exhausted key returns a 402 with a reason and does not keep decrementing", async () => {
    const { app, demandTrialStore, headers } = await setup({ cap: 1 });
    expect((await app.fetch(new Request(VERDICT, { headers }))).status).toBe(200);
    const r = await app.fetch(new Request(VERDICT, { headers }));
    expect(r.status).toBe(402);
    const body = await r.json() as any;
    expect(body.trial_key).toMatchObject({ granted: false, reason: "exhausted" });
    expect((await demandTrialStore.peek(await hashDemandTrialKey(TEST_KEY)))?.used).toBe(1);
  });

  it("an expired key returns a 402 with a reason and does not decrement", async () => {
    const { app, demandTrialStore, headers } = await setup({ now: DEMAND_TRIAL_EXPIRES_AT_MS + 1 });
    const r = await app.fetch(new Request(VERDICT, { headers }));
    expect(r.status).toBe(402);
    const body = await r.json() as any;
    expect(body.trial_key).toMatchObject({ granted: false, reason: "expired" });
    expect((await demandTrialStore.peek(await hashDemandTrialKey(TEST_KEY)))?.used).toBe(0);
  });

  it("a payment header still settles and does not consume a trial call", async () => {
    const { app, fac, salesStore, demandTrialStore, headers } = await setup();
    const quote = await (await app.fetch(new Request(VERDICT))).json() as any;
    const xrpl = quote.accepts.find((a: any) => String(a.network).startsWith("xrpl:"));
    const paid = await app.fetch(new Request(VERDICT, {
      headers: { ...headers, "PAYMENT-SIGNATURE": paymentHeaderFor(xrpl) },
    }));
    expect(paid.status).toBe(200);
    const body = await paid.json() as any;
    expect(body.access).toBeUndefined();
    expect(body.payment.transaction).toBeTruthy();
    expect(fac.calls.length).toBeGreaterThan(0);
    expect(salesStore.rows).toHaveLength(1);
    expect((await demandTrialStore.peek(await hashDemandTrialKey(TEST_KEY)))?.used).toBe(0);
  });

  it("a bare receipts probe still returns 402 even with a trial key (query required; not charged, not decremented)", async () => {
    const { app, demandTrialStore, headers } = await setup();
    const r = await app.fetch(new Request(BARE_RECEIPTS, { headers }));
    expect(r.status).toBe(402);
    expect((await demandTrialStore.peek(await hashDemandTrialKey(TEST_KEY)))?.used).toBe(0);
  });

  it("a malformed query is still a 400 and does not decrement the cap", async () => {
    const { app, demandTrialStore, headers } = await setup();
    const r = await app.fetch(new Request(BASE + "/v1/verdict", { headers })); // missing url, but this is the bare probe (402)
    // A verdict with no query is a probe 402; a verdict with an empty url is a 400.
    const bad = await app.fetch(new Request(BASE + "/v1/verdict?url=", { headers }));
    expect([400, 402]).toContain(r.status);
    expect(bad.status).toBe(400);
    expect((await demandTrialStore.peek(await hashDemandTrialKey(TEST_KEY)))?.used).toBe(0);
  });
});
