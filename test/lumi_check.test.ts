import { describe, it, expect } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { createApp } from "../src/app";
import { MemoryTrustStore, type ObservationRow, type ProbeRow } from "../src/trust/store";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { deriveAddress, deriveKeypair, generateSeed, sign } from "ripple-keypairs";
import { NOW, PAY_TO, FACILITATOR, DATA, happyFacilitator, makeFetch, paymentHeaderFor } from "./helpers";
import { signResponse, verifySignedResponse, signingKeyFrom, keyIdOf } from "../src/trust/lumi_sign";
import { originPath, badgeDecision, BADGE_MIN_SCORE } from "../src/trust/check";

const D = 86_400_000;
const BASE = "https://api.lumitrades.io";
const OWNER = "owner-key-for-tests-0123456789-abcdefghijklmnop";
// Ephemeral test key generated per run; never printed.
const SEED = Buffer.from(ed25519.utils.randomPrivateKey()).toString("hex");
const PUB = Buffer.from(ed25519.getPublicKey(Buffer.from(SEED, "hex"))).toString("hex");
const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", PUBLIC_BASE_URL: BASE, OWNER_MCP_KEY: OWNER, LUMI_CHECK_SIGNING_KEY: SEED };

const obs = (vendor_id: string, ts: number, o: Partial<ObservationRow> = {}): ObservationRow => ({
  vendor_id, endpoint: `https://api.${vendor_id}.com/x`, ts, network: "xrpl:0", tx_hash: `${vendor_id}${ts}`.padEnd(64, "0"), amount: "1000", asset: "XRP",
  http_status: 200, data_returned: true, latency_ms: 100, summary: "ok", source: "test", ...o,
});
const probe = (vendor_id: string, ts: number): ProbeRow => ({ vendor_id, endpoint: `https://api.${vendor_id}.com/x`, ts, http_status: 402, ok: true, price: "1000", asset: "XRP", pay_to: "r", source_tag: null, latency_ms: 200, error: null } as any);

function mk(env: Record<string, string> = {}) {
  const trustStore = new MemoryTrustStore([]);
  let t = NOW;
  const app = createApp({ ...ENV, ...env } as any, { trustStore, catalogStore: new MemoryCatalogStore(), now: () => t, fetch: makeFetch(happyFacilitator()), log: () => {} } as any);
  const get = (p: string) => app.fetch(new Request(BASE + p));
  return { app, trustStore, get, advance: (ms: number) => (t += ms) };
}
async function seedGood(s: ReturnType<typeof mk>, id = "printmoneylab") {
  for (let i = 1; i <= 5; i++) await s.trustStore.addObservation(obs(id, NOW - i * D));
  await s.trustStore.addProbes(Array.from({ length: 20 }, (_, i) => probe(id, NOW - i * 3_600_000)));
}

describe("lumi signed responses", () => {
  it("signs and verifies; tampering, wrong key and expiry fail", async () => {
    const key = (await signingKeyFrom(SEED))!;
    expect(key.public_key).toBe(PUB);
    expect(key.key_id).toBe(await keyIdOf(PUB));
    const r = await signResponse("lumi_check", { decision: "allow" }, key, NOW, 900);
    expect((await verifySignedResponse(r, { trusted: [PUB], now: NOW })).ok).toBe(true);
    expect((await verifySignedResponse(r, { trusted: [], now: NOW })).errors).toContain("untrusted_key");
    const bad = { ...r, payload: { decision: "block" } };
    expect((await verifySignedResponse(bad, { trusted: [PUB], now: NOW })).errors).toContain("receipt_hash_mismatch");
    expect((await verifySignedResponse(r, { trusted: [PUB], now: NOW + 901_000 })).errors).toContain("expired");
    const unsigned = await signResponse("lumi_check", {}, null, NOW, 900);
    expect(unsigned.signer.signature).toBeNull();
    expect((await verifySignedResponse(unsigned, { trusted: [PUB], now: NOW })).errors).toContain("unsigned");
    expect(await signingKeyFrom("not-hex")).toBeNull();
  });
  it("originPath drops query strings, fragments and userinfo", () => {
    expect(originPath("https://User:pw@API.x.com/v1/data/?q=secret&k=1#f")).toBe("https://api.x.com/v1/data");
    expect(originPath("ftp://x.com/a")).toBeNull();
  });
});

