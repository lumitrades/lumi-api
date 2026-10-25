/**
 * Lumi Check tools (unpublished): lumi_check (free signed pre-pay check), lumi_scan_seller
 * (free quote + dry-run plan) and lumi_report_receipt (passive: sign a receipt for a purchase you already made; submitting
 * is tier 2 and needs receipt sharing turned on: LUMI_SHARE_RECEIPTS=1 or `lumi-scan sharing on`).
 * The kit is loaded lazily: the published package depends on lumi-check (npm); in the repo it is ../../packages/scanner-kit.
 * Never returns or logs wallet secrets or the contributor private key.
 */
import { z } from "zod";
import { join } from "node:path";
import { pinnedPublicKeys } from "./lumi_keys.js";

export async function loadKit() {
  try {
    return await import("lumi-check");
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

/** Kit config location: LUMI_KIT_CONFIG, else <LUMI_KIT_HOME>/config.json, else ~/.lumi-scanner-kit/config.json. */
const configPathOf = (env) => env.LUMI_KIT_CONFIG || (env.LUMI_KIT_HOME ? join(env.LUMI_KIT_HOME, "config.json") : undefined);

/**
 * Accept a paid trust/check `lumi_receipt` only when it is signed by a pinned Lumi key. Verified: adds
 * lumi_receipt_verified { ok, key_id }. Anything else: the receipt is removed and lumi_receipt_rejected { error, detail }
 * says why (lumi_untrusted_key, lumi_retired_key, lumi_bad_signature, ...). The rest of the paid body is kept.
 */
export async function checkLumiReceipt(body, { kitLoader = loadKit, publicKeys = pinnedPublicKeys(), now = Date.now() } = {}) {
  if (!body || typeof body !== "object" || !body.lumi_receipt) return body;
  const { lumi_receipt, ...rest } = body;
  let v;
  try { v = (await kitLoader()).verifyLumiSigned(lumi_receipt, { publicKeys, now }); } catch { v = { ok: false, error: "lumi_kit_unavailable", detail: "lumi-check is not installed, so the receipt could not be verified." }; }
  if (v.ok) return { ...body, lumi_receipt_verified: { ok: true, key_id: v.key_id } };
  return { ...rest, lumi_receipt: null, lumi_receipt_rejected: { error: v.error ?? "lumi_bad_signature", detail: v.detail ?? `Signature did not verify (${(v.errors ?? []).join(", ")}).`, key_id: lumi_receipt?.signer?.key_id ?? null } };
}

/** publicKeys: code-only override of the pinned keys (tests, self-hosted Lumi). Never read from env or config files. */
export function registerContribTools(server, settings, { env = process.env, fetchImpl, kitLoader = loadKit, stderr, publicKeys = pinnedPublicKeys() } = {}) {
  server.registerTool(
    "lumi_check",
    {
      title: "Lumi Check: should I pay this x402 seller? (free)",
      description:
        "Free. Call before paying an x402 seller. Returns allow / warn / block with reasons, the seller's current Lumi score and a link to the live report card. " +
        "The verdict is signed by Lumi and verified locally against the Lumi keys pinned in this package (other keys are rejected). Only the URL's origin + path is sent. For MCP tool payments pass pay_to alone. " +
        "If Lumi cannot be reached within 2.5 s the answer is warn (fail-open). Paying Lumi never changes a score, tier, ranking or 'Tested by Lumi' result. The paid 'Monitored by Lumi' badge is separate and labelled as paid.",
      inputSchema: {
        url: z.string().max(500).optional().describe("The x402 resource URL you are about to pay"),
        pay_to: z.string().max(100).optional().describe("The payTo address from the 402 quote"),
        amount_usd: z.number().min(0).max(1e6).optional().describe("Price in USD, e.g. 0.01"),
        network: z.string().max(40).optional().describe("CAIP-2 network, e.g. eip155:8453 or xrpl:0"),
      },
    },
    async ({ url, pay_to, amount_usd, network }) => {
      const kit = await kitLoader();
      const lumi = kit.createLumiCheck({ api: env.LUMI_CHECK_API || settings.apiUrl, fetchImpl, configPath: configPathOf(env), env, publicKeys });
      const { receipt, ...r } = await lumi.check({ url, payTo: pay_to, amountUsd: amount_usd, network });
      // An MCP server cannot ask the one-time sharing question, so sharing stays off: one hint on stderr per process
      // (stdout is the MCP channel), only while unanswered. Nothing is shared and the tool result is unchanged.
      kit.hintOnce?.(lumi.config, { stderr });
      return text({ ...r, receipt_id: receipt?.id ?? null, signed_by: receipt?.signer?.key_id ?? null });
    },
  );
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
        "Submitting is tier 2 receipt sharing: OFF by default, so submit=true sends nothing until you opt in (LUMI_SHARE_RECEIPTS=1 or `lumi-scan sharing on`). " +
        "A receipt shares the payment's chain and transaction ID (tx hash), no amount or wallet field; a transaction ID is public on-chain and can be linked to the paying wallet. " +
        "Checked receipts earn a public contributor badge only (nothing of monetary value). No new spend. Self-tests (your own endpoints or wallets) are rejected.",
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
        const client = kit.createLumiClient({ api: env.LUMI_CONTRIB_API || settings.apiUrl, keyId: k.key_id, privateKey: k.private_key, fetchImpl, configPath: configPathOf(env), env });
        const res = await client.submit(receipt, "passive");
        if (res.sent === false) return { ...text({ submitted: false, error: res.error, detail: res.detail }), isError: true };
        return { ...text({ submitted: true, response: res }), isError: res.status >= 400 };
      } catch (e) {
        return { ...text({ error: kit.redact(String(e?.message ?? e)) }), isError: true };
      }
    },
  );
}
