/**
 * Vigil 2026-11-19: purchase responses that carry a secret come back as 201 (Feed key, Monitor plan) and must never be
 * written to the shared idempotency table. requirePayment stores status 200 only; these tests pin that for real routes.
 */
import { describe, it, expect } from "vitest";
import { deriveAddress, deriveKeypair, generateSeed, sign } from "ripple-keypairs";
import { createApp } from "../src/app";
import { MemoryIdempotencyStore } from "../src/idempotency";
import { FACILITATOR, DATA, NOW, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";

const BASE = "https://lumi.test";
const OWNER = "owner-key-for-tests-0123456789-abcdefghijklmnop";
const seed = generateSeed({ entropy: Uint8Array.from({ length: 16 }, (_, i) => i + 7) });
const kp = deriveKeypair(seed);
const SELLER = deriveAddress(kp.publicKey);
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();

function setup() {
  const env = { XRPL_NETWORK: "xrpl:1", PAY_TO: SELLER, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PUBLIC_BASE_URL: BASE, OWNER_MCP_KEY: OWNER };
  const fac = happyFacilitator();
  const idem = new MemoryIdempotencyStore();
  const app = createApp(env as any, { fetch: makeFetch(fac), log: () => {}, now: () => NOW, idempotencyStore: idem });
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(BASE + path, init));
  const post = (path: string, body: unknown) => req(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  return { req, post, idem, fac };
}

async function payWithKey(s: ReturnType<typeof setup>, path: string, ik: string) {
  const q = await s.req(path);
  expect(q.status).toBe(402);
  const xrp = (await q.json()).accepts.find((a: any) => a.asset === "XRP");
  const h = { "PAYMENT-SIGNATURE": paymentHeaderFor(xrp), "Idempotency-Key": ik };
  const r = await s.req(path, { headers: h });
  return { r, text: await r.text(), h };
}

describe("201 purchase bodies with secrets are never stored for idempotent replay", () => {
  it("Feed subscription without key_id: 201 with a new api_key, nothing stored, the retry does not return the key", async () => {
    const s = setup();
    const { r, text, h } = await payWithKey(s, "/v1/feed/subscribe/feed", "feed-buy-0123456789abcdef");
    expect(r.status).toBe(201);
    expect(JSON.parse(text).api_key).toMatch(/^lumi_fk_/);
    expect(s.idem.rows.size).toBe(0);
    const again = await s.req("/v1/feed/subscribe/feed", { headers: h });
    expect(again.headers.get("Idempotent-Replayed")).toBeNull();
    expect(await again.text()).not.toMatch(/lumi_fk_/);
    expect(s.fac.calls.filter((c) => c.path === "/settle").length).toBe(1);
  });

  it("Monitor Watch purchase: 201, nothing stored", async () => {
    const s = setup();
    const { message } = await (await s.req(`/v1/monitor/challenge?pay_to=${SELLER}`)).json();
    const en = await s.post("/v1/monitor/enroll", { message, signature: sign(hex(message), kp.privateKey), public_key: kp.publicKey, endpoints: [{ url: `${BASE}/v1/verdict?url=https://a.example/x` }] });
    expect(en.status).toBe(201);
    const e: any = await en.json();
    const { r } = await payWithKey(s, `/v1/monitor/subscribe/watch?enrollment=${e.enrollment_id}&endpoints=1`, "watch-buy-0123456789abcdef");
    expect(r.status).toBe(201);
    expect(s.idem.rows.size).toBe(0);
  });
});
