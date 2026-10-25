import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { MemoryTrialStore, usdcBalance, TRIAL_STATEMENT, siweMessage, siwxChallenge, verifySiwx } from "../src/trial";
import { wrapFetchWithSIWx, createSIWxPayload, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";
import { SiweMessage } from "@signinwithethereum/siwe";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch, decodeB64Json } from "./helpers";

const RPC = "https://base-rpc.test";
const ENV = {
  XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret",
  EVM_PAY_TO: "0x5E617bac19912e6d212CB303ae84655E9E203532", EVM_NETWORK: "eip155:84532", EVM_FACILITATOR_URL: "https://evm-fac.test", BASE_RPC_URL: RPC,
};
const BASE = "http://lumi.test";

function setup(opts: { balance?: bigint; env?: Record<string, unknown>; store?: MemoryTrialStore } = {}) {
  const fac = happyFacilitator();
  const base = makeFetch(fac);
  const rpcCalls: any[] = [];
  let ip = "203.0.113.7";
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(RPC)) {
      const body = JSON.parse(String(init?.body));
      rpcCalls.push(body);
      const bal = opts.balance ?? 50_000n;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + bal.toString(16).padStart(64, "0") }));
    }
    return base(input, init);
  }) as typeof fetch;
  const trialStore = opts.store ?? new MemoryTrialStore();
  const app = createApp({ ...ENV, ...(opts.env ?? {}) } as any, { fetch: doFetch, log: () => {}, now: () => NOW, trialStore });
  const appFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const h = new Headers(req.headers);
    h.set("CF-Connecting-IP", ip);
    return app.fetch(new Request(req, { headers: h }));
  }) as typeof fetch;
  return { app, appFetch, fac, rpcCalls, trialStore, setIp: (v: string) => (ip = v) };
}

const TRIAL = { headers: { "X-Lumi-Trial": "1" } };