describe("GET /v1/check (free pre-pay check)", () => {
  it("returns a signed allow/warn/block with score and link, never echoes the query string", async () => {
    const s = mk();
    await seedGood(s);
    const r = await s.get(`/v1/check?url=${encodeURIComponent("https://api.printmoneylab.com/x?token=SECRET123")}&amount=0.01`);
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(["allow", "warn", "block"]).toContain(b.decision);
    expect(Array.isArray(b.reasons)).toBe(true);
    expect(b.link).toBe(`${BASE}/trust/v/api.printmoneylab.com`);
    expect(b.score.scored).toBe(true);
    expect(typeof b.score.value).toBe("number");
    expect(JSON.stringify(b)).not.toContain("SECRET123");
    const v = await verifySignedResponse(b.receipt, { trusted: [PUB], now: NOW });
    expect(v).toMatchObject({ ok: true });
    expect(b.receipt.payload.decision).toBe(b.decision);
    const keys = await (await s.get("/v1/check/keys")).json();
    expect(keys.keys[0].public_key).toBe(PUB);
  });
  it("unknown sellers get a decision and not_scored; bad input is a 400", async () => {
    const s = mk();
    const b = await (await s.get(`/v1/check?url=${encodeURIComponent("https://unknown-seller.example/v1/x")}`)).json();
    expect(["allow", "warn", "block"]).toContain(b.decision);
    expect(b.score.scored).toBe(false);
    expect((await s.get("/v1/check?url=nope")).status).toBe(400);
  });
  it("unsigned when no signing key is configured", async () => {
    const s = mk({ LUMI_CHECK_SIGNING_KEY: "" });
    const b = await (await s.get(`/v1/check?url=${encodeURIComponent("https://unknown-seller.example/v1/x")}`)).json();
    expect(b.receipt.signer.signature).toBeNull();
    expect(b.receipt.signer.unsigned_reason).toBe("signing_key_not_configured");
  });
});

