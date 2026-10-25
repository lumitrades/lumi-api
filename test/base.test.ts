import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { loadConfig, usdcToAtomic, atomicToUsdc, EVM_NETWORKS } from "../src/config";
import { PaymentRequiredV2Schema, PaymentPayloadV2Schema } from "@x402/core/schemas";
import { ExactEvmScheme as EvmServerScheme } from "@x402/evm/exact/server";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DATA, FACILITATOR, PAY_TO, NOW, fakeDurableObjectNamespace, happyFacilitator, jsonResponse, makeFetch, paymentHeaderFor,
  decodeB64Json, type FakeFacilitator,
} from "./helpers";

const EVM_PAY_TO = "0x5E617bac19912e6d212CB303ae84655E9E203532";
const EVM_FAC = "https://evm-facilitator.test";
const SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ENV = {
  XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret",
  EVM_PAY_TO, EVM_NETWORK: "eip155:84532", EVM_FACILITATOR_URL: EVM_FAC,
};
const BASE = "http://lumi.test";
const TX = "0x" + "b".repeat(64);

function evmFacilitator(over: Partial<FakeFacilitator> = {}): FakeFacilitator {
  return {
    calls: [],
    verify: (b) => jsonResponse(200, { isValid: true, payer: b.paymentPayload.payload.authorization.from }),
    settle: (b) => jsonResponse(200, { success: true, transaction: TX, network: b.paymentRequirements.network, payer: b.paymentPayload.payload.authorization.from }),
    ...over,
  };
}

function setup(opts: { evm?: FakeFacilitator; xrpl?: FakeFacilitator; env?: Record<string, unknown>; now?: number } = {}) {
  const evm = opts.evm ?? evmFacilitator();
  const xrpl = opts.xrpl ?? happyFacilitator();
  const base = makeFetch(xrpl);
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(EVM_FAC)) {
      const path = url.slice(EVM_FAC.length);
      const body = JSON.parse(String(init?.body ?? "{}"));
      evm.calls.push({ path, body });
      return path === "/verify" ? evm.verify(body) : evm.settle(body);
    }
    return base(input, init);
  }) as typeof fetch;
  const logs: any[] = [];
  const app = createApp({ ...ENV, ...(opts.env ?? {}) } as any, { fetch: doFetch, log: (e) => logs.push(e), now: () => opts.now ?? NOW });
  const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(BASE + path, { headers }));
  const appFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    app.fetch(input instanceof Request ? input : new Request(String(input), init))) as typeof fetch;
  return { app, get, appFetch, evm, xrpl, logs };
}

function buyer() {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  return { account, client };
}

/** Official @x402 client: build a PAYMENT-SIGNATURE for the Base option of a 402 body. */
async function signBase(body: any, client = buyer().client) {
  const payload = await client.createPaymentPayload(body);
  return { payload, header: Buffer.from(JSON.stringify(payload)).toString("base64") };
}

