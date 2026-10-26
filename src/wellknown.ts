/**
 * Extra discovery files on the API host:
 * - /.well-known/mcp/server-card.json (and /.well-known/mcp.json): MCP Server Card (SEP-2127 shape, server.json-derived).
 * - /.well-known/agents.json: Wildcard agents.json v0.1.0 flows over /openapi.json operationIds.
 * Both lead with the trust check and link the x402 discovery doc; prices live in the 402s and /.well-known/x402.
 */
import { VERSION } from "./docs";
import { SERVICE_ICON } from "./bazaar";
import { SUPPORTED_VERSIONS } from "./mcp";

export const MCP_SERVER_NAME = "io.github.cypher-osiris/lumi-trades-mcp";

export function mcpServerCard(base: string) {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: MCP_SERVER_NAME,
    title: "Lumi Trades",
    version: VERSION,
    description:
      "Lumi Trades seller checks (should I pay this x402 URL? allow / warn / block, with signed test-buy receipts). " +
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
        "Check an x402 seller before paying it (Lumi Trades seller checks). Paid operations use x402 v2 (HTTP 402 + PAYMENT-SIGNATURE), no API key; " +
        `prices and payment options are in each 402 and in ${base}/.well-known/x402. Never charged when Lumi cannot answer.`,
    },
    sources: [{ id: "lumi", path: `${base}/openapi.json` }],
    flows: [
      flow("trust_check", "Should I pay this x402 URL?", "allow / warn / block with coded reasons for one x402 resource URL, optionally checking the quoted payTo and USD amount.", "trust_check"),
      flow("vendor_report", "x402 vendor report", "Full observation history for one curated vendor: quote checks, test-buys with tx hashes, uptime and latency.", "vendor_report"),
      flow("verdict", "One-label pre-payment check", "checks_passed / check_first / checks_failed / no_data for one x402 resource URL, from the same data as the free GET /v1/check.", "verdict"),
    ],
  };
}
