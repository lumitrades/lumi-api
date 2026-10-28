/**
 * Trust and verdict routes settle Base USDC ONLY through Coinbase CDP (config CDP_ONLY_ROUTES; owner approved
 * 2026-10-28, branch only). The keyless fallback (PayAI on mainnet) is never called for them: no verify, no settle, so
 * their payload, resource description and bazaar declaration never reach PayAI. Low-risk routes (feed credits, monitor
 * packs) keep the PayAI fallback. A CDP outage on a trust route is a 503 cdp_unavailable with payment_help, never a
 * silent fallback. docs/facilitator-routing.md.
 */
import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { loadConfig, CDP_ONLY_ROUTES, PAID_ROUTES } from "../src/config";
import { requirePayment, MemoryReplayGuard, isCdpOnlyQuote, buildEvmRequirement, type Quote } from "../src/x402";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { x402Client } from "@x402/fetch";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, jsonResponse, makeFetch } from "./helpers";

const EVM_PAY_TO = "0x5E617bac19912e6d212CB303ae84655E9E203532";
const PAYAI = "https://payai.test";
const CDP = "https://cdp.test/platform/v2/x402";
const TX = "0x" + "d".repeat(64);

async function testKey() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { keyId: "00000000-1111-2222-3333-444444444444", secret: Buffer.concat([Buffer.from(jwk.d!, "base64url"), Buffer.from(jwk.x!, "base64url")]).toString("base64") };
}

type Handler = (body: any) => Response | Promise<Response>;
const okVerify: Handler = (b) => jsonResponse(200, { isValid: true, payer: b.paymentPayload.payload.authorization.from });
const okSettle: Handler = (b) => jsonResponse(200, { success: true, transaction: TX, network: b.paymentRequirements.network, payer: b.paymentPayload.payload.authorization.from });

/** Records every facilitator call by host: cdp / payai. XRPL facilitator traffic goes to the happy test facilitator. */
function harness(cdp: { verify?: Handler; settle?: Handler } = {}) {
  const calls: string[] = [];
  const bodies: { fac: string; body: any }[] = [];
  const base = makeFetch(happyFacilitator());
  const fetch: typeof globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [fac, prefix, h] of [["cdp", CDP, { verify: cdp.verify ?? okVerify, settle: cdp.settle ?? okSettle }], ["payai", PAYAI, { verify: okVerify, settle: okSettle }]] as const) {
      if (url.startsWith(prefix)) {
        const path = url.slice(prefix.length);
        const body = JSON.parse(String(init?.body ?? "{}"));
        calls.push(`${fac}${path}`);
        bodies.push({ fac, body });
        return path === "/verify" ? h.verify(body) : h.settle(body);
      }
    }
    return base(input, init);
  }) as typeof globalThis.fetch;
  return { calls, bodies, fetch };
}

async function env(extra: Record<string, unknown> = {}) {
  const k = await testKey();
  return {
    XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret",
    EVM_PAY_TO, EVM_NETWORK: "eip155:8453", EVM_FACILITATOR_URL: PAYAI, CDP_FACILITATOR_URL: CDP,
    CDP_API_KEY_ID: k.keyId, CDP_API_KEY_SECRET: k.secret, ...extra,
  } as Record<string, any>;
}