describe("Base config", () => {
  it("is off without EVM_PAY_TO and defaults to Base mainnet + PayAI when set", () => {
    expect(loadConfig({ XRPL_NETWORK: "xrpl:1", PAY_TO }).evm).toBeUndefined();
    const main = loadConfig({ XRPL_NETWORK: "xrpl:0", INVOICE_SECRET: "x".repeat(32), EVM_PAY_TO });
    expect(main.evm).toMatchObject({
      network: "eip155:8453", asset: BASE_USDC, payTo: EVM_PAY_TO, facilitatorUrl: "https://facilitator.payai.network",
      eip712: { name: "USD Coin", version: "2" }, explorer: "https://basescan.org/tx/",
    });
    expect(main.evm!.prices).toEqual(Object.fromEntries(main.ious[1].prices ? Object.entries(main.ious[1].prices) : []));
    expect(main.evm!.amounts).toMatchObject({ market: "20000", yen: "10000", sentiment: "5000", institutional: "100000" });
    expect(loadConfig({ XRPL_NETWORK: "xrpl:1", PAY_TO, EVM_PAY_TO, ACCEPT_BASE_USDC: "false" }).evm).toBeUndefined();
    expect(loadConfig({ XRPL_NETWORK: "xrpl:1", PAY_TO, EVM_PAY_TO, EVM_NETWORK: "eip155:84532" }).evm!.facilitatorUrl).toBe("https://x402.org/facilitator");
    expect(loadConfig({ XRPL_NETWORK: "xrpl:1", PAY_TO, EVM_PAY_TO, PRICE_MARKET_BASE_USDC: "0.05" }).evm!.amounts.market).toBe("50000");
    expect(() => loadConfig({ XRPL_NETWORK: "xrpl:1", PAY_TO, EVM_PAY_TO: "0x123" })).toThrow(/EVM_PAY_TO/);
    expect(() => loadConfig({ XRPL_NETWORK: "xrpl:1", PAY_TO, EVM_PAY_TO, EVM_NETWORK: "eip155:1" })).toThrow(/EVM_NETWORK/);
  });

  it("matches the official @x402/evm price parser (asset, atomic amount, EIP-712 domain)", async () => {
    const s = new EvmServerScheme();
    for (const n of ["eip155:8453", "eip155:84532"] as const) {
      const p = await s.parsePrice("$0.015", n);
      expect(p).toEqual({ amount: usdcToAtomic("0.015"), asset: EVM_NETWORKS[n].asset, extra: EVM_NETWORKS[n].eip712 });
    }
    expect(atomicToUsdc("15000")).toBe("0.015");
    expect(atomicToUsdc("1000000")).toBe("1");
  });
});

describe("Base USDC in the 402", () => {
  it("adds Base after the unchanged XRPL options, sharing one invoice, valid per the x402 v2 schema", async () => {
    const { get } = setup();
    const plain = setup({ env: { EVM_PAY_TO: "" } });
    for (const [path, atomic] of [["/v1/macro/yen", "10000"], ["/v1/market", "20000"], ["/v1/market", "20000"], ["/v1/macro/yen", "10000"]]) {
      const r = await get(path);
      expect(r.status).toBe(402);
      const body = await r.json();
      expect(decodeB64Json(r.headers.get("PAYMENT-REQUIRED"))).toEqual(body);
      expect(PaymentRequiredV2Schema.safeParse(body).success).toBe(true);
      expect(body.accepts.map((a: any) => a.network)).toEqual(["eip155:84532", "xrpl:1", "xrpl:1", "xrpl:1"]);
      const b = body.accepts[0];
      expect(b).toEqual({
        scheme: "exact", network: "eip155:84532", amount: atomic, asset: SEPOLIA_USDC, payTo: EVM_PAY_TO, maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2", invoiceId: body.accepts[0].extra.invoiceId, symbol: "USDC", decimals: 6 },
      });
      // XRPL options are byte-for-byte the same shape as without Base (only the invoice nonce differs)
      const without = (await (await plain.get(path)).json()).accepts;
      const strip = (a: any) => ({ ...a, extra: { ...a.extra, invoiceId: "-" } });
      expect(body.accepts.slice(1).map(strip)).toEqual(without.map(strip));
    }
  });
});

