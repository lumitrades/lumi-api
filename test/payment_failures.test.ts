import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { MemoryTrafficStore, TrafficBuffer, payFailFrom, payHeaderMeta, safeReason, type TrafficRow } from "../src/traffic";
import { DATA, NOW, FACILITATOR, PAY_TO, PAYER, makeFetch, happyFacilitator, jsonResponse, paymentHeaderFor, decodeB64Json } from "./helpers";

const ENV = { XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, OWNER_MCP_KEY: "owner-key-for-tests-0123456789abcdef", INVOICE_SECRET: "test-secret" };
const BASE = "http://lumi.test";
const ROUTE = "/v1/trust/check?url=https://api.example.com/x";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const EVM_PAYER = "0x1111111111111111111111111111111111111111";

describe("refused payment attempts are logged (no payer address or signature)", () => {
  it("records one event per refused attempt with route, reason, network, scheme, version and UA family", async () => {
    const fac = happyFacilitator();
    fac.verify = () => jsonResponse(200, { isValid: false, invalidReason: `insufficient_funds for ${PAYER}`, payer: PAYER });
    const trafficStore = new MemoryTrafficStore();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    try {
      const app = createApp(ENV as any, { fetch: makeFetch(fac), log: () => {}, now: () => NOW, trafficStore, trafficFlushMs: 10 * 60_000 });
      const waits: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
      const send = async (headers: Record<string, string>) => {
        const req = new Request(BASE + ROUTE, { headers: { "User-Agent": "x402-fetch/0.6 (node)", "CF-Connecting-IP": "203.0.113.5", ...headers } });
        const res = await app.fetch(req, ctx);
        app.logTraffic(req, res, ctx);
        return res;
      };
      // a plain 402 quote: not a failure
      const q = await send({});
      expect(q.status).toBe(402);
      const accepts = decodeB64Json(q.headers.get("PAYMENT-REQUIRED")).accepts;
      // v1 header (x402 v1 SDKs)
      const v1 = await send({ "X-PAYMENT": b64({ x402Version: 1, scheme: "exact", network: "base", payload: { signature: "0x" + "ab".repeat(65), authorization: { from: EVM_PAYER } } }) });
      expect(v1.status).toBe(402);
      // garbage header
      await send({ "PAYMENT-SIGNATURE": "%%%not-base64%%%" });
      // v2 with tampered requirements
      await send({ "PAYMENT-SIGNATURE": paymentHeaderFor({ ...accepts[0], amount: "1" }) });
      // v2 that the facilitator refuses at verify
      const vf = await send({ "PAYMENT-SIGNATURE": paymentHeaderFor(accepts[0]) });
      expect(vf.status).toBeGreaterThanOrEqual(400);
      await Promise.all(waits);
      await app.flushTraffic();

      const fails = trafficStore.list.flatMap((x) => x.b.pay_fails ?? []);
      expect(fails.length).toBe(4);
      const reasons = fails.map((f) => f.reason);
      expect(reasons).toContain("invalid_payment_signature_header");
      expect(reasons).toContain("payment_requirements_mismatch");
      expect(reasons.some((r) => r.startsWith("verify_failed") || r.includes("insufficient_funds") || r.startsWith("invalid"))).toBe(true);
      // a v1 payload has no `accepted` block, so the server refuses it as an unusable header; the event still says v1
      const v1f = fails.find((f) => f.x402_version === 1)!;
      expect(v1f).toMatchObject({ route: "/v1/trust/check", status: 402, reason: "invalid_payment_signature_header", network: "base", scheme: "exact", ua_family: "x402-fetch/0.6" });
      expect(fails.find((f) => f.network === "undecodable")).toMatchObject({ reason: "invalid_payment_signature_header", x402_version: null });
      expect(fails.find((f) => f.reason === "payment_requirements_mismatch")).toMatchObject({ network: "xrpl:1", x402_version: 2 });
      for (const f of fails) expect(typeof f.ts).toBe("number");

      const stored = JSON.stringify(trafficStore.list) + logs.join("\n");
      expect(stored).not.toContain(PAYER);
      expect(stored).not.toContain(EVM_PAYER);
      expect(stored).not.toContain("ab".repeat(20));
      expect(stored).not.toContain("12000022"); // signed tx blob
      expect(stored).not.toContain("203.0.113.5");
      expect(logs.filter((l) => l.includes('"event":"x402_payment_failed"')).length).toBe(4);

      const r = await app.fetch(new Request(BASE + "/v1/owner/traffic?days=2", { headers: { Authorization: "Bearer owner-key-for-tests-0123456789abcdef" } }));
      const s: any = await r.json();
      expect(s.payment_failures.total).toBe(4);
      expect(s.payment_failures.by_reason.invalid_payment_signature_header).toBe(2);
      expect(s.payment_failures.by_x402_version).toMatchObject({ v1: 1, v2: 2, unknown: 1 });
      expect(s.payment_failures.by_route["/v1/trust/check"]).toBe(4);
      expect(s.payment_failures.recent.length).toBe(4);
      expect(JSON.stringify(s)).not.toContain(PAYER);
    } finally {
      console.log = origLog;
    }
  });

  it("a refused attempt flushes at once, but at most one extra D1 row per 10 s per isolate", async () => {
    const store = new MemoryTrafficStore();
    const buf = new TrafficBuffer(store, { flushMs: 10 * 60_000 });
    const row = (ts: number, fail: boolean): TrafficRow => ({
      ts, day: "2026-10-22", method: "GET", path: "/v1/trust/check", status: 402, ua: null, ua_class: "sdk", ref_host: null, ip_hash: null, country: null, is_402: true, paid: false,
      ...(fail ? { pay_fail: { ts, route: "/v1/trust/check", status: 402, reason: "invalid_x402_version", network: "base", scheme: "exact", x402_version: 1, ua_family: "x" } } : {}),
    });
    for (let i = 0; i < 50; i++) await buf.add(row(NOW + i * 100, true), NOW + i * 100);
    expect(store.list.length).toBe(1); // first one flushed at once, the rest held for the window
    await buf.add(row(NOW + 11_000, true), NOW + 11_000);
    expect(store.list.length).toBe(2);
    await buf.flush();
    expect(store.list.reduce((n, x) => n + (x.b.pay_fails?.length ?? 0), 0)).toBe(51);
    await buf.add(row(NOW + 12_000, false), NOW + 12_000);
    expect(store.list.length).toBe(2); // no flush for a normal 402
  });

  it("header meta and reasons never carry payload fields; no event without a payment header or on success", () => {
    expect(payHeaderMeta(b64({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", payTo: EVM_PAYER }, payload: { from: EVM_PAYER } }))).toEqual({ x402_version: 2, scheme: "exact", network: "eip155:8453" });
    expect(payHeaderMeta(b64({ x402Version: 2, accepted: { scheme: "exact", network: EVM_PAYER + "<script>" } })).network).toBe("other");
    expect(safeReason(`settle_failed:invalid_exact_evm_payload_authorization_value from ${EVM_PAYER} tx ${"f".repeat(64)} ${PAYER}`)).not.toMatch(/1111111111|ffffffffff|rBCpEB/);
    expect(safeReason("settle_failed:invalid_exact_evm_payload_authorization_value")).toBe("settle_failed:invalid_exact_evm_payload_authorization_value");
    const req = (h: Record<string, string>) => new Request(BASE + "/v1/verdict", { headers: h });
    expect(payFailFrom(req({}), 402, '{"error":"x"}', NOW)).toBeNull();
    expect(payFailFrom(req({ "X-PAYMENT": "abc" }), 200, "{}", NOW)).toBeNull();
    expect(payFailFrom(req({ "X-PAYMENT": "abc" }), 502, '{"error":"settlement_failed","reason":"settlement_status_unknown"}', NOW)?.reason).toBe("settlement_failed:settlement_status_unknown");
    expect(payFailFrom(req({ "X-PAYMENT": "abc" }), 504, "<html>timeout</html>", NOW)?.reason).toBe("http_504");
  });
});
