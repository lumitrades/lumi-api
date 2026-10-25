/**
 * Coinbase AgentKit (>= 0.10.4) buying a Lumi read with USDC on Base, by direct URL.
 *
 *   npm i @coinbase/agentkit viem
 *   EVM_PRIVATE_KEY=0x... npx tsx examples/agentkit-direct-url.ts /v1/sentiment
 *   LUMI_DRY_RUN=1 EVM_PRIVATE_KEY=0x... npx tsx examples/agentkit-direct-url.ts   # quote only, pays nothing
 *
 * Why direct URL: AgentKit 0.10.4's `discover_x402_services` drops x402 v2 resources whose
 * description sits at the top level of the Bazaar record (it reads `metadata.description`),
 * so Lumi and most v2 sellers do not show up there yet. Calling the URL works today:
 * `make_http_request` gets the 402, keeps the options for the wallet's network
 * (eip155:8453), and `retry_http_request_with_x402` signs an EIP-3009 USDC authorization
 * (no ETH/gas needed) and returns the JSON. In an LLM agent, just give it the URL.
 */
import { AgentKit, ViemWalletProvider, x402ActionProvider } from "@coinbase/agentkit";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// AgentKit fires a best-effort analytics POST from the wallet provider without catching errors;
// if that endpoint rejects (seen with 0.10.4 from some networks) Node exits. Ignore only that.
process.on("unhandledRejection", (e) => {
  if (String((e as Error)?.stack ?? e).includes("sendAnalyticsEvent")) return;
  throw e;
});

const url = `https://api.lumitrades.io${process.argv[2] ?? "/v1/sentiment"}`;
const MAX_USDC_ATOMIC = 50_000n; // refuse anything above $0.05 (the Institutional Brief is $0.10: raise this to buy it)

const walletProvider = new ViemWalletProvider(
  createWalletClient({
    account: privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`),
    chain: base,
    transport: http(),
  }),
);
const agentkit = await AgentKit.from({ walletProvider, actionProviders: [x402ActionProvider()] });
const action = (name: string) => {
  const a = agentkit.getActions().find((x) => x.name.endsWith(name));
  if (!a) throw new Error(`AgentKit action ${name} not found`);
  return a;
};

// 1) Plain request: Lumi answers 402 with XRPL options first and Base USDC last.
const quote = JSON.parse(await action("make_http_request").invoke({ url }));
if (quote.status !== "error_402_payment_required") {
  console.log(JSON.stringify(quote, null, 2));
  process.exit(0);
}
const option = quote.acceptablePaymentOptions.find((o: { network: string }) => o.network === "eip155:8453");
if (!option) throw new Error("no Base USDC option in the 402");
console.log(`price: ${Number(option.amount) / 1e6} USDC on Base -> ${option.payTo}`);
if (BigInt(option.amount) > MAX_USDC_ATOMIC) throw new Error("price above MAX_USDC_ATOMIC; not paying");
if (process.env.LUMI_DRY_RUN) process.exit(0);

// 2) Pay and retry. You are only charged when Lumi returns 200 with fresh data.
const paid = JSON.parse(
  await action("retry_http_request_with_x402").invoke({
    url,
    method: "GET",
    selectedPaymentOption: {
      scheme: option.scheme,
      network: option.network,
      asset: option.asset,
      amount: option.amount,
      payTo: option.payTo,
    },
  }),
);
console.log(JSON.stringify(paid, null, 2));