describe("Base payment with the official @x402/fetch client", () => {
  it("pays the Base option, verifies + settles via the EVM facilitator, serves data with a receipt", async () => {
    const { appFetch, evm, xrpl, logs } = setup();
    const { account, client } = buyer();
    const fetchPaid = wrapFetchWithPayment(appFetch, client);
    const r = await fetchPaid(BASE + "/v1/sentiment");
    expect(r.status).toBe(200);
    expect(xrpl.calls).toHaveLength(0);
    expect(evm.calls.map((c) => c.path)).toEqual(["/verify", "/settle"]);
    const sent = evm.calls[0].body;
    expect(sent.x402Version).toBe(2);
    expect(PaymentPayloadV2Schema.safeParse(sent.paymentPayload).success).toBe(true);
    expect(sent.paymentRequirements).toMatchObject({ network: "eip155:84532", asset: SEPOLIA_USDC, payTo: EVM_PAY_TO, amount: "5000" });
    expect(sent.paymentPayload.accepted).toEqual(sent.paymentRequirements);
    expect(sent.paymentPayload.payload.authorization).toMatchObject({ from: account.address, to: EVM_PAY_TO, value: "5000" });
    const body = await r.json();
    expect(body.kind).toBe("sentiment");
    expect(body.payment).toEqual({
      transaction: TX, network: "eip155:84532", payer: account.address, asset: "USDC", amount: "0.005", amount_atomic: "5000",
      token: SEPOLIA_USDC, explorer: `https://sepolia.basescan.org/tx/${TX}`,
    });
    expect(decodePaymentResponseHeader(r.headers.get("PAYMENT-RESPONSE")!)).toMatchObject({ success: true, transaction: TX, network: "eip155:84532" });
    expect(logs.find((l) => l.event === "x402_settled")).toMatchObject({ asset: "USDC", amount: "5000", network: "eip155:84532", route: "sentiment" });
  });

  it("reports the payer as signed (checksummed) even when the facilitator echoes it lowercased, as PayAI does", async () => {
    const evm = evmFacilitator({
      settle: (b) => jsonResponse(200, { success: true, transaction: TX, network: b.paymentRequirements.network, payer: String(b.paymentPayload.payload.authorization.from).toLowerCase() }),
    });
    const { appFetch } = setup({ evm });
    const { account, client } = buyer();
    const r = await wrapFetchWithPayment(appFetch, client)(BASE + "/v1/market");
    expect(r.status).toBe(200);
    expect((await r.json()).payment.payer).toBe(account.address);
    expect(decodePaymentResponseHeader(r.headers.get("PAYMENT-RESPONSE")!).payer).toBe(account.address);
  });

  it("refuses replay of the same header and reuse of one authorization against a fresh invoice", async () => {
    const { get, evm } = setup();
    const { client } = buyer();
    const first = await (await get("/v1/market")).json();
    const { header, payload } = await signBase(first, client);
    expect((await get("/v1/market", { "PAYMENT-SIGNATURE": header })).status).toBe(200);
    const replay = await get("/v1/market", { "PAYMENT-SIGNATURE": header });
    expect(replay.status).toBe(402);
    expect((await replay.json()).error).toBe("invoice_already_used");
    // same signed authorization, new invoice
    const second = await (await get("/v1/market")).json();
    const reused = { ...payload, accepted: second.accepts[0] };
    const r = await get("/v1/market", { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(reused)).toString("base64") });
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe("authorization_already_used");
    expect(evm.calls.filter((c) => c.path === "/settle")).toHaveLength(1);
  });

  it("blocks concurrent duplicates across isolates via the Durable Object guard", async () => {
    const ns = fakeDurableObjectNamespace();
    const evm = evmFacilitator(); // like a facilitator that would re-confirm an already-settled authorization
    const a = setup({ evm, env: { INVOICE_GUARD: ns } });
    const b = setup({ evm, env: { INVOICE_GUARD: ns } });
    const { header } = await signBase(await (await a.get("/v1/events")).json());
    const rs = await Promise.all([a.get("/v1/events", { "PAYMENT-SIGNATURE": header }), b.get("/v1/events", { "PAYMENT-SIGNATURE": header })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 402]);
    expect(evm.calls.filter((c) => c.path === "/settle")).toHaveLength(1);
  });

  it("checks the authorization locally before calling the facilitator", async () => {
    const { get, evm } = setup();
    const body = await (await get("/v1/market")).json();
    const { payload } = await signBase(body);
    const send = (p: any) => get("/v1/market", { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(p)).toString("base64") });
    const auth = payload.payload.authorization as any;
    const cases: [any, number, string][] = [
      [{ ...payload, accepted: { ...payload.accepted, amount: "1" } }, 402, "payment_requirements_mismatch"],
      [{ ...payload, accepted: { ...payload.accepted, payTo: "0x" + "1".repeat(40) } }, 402, "payment_requirements_mismatch"],
      [{ ...payload, payload: { ...payload.payload, authorization: { ...auth, to: "0x" + "2".repeat(40) } } }, 402, "authorization_payto_mismatch"],
      [{ ...payload, payload: { ...payload.payload, authorization: { ...auth, value: "1" } } }, 402, "authorization_amount_mismatch"],
      [{ ...payload, payload: { ...payload.payload, authorization: { ...auth, validBefore: "1" } } }, 402, "authorization_expired"],
      [{ ...payload, payload: { ...payload.payload, authorization: { ...auth, validAfter: String(Math.floor(Date.now() / 1000) + 3600) } } }, 402, "authorization_not_yet_valid"],
      [{ ...payload, payload: { signature: "0x00" } }, 402, "invalid_evm_payload"],
    ];
    for (const [p, status, error] of cases) {
      const r = await send(p);
      expect(r.status, error).toBe(status);
      expect((await r.json()).error).toBe(error);
    }
    expect(evm.calls).toHaveLength(0);
  });

  it("maps facilitator outcomes like the XRPL path (re-quote, retryable 503, 409 unknown)", async () => {
    const run = async (evm: FakeFacilitator) => {
      const s = setup({ evm });
      const { header } = await signBase(await (await s.get("/v1/market")).json());
      return { r: await s.get("/v1/market", { "PAYMENT-SIGNATURE": header }), evm };
    };
    let x = await run(evmFacilitator({ verify: () => jsonResponse(400, { isValid: false, invalidReason: "insufficient_funds" }) }));
    expect(x.r.status).toBe(402);
    expect((await x.r.json()).error).toBe("verify_failed:insufficient_funds");
    expect(x.evm.calls.map((c) => c.path)).toEqual(["/verify"]);

    x = await run(evmFacilitator({ verify: () => jsonResponse(503, { error: "busy" }, { "Retry-After": "7" }) }));
    expect(x.r.status).toBe(503);
    expect(await x.r.json()).toMatchObject({ retryable: true, settlementAttempted: false, retryAfter: 7 });

    x = await run(evmFacilitator({ settle: () => jsonResponse(400, { success: false, errorReason: "invalid_transaction_state", transaction: "", network: "eip155:84532" }) }));
    expect(x.r.status).toBe(402);
    expect((await x.r.json()).error).toBe("settle_failed:invalid_transaction_state");

    x = await run(evmFacilitator({ settle: () => jsonResponse(200, { success: false, errorReason: "reverted", transaction: TX, network: "eip155:84532" }) }));
    expect(x.r.status).toBe(409);

    x = await run(evmFacilitator({ settle: () => jsonResponse(502, { error: "upstream" }) }));
    expect(x.r.status).toBe(409);
    expect(await x.r.json()).toMatchObject({ error: "settlement_status_unknown", settlementAttempted: true });

    x = await run(evmFacilitator({ settle: () => { throw new Error("socket hang up"); } }));
    expect(x.r.status).toBe(409);
  });

  it("never charges when data is stale (no quote, no facilitator call)", async () => {
    const fresh = setup();
    const { header } = await signBase(await (await fresh.get("/v1/sentiment")).json());
    const stale = setup({ now: NOW + 3 * 86_400_000 });
    const variants: Record<string, string>[] = [{}, { "PAYMENT-SIGNATURE": header }];
    for (const h of variants) {
      const r = await stale.get("/v1/sentiment", h);
      expect(r.status).toBe(503);
      expect(r.headers.get("PAYMENT-REQUIRED")).toBeNull();
      expect((await r.json()).note).toBe("Not charged.");
    }
    expect(stale.evm.calls).toHaveLength(0);
  });

  it("leaves the XRPL flow unchanged when Base is enabled", async () => {
    const { get, evm, xrpl } = setup();
    const body = await (await get("/v1/macro/yen")).json();
    const r = await get("/v1/macro/yen", { "PAYMENT-SIGNATURE": paymentHeaderFor(body.accepts[1]) });
    expect(r.status).toBe(200);
    expect(xrpl.calls.map((c) => c.path)).toEqual(["/verify", "/settle"]);
    expect(xrpl.calls[0].body).toEqual({ paymentPayload: expect.any(Object), paymentRequirements: body.accepts[1] });
    expect(evm.calls).toHaveLength(0);
    expect((await r.json()).payment).toMatchObject({ asset: "XRP", amount: "0.0075", amount_drops: "7500", network: "xrpl:1" });
  });
});

