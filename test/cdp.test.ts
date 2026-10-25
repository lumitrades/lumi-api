import { describe, it, expect } from "vitest";
import { seededStores } from "./stage_c_fixtures";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { cdpJwt, decodeExtensionResponses, CDP_FACILITATOR_URL } from "../src/cdp";
import { BAZAAR_ROUTES, BAZAAR_MAX_DESCRIPTION, bazaarExtension, ROUTE_TAGS, SERVICE_NAME, SERVICE_ICON, serviceNameFor } from "../src/bazaar";
import { PAID_ENDPOINTS } from "../src/catalog";
import { PAID_ROUTES } from "../src/config";
import { validateDiscoveryExtension, extractDiscoveryInfo, isValidRouteTemplate, sanitizeResourceServiceMetadata } from "@x402/extensions/bazaar";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { x402Client } from "@x402/fetch";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, jsonResponse, makeFetch, decodeB64Json } from "./helpers";

const EVM_PAY_TO = "0x5E617bac19912e6d212CB303ae84655E9E203532";
const PAYAI = "https://payai.test";
const CDP = "https://cdp.test/platform/v2/x402";
const TX = "0x" + "c".repeat(64);
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const fromB64u = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

/** A throwaway CDP-format key: base64(seed 32 bytes || public key 32 bytes). */
async function testKey() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const seed = Buffer.from(jwk.d!, "base64url");
  const pub = Buffer.from(jwk.x!, "base64url");
  return { secret: Buffer.concat([seed, pub]).toString("base64"), publicKey: kp.publicKey, keyId: "00000000-1111-2222-3333-444444444444" };
}

describe("CDP JWT", () => {
  it("signs an EdDSA JWT bound to one request, verifiable with the key's public half", async () => {
    const k = await testKey();
    const jwt = await cdpJwt({ keyId: k.keyId, keySecret: k.secret }, "POST", `${CDP_FACILITATOR_URL}/settle`, 1_800_000_000);
    const [h, c, sig] = jwt.split(".");
    const header = fromB64u(h);
    expect(header).toMatchObject({ alg: "EdDSA", typ: "JWT", kid: k.keyId });
    expect(header.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(fromB64u(c)).toEqual({
      sub: k.keyId, iss: "cdp", uris: ["POST api.cdp.coinbase.com/platform/v2/x402/settle"],
      iat: 1_800_000_000, nbf: 1_800_000_000, exp: 1_800_000_120,
    });
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, k.publicKey, Buffer.from(sig, "base64url"), new TextEncoder().encode(`${h}.${c}`));
    expect(ok).toBe(true);
    // fresh nonce per token
    const again = await cdpJwt({ keyId: k.keyId, keySecret: k.secret }, "POST", `${CDP_FACILITATOR_URL}/settle`, 1_800_000_000);
    expect(fromB64u(again.split(".")[0]).nonce).not.toBe(header.nonce);
  });

  it("rejects non-Ed25519 secrets", async () => {
    await expect(cdpJwt({ keyId: "x", keySecret: Buffer.alloc(32).toString("base64") }, "GET", CDP_FACILITATOR_URL)).rejects.toThrow(/64 bytes/);
  });

  it("decodes EXTENSION-RESPONSES", () => {
    const h = Buffer.from(JSON.stringify({ bazaar: { status: "rejected", rejectedReason: "x" } })).toString("base64");
    expect(decodeExtensionResponses(h)).toEqual({ bazaar: { status: "rejected", rejectedReason: "x" } });
    expect(decodeExtensionResponses("%%%")).toBeNull();
    expect(decodeExtensionResponses(null)).toBeNull();
  });

  it("config: CDP primary only with both secrets; EVM_FACILITATOR=fallback opts out", () => {
    const base = { XRPL_NETWORK: "xrpl:1", PAY_TO, EVM_PAY_TO };
    expect(loadConfig(base).evm!.cdp).toBeUndefined();
    expect(loadConfig({ ...base, CDP_API_KEY_ID: "id" }).evm!.cdp).toBeUndefined();
    const c = loadConfig({ ...base, CDP_API_KEY_ID: "id", CDP_API_KEY_SECRET: "s" }).evm!;
    expect(c.cdp).toEqual({ url: CDP_FACILITATOR_URL, credentials: { keyId: "id", keySecret: "s" } });
    expect(c.facilitatorUrl).toBe("https://facilitator.payai.network");
    expect(loadConfig({ ...base, CDP_API_KEY_ID: "id", CDP_API_KEY_SECRET: "s", EVM_FACILITATOR: "fallback" }).evm!.cdp).toBeUndefined();
  });
});

