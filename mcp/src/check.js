/**
 * Lumi Check from code, for agents that pay x402 sellers themselves (unpublished).
 *   import { lumiCheckHooks } from "lumi-trades-mcp/src/check.js";
 *   const { lumi, x402Hook, mcpHook } = await lumiCheckHooks();
 *   x402Client.onBeforePaymentCreation(x402Hook);     // aborts when Lumi says "block"
 *   mcpClient.onPaymentRequired(mcpHook);             // @x402/mcp: checked by payTo
 * Fail-open by default (warn on timeout / unverified verdict, 2.5 s). The adapters live in lumi-scanner-kit (Apache-2.0).
 */
import { loadKit } from "./contrib.js";

export async function lumiCheckHooks(opts = {}, kitLoader = loadKit) {
  const kit = await kitLoader();
  const lumi = kit.createLumiCheck(opts);
  return { lumi, x402Hook: kit.x402BeforePaymentHook(lumi, opts), mcpHook: kit.mcpOnPaymentRequiredHook(lumi, opts), withOutcomeReporting: (f) => kit.withOutcomeReporting(f, lumi) };
}