describe("discovery lists both networks", () => {
  it("index, health, /.well-known/x402, openapi, skill.md, llms.txt", async () => {
    const { get } = setup();
    const index = await (await get("/")).json();
    expect(index.version).toBe("1.1.7");
    expect(index.payment.networks.map((n: any) => n.network)).toEqual(["eip155:84532", "xrpl:1"]);
    expect(index.payment.assets[0]).toMatchObject({ symbol: "USDC", network: "eip155:84532", asset: SEPOLIA_USDC, accepts_index: 0 });
    expect(index.payment.assets[1]).toMatchObject({ symbol: "XRP", accepts_index: 1 });
    expect(index.free_endpoints.map((e: any) => e.path)).toContain("/.well-known/agent-card.json");
    expect(index.paid_endpoints[0].prices[0]).toMatchObject({ asset: "USDC", network: "eip155:84532", amount: "0.02" }); // /v1/market
    expect((await (await get("/health")).json()).evm).toMatchObject({ network: "eip155:84532", pay_to: EVM_PAY_TO });
    const wk = await (await get("/.well-known/x402")).json();
    expect(wk.resources[0].accepts[0]).toMatchObject({ network: "eip155:84532", asset: SEPOLIA_USDC, amount: "20000", payTo: EVM_PAY_TO });
    expect(wk.facilitators).toEqual([FACILITATOR, EVM_FAC]);
    expect(wk.agent_card).toBe(`${BASE}/.well-known/agent-card.json`);
    const oa = await (await get("/openapi.json")).json();
    expect(oa.info.version).toBe("1.1.7");
    // Base first: the primary x-payment-info is Base USDC; XRPL rails follow as alternatives.
    expect(oa.paths["/v1/market"].get["x-payment-info"]).toMatchObject({ network: "eip155:84532", amount: "20000" });
    expect(oa.paths["/v1/market"].get["x-payment-info"].alternatives[0].network).toBe("xrpl:1");
    for (const p of ["/skill.md", "/llms.txt"]) {
      const md = await (await get(p)).text();
      expect(md).toContain("eip155:84532");
      expect(md).toContain(EVM_PAY_TO);
      expect(md).toContain("/.well-known/agent-card.json");
      expect(md).toContain("@x402/fetch");
      expect(md).toContain("0.01 USDC on Base Sepolia");
    }
  });
});

