import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { MAX_PAYMENT_HEADER_BYTES, PAYMENT_HEADERS, oversizePaymentHeader, requirePayment } from "../src/x402";
import { decodeSiwx } from "../src/trial";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { x402Client } from "@x402/fetch";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, jsonResponse, makeFetch, type FakeFacilitator } from "./helpers";

// Dependabot #29: payment headers are size-capped before any base64/JSON/zod decoding.
const EVM_PAY_TO = "0x5E617bac19912e6d212CB303ae84655E9E203532";
const EVM_FAC = "https://evm-facilitator.test";
const ST_PAY_TO = "GCKTH26VNR4H4WLCXS5DX6563XRQQXWP5QKQWFD6CHOGTZJ2N5GKBU2L";
const ST_FAC = "https://stellar-facilitator.test/x402";
const ENV = {
  XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret",
  EVM_PAY_TO, EVM_NETWORK: "eip155:84532", EVM_FACILITATOR_URL: EVM_FAC,
  STELLAR_PAY_TO: ST_PAY_TO, STELLAR_NETWORK: "stellar:pubnet", STELLAR_FACILITATOR_URL: ST_FAC, STELLAR_FACILITATOR_API_KEY: "test-key",
};
const BASE = "http://lumi.test";
const PAYER_G = "GAQGTEKEVKMR4XKX2ZM34ZHX7HLHNLEJ65V5HDQEDE7UC4NVHO5UIPAB";

function fac(network: "evm" | "stellar"): FakeFacilitator {
  return {
    calls: [],
    verify: (b) => jsonResponse(200, { isValid: true, payer: network === "evm" ? b.paymentPayload.payload.authorization.from : PAYER_G }),
    settle: (b) => jsonResponse(200, {
      success: true, transaction: network === "evm" ? "0x" + "b".repeat(64) : "c".repeat(64), network: b.paymentRequirements.network,
      payer: network === "evm" ? b.paymentPayload.payload.authorization.from : PAYER_G,
    }),
  };
}

function setup() {
  const xrpl = happyFacilitator();
  const evm = fac("evm");
  const st = fac("stellar");
  const base = makeFetch(xrpl);
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [prefix, f] of [[EVM_FAC, evm], [ST_FAC, st]] as const) {
      if (url.startsWith(prefix)) {
        const path = url.slice(prefix.length);
        const body = JSON.parse(String(init?.body ?? "{}"));
        f.calls.push({ path, body });
        return path === "/verify" ? f.verify(body) : f.settle(body);
      }
    }
    return base(input, init);
  }) as typeof fetch;
  const logs: any[] = [];
  const app = createApp(ENV as any, { fetch: doFetch, log: (e) => logs.push(e), now: () => NOW });
  const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(BASE + path, { headers }));
  return { get, xrpl, evm, st, logs };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
