/**
 * Extra discovery files on the API host:
 * - /.well-known/mcp/server-card.json (and /.well-known/mcp.json): MCP Server Card (SEP-2127 shape, server.json-derived).
 * - /.well-known/agents.json: Wildcard agents.json v0.1.0 flows over /openapi.json operationIds.
 * Both lead with the trust check and link the x402 discovery doc; prices live in the 402s and /.well-known/x402.
 */
import { VERSION } from "./docs";
import { SERVICE_ICON } from "./bazaar";
import { SUPPORTED_VERSIONS } from "./mcp";
import { MARKET_IDEAS_NAME, MARKET_IDEAS_NOTICE } from "./lines";

export const MCP_SERVER_NAME = "io.github.cypher-osiris/lumi-trades-mcp";

export function mcpServerCard(base: string) {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: MCP_SERVER_NAME,
    title: "Lumi Trades",
    version: VERSION,
    description:
      "Lumi Trust (should I pay this x402 URL? allow / warn / block, with signed test-buy receipts) plus crypto market data and daily briefs for agents; " +
      `separately, ${MARKET_IDEAS_NAME} (signals, levels, scan and paper trades; ${MARKET_IDEAS_NOTICE}). ` +
      "Free tools answer directly; paid tools return the x402 price (USDC on Base, XRP / RLUSD / USDC on the XRP Ledger, or USDC on Stellar).",
    websiteUrl: `${base}/skill.md`,
    repository: { url: "https://github.com/cypher-osiris/lumi-api", source: "github", subfolder: "mcp" },
    icons: [{ src: SERVICE_ICON, sizes: ["512x512"], mimeType: "image/png" }],
    remotes: [{ type: "streamable-http", url: `${base}/mcp`, supportedProtocolVersions: SUPPORTED_VERSIONS }],
    _meta: {
      "io.lumitrades/discovery": {
        x402: `${base}/.well-known/x402`,
        openapi: `${base}/openapi.json`,
        agent_card: `${base}/.well-known/agent-card.json`,
        stdio_package: "lumi-trades-mcp",
        authentication: "none (x402 per call on the REST URLs; optional owner key for this server)",
      },
    },
  };
}

const flow = (id: string, title: string, description: string, operationId: string) => ({
  id: `${id}_flow`,
  title,
  description,
  actions: [{ id: `${id}_action`, sourceId: "lumi", operationId }],
  links: [],
  fields: { parameters: [], responses: { success: { type: "object" } } },
});

export function agentsJson(base: string) {
  return {
    agentsJson: "0.1.0",
    info: {
      title: "Lumi Trades API",
      version: VERSION,
      description:
        `Check an x402 seller before paying it (Lumi Trust). Separately: crypto market data, and ${MARKET_IDEAS_NAME} (${MARKET_IDEAS_NOTICE}).` + " Paid operations use x402 v2 (HTTP 402 + PAYMENT-SIGNATURE), no API key; " +
        `prices and payment options are in each 402 and in ${base}/.well-known/x402. Never charged when data is stale.`,
    },
    sources: [{ id: "lumi", path: `${base}/openapi.json` }],
    flows: [
      flow("trust_check", "Should I pay this x402 URL?", "allow / warn / block with coded reasons for one x402 resource URL, optionally checking the quoted payTo and USD amount.", "trust_check"),
      flow("vendor_report", "x402 vendor report", "Full observation history for one curated vendor: quote checks, test-buys with tx hashes, uptime and latency.", "vendor_report"),
      flow("brief", "Daily crypto market brief", "BTC levels and read, sentiment, funding, movers, key levels, yen watch and next-48h events in one call.", "brief"),
      flow("signal", `${MARKET_IDEAS_NAME}: coin signal`, `Rule-based buy/sell read for one of 51 coins with 1h/4h/1d labels and indicators. ${MARKET_IDEAS_NOTICE}`, "signal"),
      flow("levels", `${MARKET_IDEAS_NAME}: coin levels`, `Support/resistance and rule-based 7-day scenario levels (not forecasts) for one coin. ${MARKET_IDEAS_NOTICE}`, "levels"),
      flow("scan", `${MARKET_IDEAS_NAME}: all-coins scan`, `50 live signals in one call, strongest first. ${MARKET_IDEAS_NOTICE}`, "scan"),
      flow("institutional", "Institutional & policy brief", "Daily dated, sourced moves by regulators, central banks and banks mapped to XRP, XLM, XDC, QNT, AXL and HBAR.", "institutional"),
    ],
  };
}