describe("v1.0 docs: free trial documented everywhere", () => {
  it("index, well-known, openapi, skill.md, home page", async () => {
    const { get } = setup();
    const index = await (await get("/")).json();
    expect(index.free_trial).toMatchObject({ free_calls_per_wallet: 3, header: "SIGN-IN-WITH-X", extension_key: "sign-in-with-x" });
    expect(index.free_trial.not_eligible ?? []).toEqual([]);
    expect(index.free_trial.eligible_routes).toContain("institutional");
    expect(index.free_trial.eligible_routes).toContain("sentiment");
    const wk = await (await get("/.well-known/x402")).json();
    expect(wk.free_trial.free_calls_per_wallet).toBe(3);
    const oa = await (await get("/openapi.json")).json();
    expect(oa["x-free-trial"].header).toBe("SIGN-IN-WITH-X");
    expect(oa.paths["/v1/sentiment"].get["x-free-trial"].eligible).toBe(true);
    expect(oa.paths["/v1/institutional"].get["x-free-trial"].eligible).toBe(true);
    const skill = await (await get("/skill.md")).text();
    expect(skill).toContain("## Free trial: 3 calls per new wallet");
    expect(skill).toContain("wrapFetchWithSIWx");
    const html = await (await get("/", { accept: "text/html" })).text();
    expect(html).toContain('id="trial"');
    expect(html).not.toMatch(/premium/i);
  });
});