async function signBase(accepts: any[], x402Version = 2, resource?: unknown, extensions?: unknown) {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  const payload: any = await client.createPaymentPayload({ x402Version, accepts: accepts.filter((a) => a.network === "eip155:8453"), resource, extensions } as any);
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/** requirePayment directly with a route's quote shape, so every paid route (and the plan routes) can be exercised. */
async function payRoute(routeKey: string, cdp: { verify?: Handler; settle?: Handler } = {}, extra: Record<string, unknown> = {}) {
  const h = harness(cdp);
  const cfg = loadConfig((await env(extra)) as any);
  const logs: any[] = [];
  const deps = { fetch: h.fetch, replay: new MemoryReplayGuard(), log: (e: any) => logs.push(e) };
  const quote: Quote = { routeKey, amountDrops: "10000", amountEvm: "10000", description: `test ${routeKey}`, resourceUrl: `https://api.lumitrades.io/test/${routeKey}` };
  const serve = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  const first = await requirePayment(new Request(quote.resourceUrl), cfg, deps, quote, serve);
  const pr = await first.json();
  // No Base option offered (trust route without CDP): sign a Base payment for the same invoice anyway, as a buyer
  // reusing an old quote would, to prove it is refused without any facilitator call.
  const accepts = pr.accepts.some((a: any) => a.network.startsWith("eip155:"))
    ? pr.accepts
    : [buildEvmRequirement(loadConfig((await env()) as any), quote, pr.accepts[0].extra.invoiceId)];
  const header = await signBase(accepts, pr.x402Version, pr.resource, pr.extensions);
  const r = await requirePayment(new Request(quote.resourceUrl, { headers: { "PAYMENT-SIGNATURE": header } }), cfg, deps, quote, serve);
  return { r, calls: h.calls, bodies: h.bodies, logs, cfg, quote, pr, header, deps, serve };
}

const CDP_DOWN: [string, Handler][] = [
  ["5xx", () => jsonResponse(503, { error: "down" })],
  ["401 bad key", () => jsonResponse(401, { errorType: "unauthorized" })],
  ["429 rate limited", () => jsonResponse(429, { error: "slow down" })],
  ["network error", () => { throw new TypeError("fetch failed"); }],
  ["unparseable reply", () => new Response("<html>gateway</html>", { status: 200 })],
  ["facilitator-side invalid reason", () => jsonResponse(200, { isValid: false, invalidReason: "invalid_bazaar_extension" })],
];

describe("config: CDP-only route set", () => {
  it("defaults to every trust/verdict paid route; 'none' and explicit lists override; unknown names fail loudly", async () => {
    expect([...CDP_ONLY_ROUTES].sort()).toEqual(["batch_check", "high_value_check", "receipts", "vendor_report", "verdict"]);
    expect([...CDP_ONLY_ROUTES].sort()).toEqual([...PAID_ROUTES].sort()); // every app paid route is a trust route
    expect(loadConfig((await env()) as any).evm!.cdpOnlyRoutes.sort()).toEqual([...CDP_ONLY_ROUTES].sort());
    expect(loadConfig((await env({ EVM_CDP_ONLY_ROUTES: "none" })) as any).evm!.cdpOnlyRoutes).toEqual([]);
    expect(loadConfig((await env({ EVM_CDP_ONLY_ROUTES: "verdict, receipts" })) as any).evm!.cdpOnlyRoutes).toEqual(["verdict", "receipts"]);
    expect(() => loadConfig({ XRPL_NETWORK: "xrpl:1", PAY_TO, INVOICE_SECRET: "s", EVM_PAY_TO, EVM_CDP_ONLY_ROUTES: "feed_credits" } as any)).toThrow(/EVM_CDP_ONLY_ROUTES/);
    const cfg = loadConfig((await env()) as any);
    for (const k of ["verdict:a-example", "verdict:probe", "high_value_check:x", "receipts:template", "batch_check:3", "vendor_report:heurist-mesh"]) expect(isCdpOnlyQuote(cfg, { routeKey: k })).toBe(true);
    for (const k of ["feed_credits:key1", "founder_pack:e1", "retest_pack:e1", "watch:e1:n1:t1", "feed:new"]) expect(isCdpOnlyQuote(cfg, { routeKey: k })).toBe(false);
  });
});

describe("per-route facilitator selection", () => {
  for (const route of ["verdict", "high_value_check", "receipts", "batch_check", "vendor_report"]) {
    it(`${route}: CDP verify + settle only; PayAI never contacted`, async () => {
      const { r, calls, logs } = await payRoute(`${route}:subject`);
      expect(r.status).toBe(200);
      expect(calls).toEqual(["cdp/verify", "cdp/settle"]);
      expect(logs).toContainEqual(expect.objectContaining({ event: "x402_settled", facilitator: "cdp" }));
    });
  }

  for (const routeKey of ["feed_credits:key1", "founder_pack:e1", "retest_pack:e1", "watch:e1:n1:t1"]) {
    it(`${routeKey.split(":")[0]} (low risk): CDP first, PayAI still the fallback when CDP is down`, async () => {
      const ok = await payRoute(routeKey);
      expect(ok.r.status).toBe(200);
      expect(ok.calls).toEqual(["cdp/verify", "cdp/settle"]);
      const down = await payRoute(routeKey, { verify: () => jsonResponse(503, { error: "down" }) });
      expect(down.r.status).toBe(200);
      expect(down.calls).toEqual(["cdp/verify", "payai/verify", "payai/settle"]);
    });
  }

  it("a low-risk route also falls back at settle; a trust route does not (5xx = status unknown, never PayAI)", async () => {
    const settle500 = () => jsonResponse(500, { success: false, errorReason: "unexpected_settle_error" });
    expect((await payRoute("feed_credits:k", { settle: settle500 })).calls).toEqual(["cdp/verify", "cdp/settle", "payai/settle"]);
    const t = await payRoute("verdict:x", { settle: settle500 });
    expect(t.r.status).toBe(409);
    expect((await t.r.json()).error).toBe("settlement_status_unknown");
    expect(t.calls).toEqual(["cdp/verify", "cdp/settle"]);
  });
});

describe("CDP down on a trust route: 503 cdp_unavailable, no fallback", () => {
  for (const [name, verify] of CDP_DOWN) {
    it(`verify ${name} -> 503 with payment_help; zero PayAI calls; not charged`, async () => {
      const { r, calls, logs } = await payRoute("verdict:a-example", { verify });
      expect(r.status).toBe(503);
      expect(Number(r.headers.get("Retry-After"))).toBeGreaterThanOrEqual(5);
      const b = await r.json();
      expect(b).toMatchObject({ error: "facilitator_unavailable", reason: "cdp_unavailable", retryable: true, phase: "verify", settlementAttempted: false, charged: false });
      expect(b.payment_help).toMatchObject({ facilitator: "Coinbase CDP", fallback_facilitator: null });
      expect(b.payment_help.retry).toMatch(/same payment/);
      expect(b.payment_help.other_networks).toContain("xrpl:1");
      expect(calls.every((c) => c.startsWith("cdp/"))).toBe(true);
      expect(calls).toEqual(["cdp/verify"]);
      expect(logs).toContainEqual(expect.objectContaining({ event: "x402_cdp_only_unavailable", phase: "verify" }));
      expect(logs.some((e) => e.event === "x402_facilitator_fallback")).toBe(false);
    });
  }

  it("verify outage: the same signed payment succeeds once CDP is back (nothing was claimed)", async () => {
    let down = true;
    const { r, header, cfg, deps, quote, serve, calls } = await payRoute("receipts:x", { verify: (b) => (down ? jsonResponse(503, {}) : okVerify(b)) });
    expect(r.status).toBe(503);
    down = false;
    const again = await requirePayment(new Request(quote.resourceUrl, { headers: { "PAYMENT-SIGNATURE": header } }), cfg, deps, quote, serve);
    expect(again.status).toBe(200);
    expect(calls).toEqual(["cdp/verify", "cdp/verify", "cdp/settle"]);
  });

  it("settle refused before submission (401/429/facilitator-side, no tx) -> 503 phase settle, fresh quote needed", async () => {
    for (const settle of [() => jsonResponse(401, { errorType: "unauthorized" }), () => jsonResponse(429, {}), () => jsonResponse(400, { success: false, errorReason: "invalid_bazaar_extension" })] as Handler[]) {
      const { r, calls } = await payRoute("batch_check:3", { settle });
      expect(r.status).toBe(503);
      const b = await r.json();
      expect(b).toMatchObject({ reason: "cdp_unavailable", phase: "settle", charged: false });
      expect(b.payment_help.retry).toMatch(/fresh 402/);
      expect(calls).toEqual(["cdp/verify", "cdp/settle"]);
    }
  });

  it("a definite refusal about the payment itself is still a 402 re-quote (not an outage)", async () => {
    const v = await payRoute("verdict:x", { verify: () => jsonResponse(200, { isValid: false, invalidReason: "insufficient_funds" }) });
    expect(v.r.status).toBe(402);
    expect(v.calls).toEqual(["cdp/verify"]);
    const s = await payRoute("verdict:x", { settle: () => jsonResponse(200, { success: false, errorReason: "invalid_exact_evm_payload_signature" }) });
    expect(s.r.status).toBe(402);
    expect(s.calls).toEqual(["cdp/verify", "cdp/settle"]);
  });
});

describe("no CDP configured: trust routes do not offer Base at all", () => {
  it("without CDP keys (or EVM_FACILITATOR=fallback) the trust 402 has no Base option; feed keeps Base via the fallback", async () => {
    for (const extra of [{ CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "" }, { EVM_FACILITATOR: "fallback" }]) {
      const { r, calls, pr } = await payRoute("verdict:x", {}, extra);
      expect(pr.accepts.some((a: any) => a.network.startsWith("eip155:"))).toBe(false);
      expect(pr.accepts.length).toBeGreaterThan(0);
      expect(r.status).toBe(402); // a Base header matches nothing offered
      expect(calls).toEqual([]);
      const feed = await payRoute("feed_credits:k", {}, extra);
      expect(feed.pr.accepts[0].network).toBe("eip155:8453");
      expect(feed.r.status).toBe(200);
      expect(feed.calls).toEqual(["payai/verify", "payai/settle"]);
    }
  });
});

describe("app wiring", () => {
  async function app(cdp: { verify?: Handler; settle?: Handler } = {}, extra: Record<string, unknown> = {}) {
    const h = harness(cdp);
    return { a: createApp((await env(extra)) as any, { fetch: h.fetch, log: () => {}, now: () => NOW }), calls: h.calls, bodies: h.bodies };
  }
  async function pay(a: any, path: string) {
    const pr = await (await a.fetch(new Request("http://lumi.test" + path))).json();
    const header = await signBase(pr.accepts, pr.x402Version, pr.resource, pr.extensions);
    return a.fetch(new Request("http://lumi.test" + path, { headers: { "PAYMENT-SIGNATURE": header } }));
  }

  it("/v1/trust/check/high-value and the vendor report settle via CDP only; CDP down = 503, PayAI untouched", async () => {
    const ok = await app();
    expect((await pay(ok.a, "/v1/trust/check/high-value?url=https://a.example/x&amount=4")).status).toBe(200);
    expect((await pay(ok.a, "/v1/trust/vendors/heurist-mesh/report")).status).toBe(200);
    expect(ok.calls).toEqual(["cdp/verify", "cdp/settle", "cdp/verify", "cdp/settle"]);
    // the CDP Bazaar still gets the server's resource + bazaar declaration (listing unaffected)
    expect(ok.bodies[0].body.paymentPayload.extensions.bazaar).toBeTruthy();

    const down = await app({ verify: () => jsonResponse(502, {}) });
    const r = await pay(down.a, "/v1/trust/check/high-value?url=https://a.example/x&amount=4");
    expect(r.status).toBe(503);
    expect((await r.json()).reason).toBe("cdp_unavailable");
    expect(down.calls).toEqual(["cdp/verify"]);
  });

  it("/v1/wallet/check and the free /v1/trust/check never call any facilitator", async () => {
    const s = await app();
    expect((await s.a.fetch(new Request("http://lumi.test/v1/wallet/check?address=" + EVM_PAY_TO))).status).toBeLessThan(500);
    await s.a.fetch(new Request("http://lumi.test/v1/trust/check?url=https://a.example/x"));
    await s.a.fetch(new Request("http://lumi.test/v1/trust/check"));
    expect(s.calls).toEqual([]);
  });

  it("/health publishes the CDP-only routes and that the fallback is for the other routes only", async () => {
    const s = await app();
    const h = await (await s.a.fetch(new Request("http://lumi.test/health"))).json();
    expect(h.evm.cdp_only_routes.sort()).toEqual([...CDP_ONLY_ROUTES].sort());
    expect(h.evm.cdp_only_on_outage).toMatch(/503/);
  });
});
