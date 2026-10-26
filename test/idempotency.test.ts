import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { MemoryIdempotencyStore, PAYMENT_IDENTIFIER_DECLARATION } from "../src/idempotency";
import { DATA, FACILITATOR, PAY_TO, happyFacilitator, makeFetch, paymentHeaderFor, decodeB64Json, NOW } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret" };
const BASE = "http://lumi.test";
const KEY = "retry-key-0123456789abcdef";

function setup(store = new MemoryIdempotencyStore(), fac = happyFacilitator()) {
  const logs: any[] = [];
  const app = createApp(ENV, { fetch: makeFetch(fac), log: (e) => logs.push(e), now: () => NOW, idempotencyStore: store });
  const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(BASE + path, { headers }));
  return { app, get, fac, logs, store };
}
const quote = async (get: (p: string) => Promise<Response>, p: string) => (await (await get(p)).json()).accepts[0];

describe("idempotent retries on paid routes", () => {
  it("every 402 declares the optional x402 payment-identifier extension next to bazaar", async () => {
    const { get } = setup();
    const r = await get("/v1/fear-greed");
    const body = await r.json();
    expect(body.extensions["payment-identifier"]).toEqual(PAYMENT_IDENTIFIER_DECLARATION);
    expect(decodeB64Json(r.headers.get("PAYMENT-REQUIRED")).extensions["payment-identifier"].info.required).toBe(false);
    expect(r.headers.get("Access-Control-Expose-Headers")).toContain("Idempotent-Replayed");
  });

  it("same Idempotency-Key + same payment: settled once, the retry gets the cached response", async () => {
    const { get, fac } = setup();
    const req = await quote(get, "/v1/institutional");
    const h = { "PAYMENT-SIGNATURE": paymentHeaderFor(req), "Idempotency-Key": KEY };
    const first = await get("/v1/institutional", h);
    expect(first.status).toBe(200);
    const firstBody = await first.text();
    const receipt = first.headers.get("PAYMENT-RESPONSE");
    expect(fac.calls.map((c) => c.path)).toEqual(["/verify", "/settle"]);
    for (let i = 0; i < 2; i++) {
      const again = await get("/v1/institutional", h);
      expect(again.status).toBe(200);
      expect(again.headers.get("Idempotent-Replayed")).toBe("true");
      expect(again.headers.get("PAYMENT-RESPONSE")).toBe(receipt);
      expect(await again.text()).toBe(firstBody);
    }
    expect(fac.calls).toHaveLength(2); // never verified or settled again
  });

  it("without a key a retry is still never charged twice (replay guard: 402 invoice_already_used)", async () => {
    const { get, fac } = setup();
    const req = await quote(get, "/v1/fear-greed");
    const h = { "PAYMENT-SIGNATURE": paymentHeaderFor(req) };
    expect((await get("/v1/fear-greed", h)).status).toBe(200);
    const r = await get("/v1/fear-greed", h);
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe("invoice_already_used");
    expect(fac.calls).toHaveLength(2);
  });

  it("same key with a different payment: 409, not charged, nothing verified", async () => {
    const { get, fac } = setup();
    const a = await quote(get, "/v1/fear-greed");
    expect((await get("/v1/fear-greed", { "PAYMENT-SIGNATURE": paymentHeaderFor(a), "Idempotency-Key": KEY })).status).toBe(200);
    const b = await quote(get, "/v1/fear-greed");
    const r = await get("/v1/fear-greed", { "PAYMENT-SIGNATURE": paymentHeaderFor(b), "Idempotency-Key": KEY });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "idempotency_key_reused", note: "Not charged." });
    expect(fac.calls).toHaveLength(2);
  });

  it("accepts the x402 payment-identifier extension id as the key (shared store across isolates)", async () => {
    const store = new MemoryIdempotencyStore();
    const fac = happyFacilitator();
    const A = setup(store, fac);
    const B = setup(store, fac);
    const req = await quote(A.get, "/v1/fear-greed");
    const payload = { x402Version: 2, accepted: req, payload: { signedTxBlob: "12000022", invoiceId: req.extra.invoiceId }, extensions: { "payment-identifier": { info: { required: false, id: "pay_0123456789abcdef" } } } };
    const h = { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") };
    expect((await A.get("/v1/fear-greed", h)).status).toBe(200);
    const r = await B.get("/v1/fear-greed", h);
    expect(r.status).toBe(200);
    expect(r.headers.get("Idempotent-Replayed")).toBe("true");
    expect(fac.calls).toHaveLength(2);
    expect(store.rows.size).toBe(1);
    expect([...store.rows.keys()][0]).not.toContain("pay_0123456789abcdef"); // stored hashed
  });

  it("a malformed key is a 400 before any verification (not charged); keys without a payment are ignored", async () => {
    const { get, fac } = setup();
    const req = await quote(get, "/v1/fear-greed");
    const r = await get("/v1/fear-greed", { "PAYMENT-SIGNATURE": paymentHeaderFor(req), "Idempotency-Key": "short" });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: "invalid_idempotency_key", note: "Not charged." });
    expect(fac.calls).toHaveLength(0);
    expect((await get("/v1/fear-greed", { "Idempotency-Key": "short" })).status).toBe(402);
  });

  it("a failed paid call is not cached: retrying with the same key can still succeed", async () => {
    let fail = true;
    const base = happyFacilitator();
    const fac = { ...base, settle: (b: any) => (fail ? new Response(JSON.stringify({ success: false, errorReason: "tecUNFUNDED_PAYMENT", transaction: "", network: "xrpl:1" }), { status: 200 }) : base.settle(b)) };
    const { get, store } = setup(new MemoryIdempotencyStore(), fac as any);
    const req = await quote(get, "/v1/fear-greed");
    const r1 = await get("/v1/fear-greed", { "PAYMENT-SIGNATURE": paymentHeaderFor(req), "Idempotency-Key": KEY });
    expect(r1.status).not.toBe(200);
    expect(store.rows.size).toBe(0);
    fail = false;
    const req2 = await quote(get, "/v1/fear-greed");
    expect((await get("/v1/fear-greed", { "PAYMENT-SIGNATURE": paymentHeaderFor(req2), "Idempotency-Key": KEY })).status).toBe(200);
  });

  it("keeps working when the store fails (fail-open, still single settlement via the replay guard)", async () => {
    const broken = { get: async () => { throw new Error("d1 down"); }, put: async () => { throw new Error("d1 down"); } };
    const { get, fac, logs } = setup(broken as any);
    const req = await quote(get, "/v1/fear-greed");
    const h = { "PAYMENT-SIGNATURE": paymentHeaderFor(req), "Idempotency-Key": KEY };
    expect((await get("/v1/fear-greed", h)).status).toBe(200);
    expect((await get("/v1/fear-greed", h)).status).toBe(402);
    expect(fac.calls).toHaveLength(2);
    expect(logs.some((l) => l.event === "idempotency_store_error")).toBe(true);
  });
});
