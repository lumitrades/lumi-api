import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { MemoryTrialStore, siweMessage, siwxChallenge, verifySiwx, trialChains, xrplTrialAccount, LSF_DISABLE_MASTER } from "../src/trial";
import { xrplTrialSnippet } from "../src/docs";
import { wrapFetchWithSIWx } from "@x402/extensions/sign-in-with-x";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { generateSeed, deriveKeypair, deriveAddress, sign } from "ripple-keypairs";
import { DATA, FACILITATOR, PAY_TO, NOW, happyFacilitator, makeFetch } from "./helpers";

const BASE_RPC = "https://base-rpc.test";
const XRPL_RPC = "https://xrpl-rpc.test";
const ENV = {
  XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "s3cret", XRPL_RPC_URLS: XRPL_RPC,
  EVM_PAY_TO: "0x5E617bac19912e6d212CB303ae84655E9E203532", EVM_NETWORK: "eip155:84532", EVM_FACILITATOR_URL: "https://evm-fac.test", BASE_RPC_URL: BASE_RPC,
};
const BASE = "http://lumi.test";
const TRIAL = { headers: { "X-Lumi-Trial": "1" } };

type Acct = { Flags?: number; RegularKey?: string } | "missing" | "down";
function key(algorithm: "ecdsa-secp256k1" | "ed25519" = "ecdsa-secp256k1") {
  const kp = deriveKeypair(generateSeed({ algorithm }));
  return { ...kp, address: deriveAddress(kp.publicKey) };
}

function setup(opts: { accounts?: Record<string, Acct>; env?: Record<string, unknown>; store?: MemoryTrialStore } = {}) {
  const fac = happyFacilitator();
  const base = makeFetch(fac);
  const xrplCalls: any[] = [];
  let ip = "203.0.113.7";
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(XRPL_RPC)) {
      const body = JSON.parse(String(init?.body));
      xrplCalls.push(body);
      const account = body.params[0].account;
      const a = opts.accounts?.[account] ?? "missing";
      if (a === "down") return new Response("bad gateway", { status: 502 });
      if (a === "missing") return new Response(JSON.stringify({ result: { error: "actNotFound", status: "error" } }));
      return new Response(JSON.stringify({ result: { account_data: { Account: account, Balance: "25000000", Flags: a.Flags ?? 0, ...(a.RegularKey ? { RegularKey: a.RegularKey } : {}) }, validated: true } }));
    }
    if (url.startsWith(BASE_RPC)) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + (50_000n).toString(16).padStart(64, "0") }));
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
  return { app, appFetch, fac, xrplCalls, trialStore, setIp: (v: string) => (ip = v) };
}

/** What an XRPL client does: fetch the opt-in 402, sign the CAIP-122 message with ripple-keypairs, retry. */
async function xrplTry(
  appFetch: typeof fetch,
  path: string,
  signer: { privateKey: string; publicKey: string },
  address: string,
  tweak: (p: any) => void = () => {},
) {
  const q = await (await appFetch(BASE + path, TRIAL)).json();
  const ext = q.extensions["sign-in-with-x"];
  const chain = ext.supportedChains.find((c: any) => c.type === "xrpl");
  const payload: any = { ...ext.info, address, chainId: chain.chainId, type: "xrpl", publicKey: signer.publicKey };
  payload.signature = sign(Buffer.from(siweMessage(payload), "utf8").toString("hex").toUpperCase(), signer.privateKey);
  tweak(payload);
  return appFetch(BASE + path, { headers: { "SIGN-IN-WITH-X": Buffer.from(JSON.stringify(payload)).toString("base64") } });
}

