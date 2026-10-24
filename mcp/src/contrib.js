/**
 * Lumi Check tools (branch scanner-kit-v0, unpublished): lumi_scan_seller (free quote + dry-run plan) and
 * lumi_report_receipt (passive: sign a receipt for a purchase you already made, optionally submit it).
 * The kit is loaded lazily: the published package would depend on lumi-scanner-kit; in the repo it is ../../packages/scanner-kit.
 * Never returns or logs wallet secrets or the contributor private key.
 */
import { z } from "zod";

export async function loadKit() {
  try {
    return await import("lumi-scanner-kit");
  } catch {
    return import(new URL("../../packages/scanner-kit/src/index.js", import.meta.url).href);
  }
}

const NETWORKS = ["xrpl:0", "stellar:pubnet", "eip155:8453"];
const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });

/** Wallet secret for the payer: MCP's own XRPL_SEED / EVM_PRIVATE_KEY, else the kit's LUMI_KIT_* variables. */
async function secretFor(kit, settings, network, env) {
  if (network === "xrpl:0" && settings.seed) return settings.seed;
  if (network === "eip155:8453" && settings.evmKey) return settings.evmKey;
  return kit.secretFromEnv(network, env);
}

export function registerContribTools(server, settings, { env = process.env, fetchImpl, kitLoader = loadKit } = {}) {
  server.registerTool(
    "lumi_scan_seller",
    {
      title: "Lumi Check: scan an x402 seller (free, dry-run)",
      description:
        "Free. Fetches an x402 seller's 402 quote without paying and returns latency, HTTP status and the quoted price per chain, plus a dry-run test-buy plan checked " +
        "against the kit's local caps (default 0.01 per buy, 0.05 per day per asset). Nothing is signed or paid from this tool. " +
        "Passive mode is the default way to contribute: report purchases you already made with lumi_report_receipt.",
      inputSchema: {
        url: z.string().url().describe("The x402 resource URL"),
        method: z.enum(["GET", "POST"]).optional().describe("HTTP method (default GET)"),
        body: z.string().max(4000).optional().describe("Optional JSON body for POST endpoints"),
      },
    },
    async ({ url, method, body }) => {
      const kit = await kitLoader();
      const r = await kit.testBuy({ url, method: method ?? "GET", body, networks: NETWORKS, live: false, fetchImpl });
      const { accepts: _a, payment_required: _p, ...quote } = r.quote ?? {};
      return text({ ok: r.ok, dry_run: true, step: r.step, reason: r.reason, plan: r.plan, quote });
    },
  );

  server.registerTool(
    "lumi_report_receipt",
    {
      title: "Lumi Check: report a purchase you already made (passive)",
      description:
        "Passive contribution: builds a counterparty_delivery_receipt for an x402 purchase you already made (tx looked up on-ledger), signed by the paying wallet. " +
        "With submit=true it is sent to Lumi signed with your contributor key (LUMI_CONTRIB_KEY_FILE); Lumi verifies it on-ledger before it counts. " +
        "Earns contributor credits (not cash). No new spend. Self-tests (your own endpoints or wallets) are rejected.",
      inputSchema: {
        endpoint: z.string().url().describe("The x402 resource URL you paid"),
        network: z.enum(NETWORKS).describe("Chain of the payment"),
        tx_hash: z.string().min(16).max(100).describe("Payment transaction hash"),
        http_status: z.number().int().min(0).max(599).describe("HTTP status of the paid response (0 = timeout)"),
        outcome: z.enum(["delivered", "no_data", "empty_result", "error_status", "timeout", "wrong_data", "other", "inconclusive"]),
        latency_ms: z.number().int().min(0).max(600000).optional(),
        submit: z.boolean().optional().describe("Send to Lumi (default false: return the signed receipt only)"),
      },
    },
    async (a) => {
      const kit = await kitLoader();
      const secret = await secretFor(kit, settings, a.network, env);
      if (!secret) return { ...text({ error: `no wallet secret for ${a.network}: set XRPL_SEED / EVM_PRIVATE_KEY or LUMI_KIT_* (see the kit README)` }), isError: true };
      try {
        const signer = await kit.signerFor(a.network, secret);
        const receipt = await kit.reportPurchase({ endpoint: a.endpoint, network: a.network, tx_hash: a.tx_hash, http_status: a.http_status, outcome: a.outcome, latency_ms: a.latency_ms, signer, mode: "passive", fetchImpl });
        if (!a.submit) return text({ submitted: false, receipt, note: "Signed locally. Call again with submit=true to send it to Lumi." });
        const keyFile = env.LUMI_CONTRIB_KEY_FILE;
        if (!keyFile) return { ...text({ error: "LUMI_CONTRIB_KEY_FILE is not set (run lumi-scan keygen, then ask Lumi to issue your key)" }), isError: true };
        const k = kit.loadKey(keyFile);
        const client = kit.createLumiClient({ api: env.LUMI_CONTRIB_API || settings.apiUrl, keyId: k.key_id, privateKey: k.private_key, fetchImpl });
        const res = await client.submit(receipt, "passive");
        return { ...text({ submitted: true, response: res }), isError: res.status >= 400 };
      } catch (e) {
        return { ...text({ error: kit.redact(String(e?.message ?? e)) }), isError: true };
      }
    },
  );
}