describe("free trial (x402 sign-in-with-x)", () => {
  it("rebuilds the EIP-4361 message byte-identically to the siwe library", async () => {
    const acct = privateKeyToAccount(generatePrivateKey());
    const ext = await siwxChallenge("k", BASE + "/v1/market?format=md", NOW, "eip155:8453");
    const p = { ...ext.info, address: acct.address, chainId: "eip155:8453", type: "eip191", signature: "0x" };
    const lib = new SiweMessage({ ...ext.info, address: acct.address, chainId: 8453 }).prepareMessage();
    expect(siweMessage(p as any)).toBe(lib);
  });

  it("plain 402s are standard x402 quotes (no SIWX extension, trial hint only); X-Lumi-Trial: 1 adds the challenge; institutional too (since Oct 23 2026)", async () => {
    const { appFetch } = setup();
    const plain = await appFetch(BASE + "/v1/sentiment");
    expect(plain.status).toBe(402);
    const pb = await plain.json();
    expect(decodeB64Json(plain.headers.get("PAYMENT-REQUIRED"))).toEqual(pb);
    expect(pb.accepts.length).toBeGreaterThan(0);
    expect(pb.extensions["sign-in-with-x"]).toBeUndefined();
    expect(Object.keys(pb.extensions)).toEqual(["bazaar", "payment-identifier"]);
    expect(pb.trial).toMatchObject({ available: true, free_calls_per_wallet: 3, opt_in_header: "X-Lumi-Trial: 1" });
    const r = await appFetch(BASE + "/v1/sentiment", TRIAL);
    expect(r.status).toBe(402);
    const body = await r.json();
    expect(decodeB64Json(r.headers.get("PAYMENT-REQUIRED"))).toEqual(body);
    const ext = body.extensions["sign-in-with-x"];
    expect(ext.info).toMatchObject({ domain: "lumi.test", uri: BASE + "/v1/sentiment", version: "1", statement: TRIAL_STATEMENT, resources: [BASE + "/v1/sentiment"] });
    expect(ext.supportedChains).toEqual([{ chainId: "eip155:84532", type: "eip191" }, { chainId: "xrpl:1", type: "xrpl" }]);
    expect(body.extensions.bazaar).toBeTruthy();
    expect(body.accepts).toEqual(expect.arrayContaining([expect.objectContaining({ network: "eip155:84532" })]));
    const inst = await (await appFetch(BASE + "/v1/institutional", TRIAL)).json();
    expect(inst.extensions["sign-in-with-x"].info.resources).toEqual([BASE + "/v1/institutional"]);
  });

  it("official wrapFetchWithSIWx client gets 3 free calls per wallet, never charged, then the normal 402", async () => {
    const { appFetch, fac, rpcCalls } = setup();
    const acct = privateKeyToAccount(generatePrivateKey());
    const f = wrapFetchWithSIWx(appFetch, acct);
    for (let i = 1; i <= 3; i++) {
      const r = await f(BASE + "/v1/sentiment", TRIAL);
      expect(r.status).toBe(200);
      expect(r.headers.get("PAYMENT-RESPONSE")).toBeNull();
      const b = await r.json();
      expect(b.kind).toBe("sentiment");
      expect(b.payment).toBeUndefined();
      expect(b.access).toEqual({ mode: "trial", charged: false, wallet: acct.address.toLowerCase(), trial_calls_used: i, trial_calls_remaining: 3 - i });
    }
    expect(rpcCalls[0].params[0].data.slice(0, 10)).toBe("0x70a08231");
    const r4 = await f(BASE + "/v1/sentiment", TRIAL);
    expect(r4.status).toBe(402);
    expect((await r4.json()).trial).toMatchObject({ granted: false, reason: "wallet_trial_used_up" });
    expect(fac.calls).toHaveLength(0);
  });

  it("caps per IP per day, refuses replayed nonces, other URLs, empty wallets and bad signatures", async () => {
    const { appFetch, setIp } = setup();
    // one IP: 3 trial calls a day across wallets
    for (let i = 0; i < 3; i++) expect((await wrapFetchWithSIWx(appFetch, privateKeyToAccount(generatePrivateKey()))(BASE + "/v1/events", TRIAL)).status).toBe(200);
    const blocked = await wrapFetchWithSIWx(appFetch, privateKeyToAccount(generatePrivateKey()))(BASE + "/v1/events", TRIAL);
    expect((await blocked.json()).trial.reason).toBe("ip_daily_cap");
    setIp("198.51.100.9");

    const acct = privateKeyToAccount(generatePrivateKey());
    const q = await (await appFetch(BASE + "/v1/sentiment", TRIAL)).json();
    const info = { ...q.extensions["sign-in-with-x"].info, chainId: "eip155:84532", type: "eip191" };
    const header = encodeSIWxHeader(await createSIWxPayload(info, acct, BASE + "/v1/sentiment"));
    expect((await appFetch(BASE + "/v1/sentiment", { headers: { "SIGN-IN-WITH-X": header } })).status).toBe(200);
    const replay = await appFetch(BASE + "/v1/sentiment", { headers: { "SIGN-IN-WITH-X": header } });
    expect((await replay.json()).trial.reason).toBe("nonce_used");
    const other = await appFetch(BASE + "/v1/events", { headers: { "SIGN-IN-WITH-X": header } });
    expect((await other.json()).trial.reason).toBe("challenge_not_for_this_url");

    const forged = JSON.parse(Buffer.from(header, "base64").toString());
    forged.address = privateKeyToAccount(generatePrivateKey()).address;
    const bad = await appFetch(BASE + "/v1/sentiment", { headers: { "SIGN-IN-WITH-X": Buffer.from(JSON.stringify(forged)).toString("base64") } });
    expect((await bad.json()).trial.reason).toMatch(/invalid_signature|nonce_used/);
    const nonceMade = { ...info, nonce: "a".repeat(40) };
    const made = encodeSIWxHeader(await createSIWxPayload(nonceMade, acct, BASE + "/v1/sentiment"));
    expect((await (await appFetch(BASE + "/v1/sentiment", { headers: { "SIGN-IN-WITH-X": made } })).json()).trial.reason).toBe("challenge_not_issued_by_lumi");

    const poor = setup({ balance: 9_999n });
    const r = await wrapFetchWithSIWx(poor.appFetch, privateKeyToAccount(generatePrivateKey()))(BASE + "/v1/sentiment", TRIAL);
    expect(r.status).toBe(402);
    expect((await r.json()).trial.reason).toBe("wallet_needs_0.01_usdc_on_base");
  });

  it("expired challenges fail; TRIALS=0 turns the extension off", async () => {
    const ext = await siwxChallenge("k", BASE + "/v1/market", NOW);
    const acct = privateKeyToAccount(generatePrivateKey());
    const p = await createSIWxPayload({ ...ext.info, chainId: "eip155:8453", type: "eip191" } as any, acct, BASE + "/v1/market");
    expect((await verifySiwx("k", p as any, BASE + "/v1/market", NOW + 1000)).ok).toBe(true);
    expect(await verifySiwx("k", p as any, BASE + "/v1/market", NOW + 301_000)).toMatchObject({ ok: false, reason: "challenge_expired" });
    expect(await verifySiwx("other", p as any, BASE + "/v1/market", NOW + 1000)).toMatchObject({ ok: false, reason: "challenge_not_issued_by_lumi" });
    const off = setup({ env: { TRIALS: "0" } });
    const offBody = await (await off.appFetch(BASE + "/v1/sentiment", TRIAL)).json();
    expect(offBody.extensions["sign-in-with-x"]).toBeUndefined();
    expect(offBody.trial).toBeUndefined();
  });
});

describe("usdcBalance falls back across RPCs", () => {
  it("skips a throttled/erroring RPC and returns null only when all fail", async () => {
    const seen: string[] = [];
    const f = (async (url: string) => {
      seen.push(url);
      if (url.includes("bad")) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + (25000).toString(16).padStart(64, "0") }));
    }) as unknown as typeof fetch;
    expect(await usdcBalance(f, ["https://bad.rpc", "https://good.rpc"], "0xtoken", "0x" + "1".repeat(40))).toBe(25000n);
    expect(seen).toEqual(["https://bad.rpc", "https://good.rpc"]);
    expect(await usdcBalance(f, ["https://bad.rpc", "https://bad2.rpc"], "0xtoken", "0x" + "1".repeat(40))).toBeNull();
  });
});