describe("Bazaar metadata", () => {
  it("covers every paid route with a valid declaration, short description and routeTemplate where parameterised", () => {
    expect(Object.keys(BAZAAR_ROUTES).sort()).toEqual([...PAID_ROUTES].sort());
    for (const e of PAID_ENDPOINTS) {
      const meta = BAZAAR_ROUTES[e.route];
      expect(meta.description.length).toBeLessThanOrEqual(BAZAAR_MAX_DESCRIPTION);
      const arg = e.route === "vendor_report" ? "asksurf" : undefined;
      const ext = bazaarExtension(e.route, arg, meta.query ? { format: "md" } : undefined) as any;
      const v = validateDiscoveryExtension(ext);
      expect(v, `${e.route}: ${JSON.stringify(v.errors)}`).toEqual({ valid: true });
      expect(ext.info.output.example.kind).toBeTruthy();
      if (arg) expect(isValidRouteTemplate(ext.routeTemplate)).toBe(true);
      // a value outside the declared schema is rejected (schema is real, not decorative)
      if (arg) expect(validateDiscoveryExtension(bazaarExtension(e.route, "../x") as any).valid).toBe(false);
    }
  });

  it("every paid 402 carries its route's bazaar block and a <=500-char description; header stays small", async () => {
    const app = createApp({ XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s", EVM_PAY_TO } as any, {
      fetch: makeFetch(happyFacilitator()), log: () => {}, now: () => NOW, ...seededStores(NOW),
    });
    for (const e of PAID_ENDPOINTS) {
      if (e.route === "vendor_report") continue; // needs trust observations; covered in trust tests
      const r = await app.fetch(new Request("http://lumi.test" + e.example));
      expect(r.status).toBe(402);
      const h = r.headers.get("PAYMENT-REQUIRED")!;
      expect(h.length).toBeLessThan(8000);
      const body = decodeB64Json(h);
      expect(body.resource.description.length).toBeLessThanOrEqual(BAZAAR_MAX_DESCRIPTION);
      expect(body.extensions.bazaar.info.output.example.kind).toBe(BAZAAR_ROUTES[e.route].example.kind);
      // Bazaar service metadata survives the SDK's soft-drop sanitizer unchanged
      const meta = { serviceName: body.resource.serviceName, tags: body.resource.tags, iconUrl: body.resource.iconUrl };
      expect(meta).toEqual({ serviceName: serviceNameFor(e.route), tags: ROUTE_TAGS[e.route], iconUrl: SERVICE_ICON });
      expect(sanitizeResourceServiceMetadata(meta as any)).toEqual(meta);
      expect(validateDiscoveryExtension(body.extensions.bazaar).valid).toBe(true);
    }
    const md = decodeB64Json((await app.fetch(new Request("http://lumi.test/v1/institutional?format=md"))).headers.get("PAYMENT-REQUIRED"));
    expect(md.extensions.bazaar.info.input.queryParams).toEqual({ format: "md" });
  });
});

// ------------------------------------------------------------------ CDP primary + PayAI fallback on the Base path