describe("free trial for XRPL wallets (sign-in-with-x, type xrpl)", () => {
  it("the 402 challenge offers Base and XRPL; the XRPL message is the CAIP-122 layout with XRP Ledger and the chain reference", async () => {
    const { appFetch } = setup();
    const ext = (await (await appFetch(BASE + "/v1/verdict?url=https://a.example/x", TRIAL)).json()).extensions["sign-in-with-x"];
    expect(ext.supportedChains).toEqual([{ chainId: "eip155:84532", type: "eip191" }, { chainId: "xrpl:1", type: "xrpl" }]);
    expect(ext.lumi_trial).toMatchObject({ free_calls_per_wallet: 3, one_trial_per_wallet: true, charged: false, xrpl: { type: "xrpl" } });
    const msg = siweMessage({ ...ext.info, address: "rAddr", chainId: "xrpl:1", type: "xrpl", signature: "" });
    expect(msg.split("\n").slice(0, 2)).toEqual(["lumi.test wants you to sign in with your XRP Ledger account:", "rAddr"]);
    expect(msg).toContain("\nChain ID: 1\n");
    expect(msg).not.toContain("Ethereum");
  });

  it("the documented client snippet builds the exact message the server verifies", async () => {
    const snip = xrplTrialSnippet(BASE, "xrpl:1");
    const ext = await siwxChallenge("k", BASE + "/v1/verdict?url=https://a.example/x", NOW, trialChains(undefined, "xrpl:1"));
    const i: any = ext.info;
    const chain = { chainId: "xrpl:1" };
    const wallet = { classicAddress: "rTest" };
    // The array literal from the snippet, evaluated with the same bindings.
    const arr = snip.slice(snip.indexOf("const message = ") + "const message = ".length, snip.indexOf(';\nconst signature'));
    const built = new Function("i", "chain", "wallet", `return ${arr};`)(i, chain, wallet);
    expect(built).toBe(siweMessage({ ...i, address: "rTest", chainId: "xrpl:1", type: "xrpl", signature: "" }));
  });

  for (const algo of ["ecdsa-secp256k1", "ed25519"] as const) {
    it(`an activated XRPL wallet (${algo} master key) gets 3 free calls, never charged, then the normal 402`, async () => {
      const k = key(algo);
      const { appFetch, fac, xrplCalls, trialStore } = setup({ accounts: { [k.address]: {} } });
      for (let i = 1; i <= 3; i++) {
        const r = await xrplTry(appFetch, "/v1/verdict?url=https://a.example/x", k, k.address);
        expect(r.status).toBe(200);
        expect(r.headers.get("PAYMENT-RESPONSE")).toBeNull();
        const b = await r.json();
        expect(b.payment).toBeUndefined();
        expect(b.access).toEqual({ mode: "trial", charged: false, wallet: k.address, trial_calls_used: i, trial_calls_remaining: 3 - i });
      }
      expect(xrplCalls[0]).toMatchObject({ method: "account_info", params: [{ account: k.address, ledger_index: "validated" }] });
      const r4 = await xrplTry(appFetch, "/v1/verdict?url=https://a.example/x", k, k.address);
      expect(r4.status).toBe(402);
      expect((await r4.json()).trial).toMatchObject({ granted: false, reason: "wallet_trial_used_up" });
      expect(fac.calls).toHaveLength(0);
      expect(trialStore.rows.map((r) => r.wallet)).toEqual([k.address, k.address, k.address]);
    });
  }

  it("cannot be spoofed: own key for someone else's address, tampered message, missing key, wrong chain", async () => {
    const victim = key();
    const attacker = key();
    const { appFetch } = setup({ accounts: { [victim.address]: {}, [attacker.address]: {} } });
    const spoof = await xrplTry(appFetch, "/v1/verdict?url=https://a.example/x", attacker, victim.address);
    expect((await spoof.json()).trial).toMatchObject({ granted: false, reason: "signing_key_does_not_control_address" });
    // victim's public key but attacker's signature
    const swapped = await xrplTry(appFetch, "/v1/verdict?url=https://a.example/x", attacker, victim.address, (p) => (p.publicKey = victim.publicKey));
    expect((await swapped.json()).trial.reason).toBe("invalid_signature");
    const tampered = await xrplTry(appFetch, "/v1/verdict?url=https://a.example/x", attacker, attacker.address, (p) => (p.statement = p.statement + " "));
    expect((await tampered.json()).trial.reason).toBe("challenge_mismatch");
    const noKey = await xrplTry(appFetch, "/v1/verdict?url=https://a.example/x", attacker, attacker.address, (p) => delete p.publicKey);
    expect((await noKey.json()).trial.reason).toBe("public_key_required_for_xrpl");
    const wrongChain = await xrplTry(appFetch, "/v1/verdict?url=https://a.example/x", attacker, attacker.address, (p) => (p.chainId = "xrpl:0"));
    expect((await wrongChain.json()).trial.reason).toMatch(/^unsupported_chain/);
    const otherUrl = await (async () => {
      const q = await (await appFetch(BASE + "/v1/verdict?url=https://a.example/x", TRIAL)).json();
      const p: any = { ...q.extensions["sign-in-with-x"].info, address: attacker.address, chainId: "xrpl:1", type: "xrpl", publicKey: attacker.publicKey };
      p.signature = sign(Buffer.from(siweMessage(p), "utf8").toString("hex").toUpperCase(), attacker.privateKey);
      const h = Buffer.from(JSON.stringify(p)).toString("base64");
      expect((await appFetch(BASE + "/v1/verdict?url=https://a.example/x", { headers: { "SIGN-IN-WITH-X": h } })).status).toBe(200);
      const replay = await (await appFetch(BASE + "/v1/verdict?url=https://a.example/x", { headers: { "SIGN-IN-WITH-X": h } })).json();
      expect(replay.trial.reason).toBe("nonce_used");
      return (await appFetch(BASE + "/v1/trust/check?url=https://a.example/x", { headers: { "SIGN-IN-WITH-X": h } })).json();
    })();
    expect(otherUrl.trial.reason).toBe("challenge_not_for_this_url");
  });

  it("regular keys: the current RegularKey may sign; a disabled master key may not; unactivated accounts are refused", async () => {
    const master = key();
    const regular = key("ed25519");
    const stale = key();
    const unfunded = key();
    const { appFetch } = setup({ accounts: { [master.address]: { Flags: LSF_DISABLE_MASTER, RegularKey: regular.address } } });
    expect((await xrplTry(appFetch, "/v1/verdict?url=https://a.example/x", regular, master.address)).status).toBe(200);
    const disabled = await xrplTry(appFetch, "/v1/verdict?url=https://a.example/x", master, master.address);
    expect((await disabled.json()).trial.reason).toMatch(/^xrpl_master_key_disabled/);
    const notCurrent = await xrplTry(appFetch, "/v1/verdict?url=https://a.example/x", stale, master.address);
    expect((await notCurrent.json()).trial.reason).toBe("signing_key_does_not_control_address");
    const none = await xrplTry(appFetch, "/v1/verdict?url=https://a.example/x", unfunded, unfunded.address);
    expect((await none.json()).trial.reason).toBe("xrpl_account_not_activated");
  });

  it("ledger outage refuses without recording anything", async () => {
    const k = key();
    const { appFetch, trialStore } = setup({ accounts: { [k.address]: "down" } });
    const r = await xrplTry(appFetch, "/v1/verdict?url=https://a.example/x", k, k.address);
    expect(r.status).toBe(402);
    expect((await r.json()).trial.reason).toBe("ledger_check_unavailable");
    expect(trialStore.rows).toHaveLength(0);
    const f = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(await xrplTrialAccount(f, ["https://a", "https://b"], k.address, k.address)).toEqual({ ok: false, reason: "ledger_check_unavailable" });
  });

  it("one trial per wallet on one shared ledger: Base and XRPL wallets share the IP and global caps", async () => {
    const x1 = key();
    const x2 = key();
    const { appFetch, trialStore, setIp } = setup({ accounts: { [x1.address]: {}, [x2.address]: {} } });
    expect((await wrapFetchWithSIWx(appFetch, privateKeyToAccount(generatePrivateKey()))(BASE + "/v1/trust/check?url=https://a.example/x", TRIAL)).status).toBe(200);
    expect((await wrapFetchWithSIWx(appFetch, privateKeyToAccount(generatePrivateKey()))(BASE + "/v1/trust/check?url=https://a.example/x", TRIAL)).status).toBe(200);
    expect((await xrplTry(appFetch, "/v1/trust/check?url=https://a.example/x", x1, x1.address)).status).toBe(200);
    expect((await (await xrplTry(appFetch, "/v1/trust/check?url=https://a.example/x", x2, x2.address)).json()).trial.reason).toBe("ip_daily_cap");
    // the XRPL wallet's lifetime allowance follows the wallet, not the IP or chain
    setIp("198.51.100.9");
    expect((await xrplTry(appFetch, "/v1/verdict?url=https://a.example/x", x1, x1.address)).status).toBe(200);
    expect((await xrplTry(appFetch, "/v1/verdict?url=https://a.example/x", x1, x1.address)).status).toBe(200);
    expect((await (await xrplTry(appFetch, "/v1/verdict?url=https://a.example/x", x1, x1.address)).json()).trial.reason).toBe("wallet_trial_used_up");
    expect(await trialStore.usedByWallet(x1.address)).toBe(3);
  });

  it("Base clients are unaffected (wrapFetchWithSIWx picks eip191) and XRPL works without an EVM config", async () => {
    const { appFetch } = setup();
    const acct = privateKeyToAccount(generatePrivateKey());
    const r = await wrapFetchWithSIWx(appFetch, acct)(BASE + "/v1/verdict?url=https://a.example/x", TRIAL);
    expect((await r.json()).access).toMatchObject({ mode: "trial", wallet: acct.address.toLowerCase() });

    const k = key();
    const xr = setup({ accounts: { [k.address]: {} }, env: { EVM_PAY_TO: "", EVM_NETWORK: "", EVM_FACILITATOR_URL: "" } });
    expect(xr.app.config.evm).toBeFalsy();
    const ext = (await (await xr.appFetch(BASE + "/v1/verdict?url=https://a.example/x", TRIAL)).json()).extensions["sign-in-with-x"];
    expect(ext.supportedChains).toEqual([{ chainId: "xrpl:1", type: "xrpl" }]);
    expect((await (await xrplTry(xr.appFetch, "/v1/verdict?url=https://a.example/x", k, k.address)).json()).access).toMatchObject({ mode: "trial", wallet: k.address });
  });

  it("verifySiwx rejects a Base payload type on an XRPL-only chain list and bad XRPL addresses", async () => {
    const ext = await siwxChallenge("k", BASE + "/v1/verdict?url=https://a.example/x", NOW, trialChains(undefined, "xrpl:0"));
    const k = key();
    const p: any = { ...ext.info, address: "0x" + "1".repeat(40), chainId: "xrpl:0", type: "xrpl", publicKey: k.publicKey, signature: "00" };
    expect(await verifySiwx("k", p, BASE + "/v1/verdict?url=https://a.example/x", NOW, trialChains(undefined, "xrpl:0"))).toMatchObject({ ok: false, reason: "invalid_address" });
    expect(await verifySiwx("k", { ...p, type: "eip191", chainId: "eip155:8453" }, BASE + "/v1/verdict?url=https://a.example/x", NOW, trialChains(undefined, "xrpl:0"))).toMatchObject({ ok: false });
    const good: any = { ...ext.info, address: k.address, chainId: "xrpl:0", type: "xrpl", publicKey: k.publicKey };
    good.signature = sign(Buffer.from(siweMessage(good), "utf8").toString("hex").toUpperCase(), k.privateKey);
    expect(await verifySiwx("k", good, BASE + "/v1/verdict?url=https://a.example/x", NOW, trialChains(undefined, "xrpl:0"))).toMatchObject({ ok: true, wallet: k.address, chain: "xrpl", signingKeyAddress: k.address });
  });
});
