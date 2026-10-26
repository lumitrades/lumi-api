import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSettings, makeSelector, SpendError, MAINNET_PAY_TO } from "../src/lumi.js";

const accepts = (payTo = MAINNET_PAY_TO, drops = "20000") => [
  { scheme: "exact", network: "xrpl:0", asset: "XRP", amount: drops, payTo, extra: { invoiceId: "i" } },
  { scheme: "exact", network: "xrpl:0", asset: "524C555344000000000000000000000000000000", amount: "0.03", payTo, extra: { symbol: "RLUSD", issuer: "r" } },
  { scheme: "exact", network: "xrpl:0", asset: "5553444300000000000000000000000000000000", amount: "0.03", payTo, extra: { symbol: "USDC", issuer: "r" } },
];

test("defaults: mainnet, official API, pins Lumi's pay-to address", () => {
  const s = loadSettings({});
  assert.equal(s.network, "xrpl:0");
  assert.equal(s.expectedPayTo, MAINNET_PAY_TO);
  assert.equal(s.asset, "XRP");
});

test("picks the configured asset under the cap", () => {
  const ledger = { spent: 0, pending: 0 };
  assert.equal(makeSelector(loadSettings({}), ledger)(accepts()).asset, "XRP");
  assert.equal(ledger.pending, 0.02);
  assert.equal(makeSelector(loadSettings({ LUMI_PAY_ASSET: "RLUSD" }), ledger)(accepts()).extra.symbol, "RLUSD");
  assert.equal(makeSelector(loadSettings({ LUMI_PAY_ASSET: "usdc" }), ledger)(accepts()).extra.symbol, "USDC");
});

test("refuses: over per-call cap, wrong payee, over session budget, wrong network", () => {
  const ledger = { spent: 0, pending: 0 };
  assert.throws(() => makeSelector(loadSettings({ LUMI_MAX_XRP_PER_CALL: "0.01" }), ledger)(accepts()), SpendError);
  assert.throws(() => makeSelector(loadSettings({}), ledger)(accepts("rEvilEvilEvilEvilEvilEvilEvilEvil")), /refusing to pay/);
  assert.throws(() => makeSelector(loadSettings({ LUMI_SESSION_BUDGET: "0.03" }), { spent: 0.02, pending: 0 })(accepts()), /budget/);
  assert.throws(() => makeSelector(loadSettings({ XRPL_NETWORK: "xrpl:1", LUMI_API_URL: "http://x" }), ledger)(accepts()), /no XRP option/);
});

test("rejects bad settings", () => {
  assert.throws(() => loadSettings({ LUMI_PAY_ASSET: "BTC" }));
  assert.throws(() => loadSettings({ XRPL_NETWORK: "eip155:1" }));
  assert.throws(() => loadSettings({ LUMI_MAX_XRP_PER_CALL: "-1" }));
});

const KEY = "0x" + "11".repeat(32);
const baseOpt = (payTo = "0x5E617bac19912e6d212CB303ae84655E9E203532", amount = "250000") => ({
  scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount, payTo,
  maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2", symbol: "USDC", decimals: 6 },
});

test("default caps allow the $0.10 Institutional Brief on every rail", () => {
  assert.equal(makeSelector(loadSettings({}), { spent: 0 })(accepts(MAINNET_PAY_TO, "190000")).asset, "XRP");
  assert.equal(makeSelector(loadSettings({ LUMI_PAY_ASSET: "RLUSD" }), { spent: 0 })([{ ...accepts()[1], amount: "0.25" }]).extra.symbol, "RLUSD");
  assert.equal(makeSelector(loadSettings({ EVM_PRIVATE_KEY: KEY }), { spent: 0 })([...accepts(), baseOpt()]).network, "eip155:8453");
});

test("EVM key alone selects USDC on Base and pins Lumi's Base pay-to", () => {
  const s = loadSettings({ EVM_PRIVATE_KEY: KEY });
  assert.equal(s.asset, "BASE_USDC");
  assert.equal(s.rail, "base");
  assert.equal(s.expectedPayTo, "0x5E617bac19912e6d212CB303ae84655E9E203532");
  assert.throws(() => makeSelector(s, { spent: 0 })([baseOpt("0x000000000000000000000000000000000000dEaD")]), /refusing to pay/);
  assert.equal(loadSettings({ EVM_PRIVATE_KEY: KEY, XRPL_SEED: "sEdX" }).asset, "XRP");
  assert.equal(loadSettings({ EVM_PRIVATE_KEY: KEY, XRPL_SEED: "sEdX", LUMI_PAY_ASSET: "base" }).asset, "BASE_USDC");
  assert.throws(() => loadSettings({ EVM_PRIVATE_KEY: "nope" }), /EVM_PRIVATE_KEY/);
});

test("cap refusal names the env var to change", () => {
  assert.throws(() => makeSelector(loadSettings({ EVM_PRIVATE_KEY: KEY, LUMI_MAX_USD_PER_CALL: "0.05" }), { spent: 0 })([baseOpt()]),
    /above the per-call cap 0\.05\. To allow it, set LUMI_MAX_USD_PER_CALL=0\.25/);
  assert.throws(() => makeSelector(loadSettings({ LUMI_MAX_XRP_PER_CALL: "0.01" }), { spent: 0 })(accepts()), /LUMI_MAX_XRP_PER_CALL=0\.02/);
  assert.throws(() => makeSelector(loadSettings({ LUMI_SESSION_BUDGET: "0.01" }), { spent: 0 })(accepts()), /LUMI_SESSION_BUDGET/);
});

test("Base rail pays end to end with @x402/fetch (mocked server)", async () => {
  const { createClient } = await import("../src/lumi.js");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  const opt = baseOpt("0x5E617bac19912e6d212CB303ae84655E9E203532", "10000");
  const pr = { x402Version: 2, resource: { url: "https://api.lumitrades.io/v1/funding", description: "d", mimeType: "application/json" }, accepts: [...accepts(), opt] };
  let sig = null;
  const fetchImpl = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    sig = req.headers.get("PAYMENT-SIGNATURE");
    if (!sig) return new Response(JSON.stringify(pr), { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": enc(pr) } });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "PAYMENT-RESPONSE": enc({ success: true, transaction: "0xabc", network: "eip155:8453", payer: "0x1" }) } });
  };
  const c = createClient(loadSettings({ EVM_PRIVATE_KEY: KEY }), { fetch: fetchImpl });
  const r = await c.paid("/v1/funding");
  assert.equal(r.paid, true);
  assert.equal(r.receipt.transaction, "0xabc");
  const payload = JSON.parse(Buffer.from(sig, "base64").toString());
  assert.equal(payload.accepted.network, "eip155:8453");
  assert.equal(payload.payload.authorization.value, "10000");
  assert.equal(c.ledger.spent, 0.01);
  assert.match(await c.walletAddress(), /^0x[0-9a-fA-F]{40}$/);

  const capped = createClient(loadSettings({ EVM_PRIVATE_KEY: KEY, LUMI_MAX_USD_PER_CALL: "0.005" }), { fetch: fetchImpl });
  const r2 = await capped.paid("/v1/funding");
  assert.equal(r2.paid, false);
  assert.match(r2.error, /LUMI_MAX_USD_PER_CALL/);
});