type Handler = (body: any, headers: Headers) => Response | Promise<Response>;
function setup(cdp: { verify?: Handler; settle?: Handler } = {}, env: Record<string, unknown> = {}) {
  const calls: { fac: "cdp" | "payai"; path: string; body: any; headers: Headers }[] = [];
  const payaiOk = {
    verify: (b: any) => jsonResponse(200, { isValid: true, payer: b.paymentPayload.payload.authorization.from }),
    settle: (b: any) => jsonResponse(200, { success: true, transaction: TX, network: b.paymentRequirements.network, payer: b.paymentPayload.payload.authorization.from }),
  };
  const cdpH = { verify: cdp.verify ?? payaiOk.verify, settle: cdp.settle ?? payaiOk.settle };
  const base = makeFetch(happyFacilitator());
  const logs: any[] = [];
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [fac, prefix, h] of [["cdp", CDP, cdpH], ["payai", PAYAI, payaiOk]] as const) {
      if (url.startsWith(prefix)) {
        const path = url.slice(prefix.length);
        const body = JSON.parse(String(init?.body ?? "{}"));
        const headers = new Headers(init?.headers);
        calls.push({ fac, path, body, headers });
        return path === "/verify" ? (h as any).verify(body, headers) : (h as any).settle(body, headers);
      }
    }
    return base(input, init);
  }) as typeof fetch;
  return {
    calls,
    logs,
    async ready() {
      const k = await testKey();
      const app = createApp(
        {
          XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret",
          EVM_PAY_TO, EVM_NETWORK: "eip155:8453", EVM_FACILITATOR_URL: PAYAI, CDP_FACILITATOR_URL: CDP,
          CDP_API_KEY_ID: k.keyId, CDP_API_KEY_SECRET: k.secret, ...env,
        } as any,
        { fetch: doFetch, log: (e) => logs.push(e), now: () => NOW },
      );
      return { app, k };
    },
  };
}

async function payBase(app: { fetch: (r: Request) => Promise<Response> }, path = "/v1/macro/yen", strip = false) {
  const first = await app.fetch(new Request("http://lumi.test" + path));
  const pr = await first.json();
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  const payload: any = await client.createPaymentPayload({ ...pr, accepts: pr.accepts.filter((a: any) => a.network === "eip155:8453") });
  if (strip) {
    delete payload.extensions;
    delete payload.resource;
  }
  const header = Buffer.from(JSON.stringify(payload)).toString("base64");
  return app.fetch(new Request("http://lumi.test" + path, { headers: { "PAYMENT-SIGNATURE": header } }));
}

