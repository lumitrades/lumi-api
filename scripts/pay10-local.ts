/**
 * Dry run for examples/pay-in-10-lines.mjs and examples/pay_in_10_lines.py: NO real payment.
 *
 * Starts the Lumi app on http://127.0.0.1:PORT (default 8787) with in-memory stores and a LOCAL fake Base facilitator:
 * /verify really checks the EIP-3009 signature (viem verifyTypedData against the USDC EIP-712 domain, payTo, amount,
 * validBefore); /settle returns a made-up transaction hash and never touches a chain or an RPC. Use a throwaway key with
 * no funds. Nothing leaves this machine except nothing: every outbound call is answered by the fakes below.
 *
 *   npx tsx scripts/pay10-local.ts &
 *   EVM_PRIVATE_KEY=0x<throwaway> node examples/pay-in-10-lines.mjs "http://127.0.0.1:8787/v1/trust/check/high-value?url=https%3A%2F%2Fapi.s1.com%2Fv1%2Fq&amount=1"
 */
import { createServer } from "node:http";
import { verifyTypedData } from "viem";
import { createApp } from "../src/app";
import { MemoryCatalogStore } from "../src/trust/catalog";
import { MemoryEvidenceStore } from "../src/trust/evidence";
import { MemoryTrialStore } from "../src/trial";
import { MemoryTrustStore } from "../src/trust/store";
import { SEED_OBSERVATIONS } from "../src/trust/seed";
import { DATA, FACILITATOR, PAY_TO, happyFacilitator, makeFetch } from "../test/helpers";

const PORT = Number(process.env.PORT ?? 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SELLER = "https://api.s1.com/v1/q";
const EVM_FAC = "https://fake-evm-facilitator.local";
const FAKE_TX = "0x" + "d".repeat(64);
const ENV = {
  XRPL_NETWORK: "xrpl:1", PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_BASE_URL: DATA, INVOICE_SECRET: "local-dry-run",
  PUBLIC_BASE_URL: BASE, XRPL_RPC_URLS: "https://xrpl.rpc.test/",
  EVM_PAY_TO: "0x5E617bac19912e6d212CB303ae84655E9E203532", EVM_NETWORK: "eip155:8453", EVM_FACILITATOR_URL: EVM_FAC,
  EVM_CDP_ONLY_ROUTES: "none", BASE_RPC_URL: "https://base-rpc.test",
};
export const verifications: any[] = [];

async function fakeVerify(body: any) {
  const req = body.paymentRequirements, p = body.paymentPayload;
  const a = p?.payload?.authorization;
  const problems: string[] = [];
  if (p?.x402Version !== 2) problems.push("x402Version != 2");
  if (!a) problems.push("no authorization");
  else {
    const ok = await verifyTypedData({
      address: a.from,
      domain: { name: req.extra.name, version: req.extra.version, chainId: Number(String(req.network).split(":")[1]), verifyingContract: req.asset },
      types: { TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
      primaryType: "TransferWithAuthorization",
      message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
      signature: p.payload.signature,
    }).catch(() => false);
    if (!ok) problems.push("bad EIP-3009 signature");
    if (String(a.to).toLowerCase() !== String(req.payTo).toLowerCase()) problems.push("to != payTo");
    if (String(a.value) !== String(req.amount)) problems.push("value != amount");
    if (Number(a.validBefore) * 1000 < Date.now()) problems.push("expired");
  }
  const rec = { from: a?.from, to: a?.to, value: a?.value, network: req?.network, asset: req?.asset, ok: problems.length === 0, problems };
  verifications.push(rec);
  console.error("[fake facilitator] verify", JSON.stringify(rec));
  return problems.length ? { isValid: false, invalidReason: problems.join("; "), payer: a?.from } : { isValid: true, payer: a.from };
}

const t = Date.now();
const fallback = makeFetch(happyFacilitator());
const ITEMS = [{
  resource: SELLER, type: "http", description: "d",
  accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "10000", payTo: "0x" + "ab".repeat(20) }],
  extensions: { bazaar: { info: { input: { method: "GET", type: "http" } } } },
  quality: { l30DaysTotalCalls: 50, l30DaysUniquePayers: 6, lastCalledAt: new Date(t - 3_600_000).toISOString() }, lastUpdated: new Date(t).toISOString(),
}];
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const doFetch = (async (input: any, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(EVM_FAC)) {
    const path = url.slice(EVM_FAC.length);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (path === "/verify") return json(await fakeVerify(body));
    if (path === "/settle") {
      const v = await fakeVerify(body);
      return json(v.isValid ? { success: true, transaction: FAKE_TX, network: body.paymentRequirements.network, payer: v.payer } : { success: false, errorReason: v.invalidReason });
    }
    return json({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }] });
  }
  if (url.startsWith("https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources")) return json({ items: ITEMS, pagination: { limit: 30, offset: 0, total: 1 } });
  if (url === "https://xrpl.rpc.test/") return json({ result: { transactions: [] } });
  if (url.startsWith("https://base-rpc.test")) return json({ jsonrpc: "2.0", id: 1, result: "0x" + (50_000n).toString(16).padStart(64, "0") });
  if (url.startsWith("https://api.s1.com/")) {
    const pr = { x402Version: 2, accepts: ITEMS[0].accepts };
    return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") } });
  }
  return fallback(input, init);
}) as typeof fetch;

const ev = new MemoryEvidenceStore();
ev.resources = new Set([SELLER]);
const app = createApp(ENV as any, {
  fetch: doFetch, log: () => {}, catalogStore: new MemoryCatalogStore(), evidenceStore: ev, trialStore: new MemoryTrialStore(),
  trustStore: new MemoryTrustStore(SEED_OBSERVATIONS),
} as any);
await app.scheduled();

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  headers.set("CF-Connecting-IP", "127.0.0.1");
  const r = await app.fetch(new Request(BASE + req.url, { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PORT, "127.0.0.1", () => console.error(`[pay10-local] dry-run Lumi on ${BASE} (fake facilitator, no real payment)`));