/** The reported attack shape: a large header holding a 40k-item array. */
const bomb = () => b64({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:84532" }, payload: { authorization: Array.from({ length: 40_000 }, (_, i) => i) } });

describe("payment header size cap", () => {
  it("cap is 16 KB and covers every decoded payment header", () => {
    expect(MAX_PAYMENT_HEADER_BYTES).toBe(16384);
    expect([...PAYMENT_HEADERS]).toEqual(["PAYMENT-SIGNATURE", "X-PAYMENT", "SIGN-IN-WITH-X"]);
  });

  it("allows a header exactly at the cap and rejects one byte over, for each header", async () => {
    for (const name of PAYMENT_HEADERS) {
      expect(oversizePaymentHeader(new Request(BASE, { headers: { [name]: "A".repeat(MAX_PAYMENT_HEADER_BYTES) } }))).toBeNull();
      const r = oversizePaymentHeader(new Request(BASE, { headers: { [name]: "A".repeat(MAX_PAYMENT_HEADER_BYTES + 1) } }))!;
      expect(r.status).toBe(431);
      expect(r.headers.get("Content-Type")).toMatch(/application\/json/);
      expect(await r.json()).toMatchObject({ error: "payment_header_too_large", header: name, max_bytes: MAX_PAYMENT_HEADER_BYTES, note: "Not charged." });
    }
  });

  it("decodeSiwx refuses oversize input without parsing", () => {
    expect(decodeSiwx(b64({ address: "0x1", signature: "0x2", pad: "x".repeat(20_000) }))).toBeNull();
  });

  it("requirePayment returns 431 before decoding, never calls serve or a facilitator", async () => {
    let served = false;
    const r = await requirePayment(
      new Request(BASE + "/v1/slate", { headers: { "PAYMENT-SIGNATURE": bomb() } }),
      {} as any, { replay: { isUsed: async () => false, claim: async () => true } } as any,
      { routeKey: "slate", amountDrops: "1", description: "d", resourceUrl: BASE + "/v1/slate" },
      () => { served = true; return new Response("x"); },
    );
    expect(r.status).toBe(431);
    expect(served).toBe(false);
  });

  it("app: oversize PAYMENT-SIGNATURE, X-PAYMENT or SIGN-IN-WITH-X is a 431 JSON error with no charge and no facilitator call", async () => {
    const { get, xrpl, evm, st, logs } = setup();
    const h = bomb();
    expect(h.length).toBeGreaterThan(100_000);
    for (const name of PAYMENT_HEADERS) {
      for (const path of ["/v1/slate", "/v1/trust/check?url=https://seller.test/x", "/mcp", "/v1/sentiment"]) {
        const r = await get(path, { [name]: h, "X-Lumi-Trial": "1" });
        expect(r.status).toBe(431);
        expect(await r.json()).toMatchObject({ error: "payment_header_too_large", header: name, note: "Not charged." });
      }
    }
    expect([...xrpl.calls, ...evm.calls, ...st.calls]).toHaveLength(0);
    expect(logs.filter((l) => /settled|sale/.test(String(l.event)))).toHaveLength(0);
  });

  it("app: a normal unpaid request still gets the 402", async () => {
    const { get } = setup();
    const r = await get("/v1/slate");
    expect(r.status).toBe(402);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
  });

  it("normal payments still pass on XRPL, Base and Stellar (realistic header sizes)", async () => {
    const { get, xrpl, evm, st } = setup();
    const quote = async () => (await get("/v1/sentiment")).json();
    const sizes: Record<string, number> = {};

    // XRPL: a signed Payment blob with memos is ~1 KB of hex.
    const q1 = await quote();
    const xr = q1.accepts.find((a: any) => a.network === "xrpl:1" && a.asset === "XRP");
    const xh = b64({ x402Version: 2, accepted: xr, payload: { signedTxBlob: "12000022" + "A".repeat(1000), invoiceId: xr.extra.invoiceId } });
    sizes.xrpl = xh.length;
    expect((await get("/v1/sentiment", { "PAYMENT-SIGNATURE": xh })).status).toBe(200);
    expect(xrpl.calls.map((c) => c.path)).toEqual(["/verify", "/settle"]);

    // Base: the official @x402 client, sent as X-PAYMENT (the alias header).
    const q2 = await quote();
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
    const evmOnly = { ...q2, accepts: q2.accepts.filter((a: any) => a.network.startsWith("eip155:")) };
    const bh = b64(await client.createPaymentPayload(evmOnly));
    sizes.base = bh.length;
    expect((await get("/v1/sentiment", { "X-PAYMENT": bh })).status).toBe(200);
    expect(evm.calls.map((c) => c.path)).toEqual(["/verify", "/settle"]);

    // Stellar: a Soroban transaction XDR with auth entries and footprint, ~3 KB base64.
    const q3 = await quote();
    const sa = q3.accepts.find((a: any) => a.network === "stellar:pubnet");
    const sh = b64({ x402Version: 2, accepted: sa, payload: { transaction: "AAAAAgAAAAB" + "A".repeat(3000) } });
    sizes.stellar = sh.length;
    expect((await get("/v1/sentiment", { "PAYMENT-SIGNATURE": sh })).status).toBe(200);
    expect(st.calls.map((c) => c.path)).toEqual(["/verify", "/settle"]);

    for (const n of Object.values(sizes)) expect(n).toBeLessThan(MAX_PAYMENT_HEADER_BYTES / 2);
  });
});
