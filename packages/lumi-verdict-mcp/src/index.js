#!/usr/bin/env node
/**
 * lumi-verdict-mcp: a one-tool stdio MCP server. Check an x402 seller before your agent pays it.
 * lumi_verdict calls GET https://api.lumitrades.io/v1/verdict ($0.01, paid per call via x402 with YOUR wallet, within caps);
 * lumi_check_free calls the free, signed GET /v1/check (same label, from Lumi's record, no live contact).
 * Payment, caps and wallet handling are reused unchanged from lumi-trades-mcp.
 * x402 seller trust you can verify: automated observations, not a rating, endorsement or guarantee.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient, loadSettings, assetLabel } from "lumi-trades-mcp/src/lumi.js";

export const VERSION = "0.1.0";

export const VERDICT_DESCRIPTION =
  "Check an x402 seller before you pay it. Pass the resource URL (or the seller's domain) you are about to pay, and optionally the payTo and USD amount from its 402 quote. " +
  "Returns one label from Lumi Trades' own test-buys and checks: checks_passed (Delivered in recent checks), check_first (Check first), checks_failed (Recent checks failed) or no_data (Not enough data), " +
  "with as-of date, conclusive test-buy count, last delivered and failed dates, reason codes, evidence and appeal links. label_live is the label after Lumi contacts the seller at call time " +
  "(an unpaid request) and compares its quote, price, payTo and TLS with Lumi's record. Signed by Lumi. Costs $0.01 per call, paid from your wallet within the configured caps; " +
  "with no wallet it returns the price quote and pays nothing. Paying Lumi never changes a result. Observations, not a guarantee.";

export const FREE_DESCRIPTION =
  "Free. The same label as lumi_verdict from Lumi's record (cached, no live contact with the seller), signed by Lumi: checks_passed, check_first, checks_failed or no_data, with reason codes and an evidence link. " +
  "Only the origin and path of the URL are sent. Use lumi_verdict when you want the live check at call time.";

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const input = {
  url: z.string().min(1).max(500).describe("The x402 resource URL (or the seller's domain) you are about to pay"),
  payTo: z.string().max(120).optional().describe("Optional: the payTo address in its 402 quote"),
  amount: z.string().max(20).optional().describe("Optional: the quoted price in USD, e.g. 0.01"),
};
const query = ({ url, payTo, amount }) => {
  const q = new URLSearchParams({ url });
  if (payTo) q.set("payTo", payTo);
  if (amount) q.set("amount", amount);
  return q;
};
/** Origin + path only (no query string or fragment) for the free check, as in lumi-trades-mcp's lumi_check. */
const originPath = (u) => {
  try {
    const x = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    return x.origin + x.pathname;
  } catch {
    return u;
  }
};

export function buildServer(client) {
  const server = new McpServer({ name: "lumi-verdict-mcp", version: VERSION });

  server.registerTool(
    "lumi_verdict",
    { title: "Lumi: check an x402 seller before paying", description: VERDICT_DESCRIPTION, inputSchema: input },
    async (a) => {
      const path = "/v1/verdict?" + query(a).toString();
      const r = await client.free(path);
      if (r.status === 200) return text(r.body);
      if (r.status !== 402) return { ...text({ status: r.status, body: r.body }), isError: true };
      const p = await client.paid(path, "application/json");
      if (!p.paid) return { ...text(p), isError: p.status !== 402 || !!p.error };
      return text({ ...p.body, mcp_receipt: { tx: p.receipt?.transaction, network: p.receipt?.network, spent_this_session: p.spent_this_session } });
    },
  );

  server.registerTool(
    "lumi_check_free",
    { title: "Lumi: free signed seller check (cached)", description: FREE_DESCRIPTION, inputSchema: input },
    async (a) => {
      const r = await client.free("/v1/check?" + query({ ...a, url: originPath(a.url) }).toString());
      return r.status === 200 ? text(r.body) : { ...text({ status: r.status, body: r.body }), isError: true };
    },
  );
  return server;
}

async function main() {
  const settings = loadSettings();
  const client = createClient(settings);
  await buildServer(client).connect(new StdioServerTransport());
  // stderr only: stdout is the MCP channel. Never print the seed or key.
  const wallet = await client.walletAddress();
  console.error(`lumi-verdict-mcp ${VERSION}: ${settings.apiUrl}, paying in ${assetLabel(settings.asset)}${wallet ? ` from ${wallet}` : " (no wallet configured: free check and quotes only)"}`);
}

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((e) => {
    console.error(`lumi-verdict-mcp: ${e?.message ?? e}`);
    process.exit(1);
  });
}