describe("earned-only Tested by Lumi badge (/v1/badge/{key})", () => {
  it("earned with a live score at/above threshold; signed, short-lived, links to the live report", async () => {
    const s = mk();
    await seedGood(s);
    const r = await s.get("/v1/badge/printmoneylab.json");
    const b = await r.json();
    expect(b.score.value).toBeGreaterThanOrEqual(BADGE_MIN_SCORE);
    expect(b.earned).toBe(true);
    expect(b.purchasable).toBe(false);
    expect(b.live_report).toBe(`${BASE}/trust/v/printmoneylab`);
    expect(b.embed).toContain(`href="${BASE}/trust/v/printmoneylab"`);
    expect(r.headers.get("Cache-Control")).toContain("max-age=300");
    const v = await verifySignedResponse(b.signed, { trusted: [PUB], now: NOW });
    expect(v.ok).toBe(true);
    expect(b.signed.payload.earned).toBe(true);
    expect(Date.parse(b.signed.expires_at) - NOW).toBe(15 * 60_000);
    const svg = await (await s.get("/v1/badge/printmoneylab.svg")).text();
    expect(svg).toContain("Tested by Lumi");
    // the host of a curated endpoint maps to the vendor
    expect((await (await s.get("/v1/badge/api.printmoneylab.com.json")).json()).earned).toBe(true);
  });

  it("disappears automatically when the live score drops below the threshold", async () => {
    const s = mk();
    await seedGood(s);
    expect((await (await s.get("/v1/badge/printmoneylab.json")).json()).earned).toBe(true);
    for (let i = 0; i < 6; i++) await s.trustStore.addObservation(obs("printmoneylab", NOW - 3600_000 * (i + 1), { data_returned: false, http_status: 500, tx_hash: `f${i}`.padEnd(64, "0") }));
    const after = await (await s.get("/v1/badge/printmoneylab.json")).json();
    expect(after.earned).toBe(false);
    expect(["score_below_threshold", "latest_test_buy_not_delivered"]).toContain(after.reason);
    expect(after.signed.payload.earned).toBe(false);
    expect(after.embed).toBeNull();
    const svg = await (await s.get("/v1/badge/printmoneylab.svg")).text();
    expect(svg).not.toContain("Tested by Lumi");
    expect(svg).toContain("no badge");
  });

  it("a signed earned verdict cannot be replayed after it expires", async () => {
    const s = mk();
    await seedGood(s);
    const b = await (await s.get("/v1/badge/printmoneylab.json")).json();
    expect((await verifySignedResponse(b.signed, { trusted: [PUB], now: NOW + 16 * 60_000 })).ok).toBe(false);
  });

  it("paying or monitoring status cannot grant it", async () => {
    // Pure rule: extra inputs such as a paid plan or monitoring are ignored.
    const low = { score: { value: 40, confidence: "high", samples: { paid_test_buys: 20, delivered: 8 } }, last_conclusive: "delivered" as const };
    expect(badgeDecision({ ...low, monitored: true, paid_usd: 999, plan: "monitor_plus" } as any).earned).toBe(false);
    // End to end: an unscored, unknown seller with a monitoring enrolment still gets no badge.
    const s = mk({ SALES_TEST_WALLETS: PAY_TO });
    const key = "unknown-seller.example";
    const before = await (await s.get(`/v1/badge/${key}.json`)).json();
    expect(before.earned).toBe(false);
    // Enrol/subscribe paths are separate: the monitoring badge never feeds the Tested decision.
    const mon = await s.get(`/v1/monitor/badge/men_${"0".repeat(24)}.json`);
    expect([200, 404]).toContain(mon.status);
    const after = await (await s.get(`/v1/badge/${key}.json`)).json();
    expect(after.earned).toBe(false);
    expect(after.purchasable).toBe(false);
  });

  it("end to end: paying Lumi (paid check, monitoring enrolment + plan) leaves the badge and score unchanged", async () => {
    const xs = generateSeed({ entropy: Uint8Array.from({ length: 16 }, (_, i) => i + 7) });
    const kp = deriveKeypair(xs);
    const SELLER = deriveAddress(kp.publicKey);
    const s = mk({ PAY_TO: SELLER, SALES_TEST_WALLETS: SELLER });
    await seedGood(s);
    // a below-threshold seller
    for (let i = 1; i <= 5; i++) await s.trustStore.addObservation(obs("cryptobuddy", NOW - i * D, { data_returned: i > 3, http_status: i > 3 ? 200 : 500 }));
    const strip = (x: any) => JSON.parse(JSON.stringify(x, (k, v) => (k === "signed" ? undefined : v)));
    const before = { good: strip(await (await s.get("/v1/badge/printmoneylab.json")).json()), low: strip(await (await s.get("/v1/badge/cryptobuddy.json")).json()) };
    const scoreBefore = (await (await s.get("/v1/trust/vendors/printmoneylab")).json()).score;
    const vstrip = (x: any) => JSON.parse(JSON.stringify(x, (k, v) => (["commercial_relationship", "generated_at", "as_of", "meta", "monitoring"].includes(k) ? undefined : v)));
    const listBefore = vstrip(await (await s.get("/v1/trust/vendors")).json());
    const lookupBefore = vstrip(await (await s.get(`/v1/trust/vendors?payTo=${SELLER}`)).json());
    expect(before.low.earned).toBe(false);
    const req = (p: string, init: RequestInit = {}) => s.app.fetch(new Request(BASE + p, init));
    const pay = async (p: string) => {
      const q = await req(p);
      expect(q.status).toBe(402);
      const xrp = (await q.json()).accepts.find((a: any) => a.asset === "XRP");
      return req(p, { headers: { "PAYMENT-SIGNATURE": paymentHeaderFor(xrp) } });
    };
    // 1. paid trust check for both sellers
    const paid = await pay(`/v1/trust/check?url=${encodeURIComponent("https://api.cryptobuddy.com/x?k=SECRET")}`);
    expect(paid.status).toBe(200);
    const pb = await paid.json();
    expect((await verifySignedResponse(pb.lumi_receipt, { trusted: [PUB], now: NOW })).ok).toBe(true);
    expect(JSON.stringify(pb)).not.toContain("SECRET");
    // 2. monitoring enrolment + paid plan
    const hex = (x: string) => Buffer.from(x, "utf8").toString("hex").toUpperCase();
    const { message } = await (await req(`/v1/monitor/challenge?pay_to=${SELLER}`)).json();
    const en = await req("/v1/monitor/enroll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, signature: sign(hex(message), kp.privateKey), public_key: kp.publicKey, endpoints: [{ url: `${BASE}/v1/lite/XRP` }] }) });
    expect(en.status).toBe(201);
    const sub = await pay(`/v1/monitor/subscribe/monitor?enrollment=${(await en.json()).enrollment_id}`);
    expect([200, 201]).toContain(sub.status);
    const after = { good: strip(await (await s.get("/v1/badge/printmoneylab.json")).json()), low: strip(await (await s.get("/v1/badge/cryptobuddy.json")).json()) };
    expect(after).toEqual(before);
    expect((await (await s.get("/v1/trust/vendors/printmoneylab")).json()).score).toEqual(scoreBefore);
    // ranking, tiers and scores of the whole list, and the seller's own lookup tier, are unchanged
    expect(vstrip(await (await s.get("/v1/trust/vendors")).json())).toEqual(listBefore);
    expect(vstrip(await (await s.get(`/v1/trust/vendors?payTo=${SELLER}`)).json())).toEqual(lookupBefore);
    expect((await (await s.get(`/v1/badge/${new URL(BASE).hostname}.json`)).json()).earned).toBe(false);
  });
});