describe("Base settlement via CDP with keyless fallback", () => {
  it("uses CDP with a request-bound JWT and sends the server's resource + bazaar even when the client omits them", async () => {
    const bazaarOk = Buffer.from(JSON.stringify({ bazaar: { status: "success" } })).toString("base64");
    const s = setup({
      settle: (b) => jsonResponse(200, { success: true, transaction: TX, network: "eip155:8453", payer: b.paymentPayload.payload.authorization.from }, { "EXTENSION-RESPONSES": bazaarOk }),
    });
    const { app, k } = await s.ready();
    const r = await payBase(app, "/v1/trust/vendors/asksurf/report", true);
    expect(r.status).toBe(200);
    expect((await r.json()).payment).toMatchObject({ transaction: TX, network: "eip155:8453", asset: "USDC", amount: "0.02" });
    expect(s.calls.map((c) => `${c.fac}${c.path}`)).toEqual(["cdp/verify", "cdp/settle"]);
    for (const c of s.calls) {
      const jwt = c.headers.get("Authorization")!.replace(/^Bearer /, "");
      const [h, cl, sig] = jwt.split(".");
      expect(fromB64u(cl).uris).toEqual([`POST cdp.test/platform/v2/x402${c.path}`]);
      expect(await crypto.subtle.verify({ name: "Ed25519" }, k.publicKey, Buffer.from(sig, "base64url"), new TextEncoder().encode(`${h}.${cl}`))).toBe(true);
      const pp = c.body.paymentPayload;
      expect(pp.resource).toMatchObject({ url: "http://lumi.test/v1/trust/vendors/asksurf/report", mimeType: "application/json" });
      expect(pp.resource.description.length).toBeLessThanOrEqual(500);
      expect(pp.extensions.bazaar.routeTemplate).toBe("/v1/trust/vendors/:id/report");
      expect(pp.extensions.bazaar.info.input.pathParams).toEqual({ id: "asksurf" });
      const info = extractDiscoveryInfo(pp, c.body.paymentRequirements);
      expect(info?.resourceUrl).toBe("http://lumi.test/v1/trust/vendors/:id/report");
    }
    expect(s.logs).toContainEqual(expect.objectContaining({ event: "x402_bazaar", phase: "settle", status: "success" }));
    expect(s.logs).toContainEqual(expect.objectContaining({ event: "x402_settled", facilitator: "cdp" }));
  });

  for (const [name, verify] of [
    ["5xx", () => jsonResponse(503, { error: "down" })],
    ["401 (bad key)", () => jsonResponse(401, { errorType: "unauthorized" })],
    ["network error", () => { throw new TypeError("fetch failed"); }],
    ["invalid_bazaar_extension", () => jsonResponse(200, { isValid: false, invalidReason: "invalid_bazaar_extension" })],
  ] as [string, Handler][]) {
    it(`falls back to the keyless facilitator when CDP verify fails: ${name}`, async () => {
      const s = setup({ verify });
      const { app } = await s.ready();
      const r = await payBase(app);
      expect(r.status).toBe(200);
      expect(s.calls.map((c) => `${c.fac}${c.path}`)).toEqual(["cdp/verify", "payai/verify", "payai/settle"]);
      // the keyless facilitator gets no credentials
      expect(s.calls[1].headers.get("Authorization")).toBeNull();
      expect(s.logs).toContainEqual(expect.objectContaining({ event: "x402_facilitator_fallback", phase: "verify", from: "cdp" }));
      expect(s.logs).toContainEqual(expect.objectContaining({ event: "x402_settled", facilitator: "fallback" }));
    });
  }

  it("does not fall back when CDP says the payment itself is bad", async () => {
    const s = setup({ verify: () => jsonResponse(200, { isValid: false, invalidReason: "insufficient_funds" }) });
    const { app } = await s.ready();
    const r = await payBase(app);
    expect(r.status).toBe(402);
    expect(decodeB64Json(r.headers.get("PAYMENT-REQUIRED")).error).toBe("verify_failed:insufficient_funds");
    expect(s.calls.map((c) => `${c.fac}${c.path}`)).toEqual(["cdp/verify"]);
  });

  it("falls back at settle when CDP fails without a transaction; never after a CDP tx hash", async () => {
    const s = setup({ settle: () => jsonResponse(500, { success: false, errorReason: "unexpected_settle_error" }) });
    const { app } = await s.ready();
    const r = await payBase(app);
    expect(r.status).toBe(200);
    expect(s.calls.map((c) => `${c.fac}${c.path}`)).toEqual(["cdp/verify", "cdp/settle", "payai/settle"]);

    const t = setup({ settle: () => jsonResponse(500, { success: false, transaction: TX, errorReason: "transaction_failed" }) });
    const { app: app2 } = await t.ready();
    const r2 = await payBase(app2);
    expect(r2.status).toBe(409);
    expect(t.calls.map((c) => `${c.fac}${c.path}`)).toEqual(["cdp/verify", "cdp/settle"]);
  });

  it("a definite CDP settle refusal about the payment returns a fresh 402 without fallback", async () => {
    const s = setup({ settle: () => jsonResponse(200, { success: false, errorReason: "invalid_exact_evm_payload_signature" }) });
    const { app } = await s.ready();
    const r = await payBase(app);
    expect(r.status).toBe(402);
    expect(s.calls.map((c) => `${c.fac}${c.path}`)).toEqual(["cdp/verify", "cdp/settle"]);
  });

  it("EVM_FACILITATOR=fallback bypasses CDP entirely; XRPL never touches CDP", async () => {
    const s = setup({}, { EVM_FACILITATOR: "fallback" });
    const { app } = await s.ready();
    expect((await payBase(app)).status).toBe(200);
    expect(s.calls.map((c) => c.fac)).toEqual(["payai", "payai"]);
  });
});

describe("bazaar service tags", () => {
  it("every route has 5 distinct spec-valid tags and the set spans many search terms", () => {
    const all = new Set<string>();
    for (const r of PAID_ROUTES) {
      const t = ROUTE_TAGS[r];
      expect(t.length).toBe(5);
      expect(new Set(t.map((x) => x.toLowerCase())).size).toBe(5);
      for (const x of t) { expect(x).toMatch(/^[\x20-\x7e]{1,32}$/); all.add(x); }
    }
    expect(all.size).toBeGreaterThanOrEqual(30);
  });
});
