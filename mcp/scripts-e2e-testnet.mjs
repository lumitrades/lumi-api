/**
 * Testnet end-to-end check (never mainnet): starts nothing itself; expects a local Lumi API on testnet at LUMI_API_URL,
 * launches this MCP server over stdio with the throwaway testnet payer from ../.testnet/wallets.json and calls the tools.
 *   (cd .. && XRPL_NETWORK=xrpl:1 PAY_TO=<testnet receiver> PORT=8788 npm start) &
 *   node scripts-e2e-testnet.mjs
 */
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const w = JSON.parse(readFileSync(new URL("../.testnet/wallets.json", import.meta.url)));
if (w.network && !String(w.network).includes("1") && !/test/i.test(w.network)) throw new Error("not a testnet wallet file");
const transport = new StdioClientTransport({
  command: "node",
  args: ["src/index.js"],
  env: {
    ...process.env,
    XRPL_SEED: w.payer.seed,
    XRPL_NETWORK: "xrpl:1",
    LUMI_API_URL: process.env.LUMI_API_URL || "http://127.0.0.1:8788",
    LUMI_EXPECTED_PAY_TO: w.receiver.address,
    LUMI_SESSION_BUDGET: "0.2",
  },
});
const client = new Client({ name: "e2e", version: "0" });
await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.join(", "));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content?.[0]?.text ?? "" };
};
const cat = JSON.parse((await call("lumi_catalog")).text);
console.log("catalog:", cat.wallet, cat.caps, cat.endpoints.length, "endpoints");
console.log("quote /v1/market:", (await call("lumi_quote", { path: "/v1/brief" })).text.replace(/\s+/g, " ").slice(0, 300));
const out = {};
for (const [name, args] of [["lumi_sentiment"], ["lumi_macro_yen"], ["lumi_events"], ["lumi_market"], ["lumi_institutional_brief", { format: "md" }]]) {
  const r = await call(name, args ?? {});
  let tx = null;
  try { tx = JSON.parse(r.text).mcp_receipt?.tx; } catch { tx = (r.text.match(/"tx":"([0-9A-F]{64})"/) || [])[1]; }
  out[name] = { isError: r.isError, tx, chars: r.text.length };
  console.log(name, r.isError ? "ERROR" : "ok", tx ?? "", r.isError ? r.text.slice(0, 400) : "");
  if (name === "lumi_institutional_brief") console.log(r.text.slice(0, 600));
}
await client.close();
console.log(JSON.stringify(out));
