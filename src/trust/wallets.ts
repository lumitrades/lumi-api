/**
 * Published list of Lumi's test-buy wallets.
 *
 * Why: a receipt is signed by the wallet that paid (verify steps 1-4). Without a published payer list, anyone can sign a
 * well-formed receipt with their own wallet and call it a Lumi receipt. Step 4b closes that: a receipt only verifies when
 * payment.payer is on this list, whatever issuer.name says. The list is the same set the server already enforces when it stores
 * receipts (payer_not_lumi_wallet), so the public check and the private one cannot drift apart.
 *
 * Served free at GET /v1/check/wallets and /.well-known/lumi-test-buy-wallets.json (next to /v1/check/keys).
 */
export const TEST_BUY_WALLETS_VERSION = "2026-10-25";

export type TestBuyWallets = { xrpl: string[]; evm: string[]; stellar: string[] };

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

export function normaliseWallets(w: TestBuyWallets): TestBuyWallets {
  return { xrpl: uniq(w.xrpl), evm: uniq(w.evm.map((x) => x.toLowerCase())), stellar: uniq(w.stellar) };
}

/** Is `payer` one of Lumi's published test-buy wallets on `network`? EVM is case-insensitive; XRPL and Stellar are exact. */
export function isLumiTestBuyWallet(w: TestBuyWallets, network: string, payer: unknown): boolean {
  const p = String(payer ?? "");
  if (!p) return false;
  if (network === "xrpl:0") return w.xrpl.includes(p);
  if (network === "stellar:pubnet") return w.stellar.includes(p);
  if (network === "eip155:8453") return w.evm.includes(p.toLowerCase());
  return false;
}

export function testBuyWalletsDoc(base: string, w: TestBuyWallets) {
  const n = normaliseWallets(w);
  return {
    kind: "lumi_test_buy_wallets",
    version: TEST_BUY_WALLETS_VERSION,
    purpose: "The only wallets that pay for Lumi's test-buys. A receipt is a Lumi receipt only if payment.payer is listed here for payment.network (verify step 4b), whatever its issuer.name says.",
    wallets: {
      "xrpl:0": n.xrpl,
      "eip155:8453": n.evm,
      "stellar:pubnet": n.stellar,
    },
    matching: "XRPL and Stellar addresses match exactly; Base (eip155:8453) addresses match case-insensitively.",
    changes: "A wallet is added here before it pays for any test-buy, and is never removed while receipts it signed are served; a retired wallet is marked, not deleted.",
    verify: `${base}/v1/trust/receipts/verify`,
    keys: `${base}/v1/check/keys`,
  };
}
