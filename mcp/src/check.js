/**
 * Lumi Check from code, for agents that pay x402 sellers themselves (unpublished).
 *   import { lumiCheckHooks } from "lumi-trades-mcp/src/check.js";
 *   const { lumi, x402Hook, mcpHook } = await lumiCheckHooks();
 *   x402Client.onBeforePaymentCreation(x402Hook);     // aborts when Lumi says "block"
 *   mcpClient.onPaymentRequired(mcpHook);             // @x402/mcp: checked by payTo
 * Verdicts must be signed by a Lumi key pinned in this package (mcp/src/lumi_keys.js); others give lumi_untrusted_key.
 * Fail-open by default (warn on timeout / unverified verdict, 2.5 s). The adapters live in lumi-check (npm, Apache-2.0).
 */
import { loadKit } from "./contrib.js";
import { pinnedPublicKeys } from "./lumi_keys.js";

export async function lumiCheckHooks(opts = {}, kitLoader = loadKit) {
  const kit = await kitLoader();
  // Verdicts are checked against the keys pinned in this package unless code passes its own publicKeys (tests only).
  const lumi = kit.createLumiCheck({ ...opts, publicKeys: opts.publicKeys ?? pinnedPublicKeys() });
  return { lumi, x402Hook: kit.x402BeforePaymentHook(lumi, opts), mcpHook: kit.mcpOnPaymentRequiredHook(lumi, opts), withOutcomeReporting: (f) => kit.withOutcomeReporting(f, lumi) };
}
