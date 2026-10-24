/**
 * Trust layer v0: the vendor allowlist. Only x402 sellers listed here are probed,
 * test-bought and scored. Every entry is a public x402 endpoint that advertised an
 * XRPL (`xrpl:0`) payment option when it was added; pay-to addresses are the ones
 * the vendor's own 402 quote advertised.
 */

export interface VendorEndpoint {
  url: string;
  method: "GET" | "POST";
  /** JSON body for POST endpoints (sent unpaid by the free probe, and paid by the box-side test-buy). */
  body?: Record<string, unknown>;
  /** Price the vendor advertised when the endpoint was listed (the live quote is what the probe records). */
  listed_price: string;
  listed_asset: "XRP" | "RLUSD" | "USDC";
  /** The endpoint Lumi's daily test-buy uses (one per vendor). */
  test_buy?: boolean;
}

export interface Vendor {
  id: string;
  name: string;
  homepage: string;
  /** Pay-to addresses advertised in the vendor's 402 quotes (XRPL r-address and, if offered, EVM). */
  pay_to: { xrpl: string[]; evm?: string[] };
  endpoints: VendorEndpoint[];
}

export const VENDORS: Vendor[] = [
  {
    id: "asksurf",
    name: "AskSurf (x402 data API)",
    homepage: "https://x402.asksurf.ai",
    pay_to: { xrpl: ["ra9b6JX5aPVbdJhogDDddsRAcasWg7gzC3"] },
    endpoints: [{ url: "https://x402.asksurf.ai/x402/xrpl/data/v1/news/feed", method: "GET", listed_price: "0.006", listed_asset: "RLUSD", test_buy: true }],
  },
  {
    id: "heurist-mesh",
    name: "Heurist Mesh (x402 agents)",
    homepage: "https://mesh.heurist.xyz",
    pay_to: { xrpl: ["rMPwy3Ntx56Nyc2fKGNm7VRWdmpHSB92Z7"] },
    endpoints: [
      { url: "https://mesh.heurist.xyz/x402/xrpl/agents/FundingRateAgent/get_all_funding_rates", method: "POST", body: {}, listed_price: "0.001", listed_asset: "RLUSD", test_buy: true },
      { url: "https://mesh.heurist.xyz/x402/xrpl/agents/ElfaTwitterIntelligenceAgent/search_mentions", method: "POST", body: { keywords: ["xrp"] }, listed_price: "0.01", listed_asset: "RLUSD" },
    ],
  },
  {
    id: "heurist-router",
    name: "Heurist LLM Router (x402)",
    homepage: "https://router.heurist.xyz",
    pay_to: { xrpl: ["rBi1QrVjwaNofisZAQnovoXdHkS73FG1tJ"] },
    endpoints: [
      {
        url: "https://router.heurist.xyz/x402/xrpl/v1/chat/completions",
        method: "POST",
        body: { model: "heurist/deepseek-v4-flash", messages: [{ role: "user", content: "Reply with the single word OK." }], max_tokens: 256 },
        listed_price: "0.0005",
        listed_asset: "RLUSD",
        test_buy: true,
      },
    ],
  },
  {
    id: "printmoneylab",
    name: "PrintMoneyLab (KR market data)",
    homepage: "https://api.printmoneylab.com",
    pay_to: { xrpl: ["raKj7ZGoPy1fWw1vfynuJhyHirpcmUMBhP"] },
    endpoints: [
      { url: "https://api.printmoneylab.com/api/v1/xrpl/kimchi-premium", method: "GET", listed_price: "0.002", listed_asset: "RLUSD", test_buy: true },
      { url: "https://api.printmoneylab.com/api/v1/xrpl/kr-sentiment", method: "GET", listed_price: "0.05", listed_asset: "RLUSD" },
    ],
  },
  {
    id: "monid",
    name: "Monid (x402 XRPL gateway)",
    homepage: "https://monid-x402-xrpl-production.up.railway.app",
    pay_to: { xrpl: ["rGYbaZwYqA5XwFcmxWVdyyut4vUeTD7KcQ"] },
    endpoints: [
      { url: "https://monid-x402-xrpl-production.up.railway.app/t/surf/exchange/funding-history", method: "POST", body: { queryParams: { pair: "BTC/USDT", exchange: "binance", limit: 5 } }, listed_price: "0.006", listed_asset: "RLUSD", test_buy: true },
      { url: "https://monid-x402-xrpl-production.up.railway.app/t/api.strale.io/x402/fear-greed-index", method: "GET", listed_price: "0.0216", listed_asset: "RLUSD" },
    ],
  },
  {
    id: "invinoveritas",
    name: "invinoveritas signals (babyblueviper)",
    homepage: "https://api.babyblueviper.com",
    pay_to: { xrpl: ["rhFHztjS63h6fs5vXgTotuL7jsuryUvDSF"], evm: ["0x161DbdD73D025E9aEdd4918a67c28e5bf9A87Fb9"] },
    endpoints: [{ url: "https://api.babyblueviper.com/signals/full", method: "GET", listed_price: "0.024649", listed_asset: "XRP", test_buy: true }],
  },
  {
    id: "scalpstream",
    name: "ScalpStream crypto feed",
    homepage: "https://feed.scalpstream.com",
    pay_to: { xrpl: ["rwV5T9Gnr5EBH9rJ2G4NABc4bun2XEkHaD"], evm: ["0xD0f5d2E48e67A265174593aCe2cd540337C1564a"] },
    endpoints: [{ url: "https://feed.scalpstream.com/crypto", method: "GET", listed_price: "0.0076", listed_asset: "XRP", test_buy: true }],
  },
  // Added 2026-10-22 by the one-time vendor research run (sources: XRPL AI Hub directory, CDP x402 Bazaar,
  // x402 Doctor network scan). Pay-to addresses and prices are from each vendor's own live 402 quote.
  {
    id: "lucyos",
    name: "LucyOS (token analysis)",
    homepage: "https://x402.lucyos.ai",
    pay_to: { xrpl: ["rJMvspZMb1FRHmy8d3RP2eVGPjRmfKXh6e"] },
    endpoints: [{ url: "https://x402.lucyos.ai/x402/xrpl/tools/analyze_token", method: "POST", body: {"token": "XRP", "chain": "xrpl", "language": "English"}, listed_price: "0.001", listed_asset: "XRP", test_buy: true }],
  },
  {
    id: "aslan-macropulse",
    name: "The Aslan Group MacroPulse",
    homepage: "https://macropulse.theaslangroupllc.com",
    pay_to: { xrpl: ["rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32"], evm: ["0x50ab2018c06c6E4eAA9BA52057Eb55eD284912fc"] },
    endpoints: [{ url: "https://macropulse.theaslangroupllc.com/api/market/is-open?exchange=NYSE", method: "GET", listed_price: "0.005", listed_asset: "RLUSD", test_buy: true }],
  },
  {
    id: "cloudpayx",
    name: "cloudpayX agent (asset analysis)",
    homepage: "https://api.cloudpayxagent.xyz",
    pay_to: { xrpl: ["rsnHPZjBSastxz1BE38WqKBR3sgpATvreL"], evm: ["0x81Dc8fA9A5CB5c04bE0BF30D93bA2d7d8F49c3Ca"] },
    endpoints: [{ url: "https://api.cloudpayxagent.xyz/agent/v3/asset-analysis", method: "POST", body: {"asset": "RLUSD", "issuer": "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"}, listed_price: "0.005", listed_asset: "RLUSD", test_buy: true }],
  },
  {
    id: "agentic-swarm",
    name: "Agentic Swarm Marketplace",
    homepage: "https://api.agentic-swarm-marketplace.com",
    pay_to: { xrpl: ["rHyLmYewCQABAx6MMRBBuYYUUYWve2E1Lf"] },
    endpoints: [{ url: "https://api.agentic-swarm-marketplace.com/t54/hello", method: "GET", listed_price: "0.001", listed_asset: "XRP", test_buy: true }],
  },
  {
    id: "fizzl-x402-doctor",
    name: "Fizzl x402 Doctor (preflight)",
    homepage: "https://x402-doctor.fizzl.eu",
    pay_to: { xrpl: ["r9xmBsRr8Ao7jRgjjxreMiAwGiCK2FGwqw"], evm: ["0x6B0F4651eD42893ab58139938175E4a69f175F25"] },
    endpoints: [{ url: "https://x402-doctor.fizzl.eu/api/v1/preflight?url=https%3A%2F%2Fapi.lumitrades.io%2Fv1%2Ftrust%2Fvendors%2Fasksurf%2Freport", method: "GET", listed_price: "0.001", listed_asset: "RLUSD", test_buy: true }],
  },
  {
    id: "agentweather",
    name: "Agent Weather (pulse)",
    homepage: "https://api.agentweather.io",
    pay_to: { xrpl: ["rnFHPGmgTLSg7hjzfr8wiHaTdTh3PijrZZ"], evm: ["0xA15c55f39Ec1dfd87Afb09e1959EFac2Bf44F4Ec"] },
    endpoints: [{ url: "https://api.agentweather.io/v1/pulse/facilitator", method: "GET", listed_price: "0.001", listed_asset: "RLUSD", test_buy: true }],
  },
  {
    id: "evebrief-risk-oracle",
    name: "onchain-risk-oracle (evebrief)",
    homepage: "https://oracle.evebrief.org",
    pay_to: { xrpl: ["rH2tcNh56xoLUssRubra7DSDCgrReSZodW"] },
    endpoints: [{ url: "https://oracle.evebrief.org/", method: "POST", body: {"address": "0xdAC17F958D2ee523a2206206994597C13D831ec7", "chain": "ethereum"}, listed_price: "0.01", listed_asset: "RLUSD", test_buy: true }],
  },
  {
    id: "vextorium",
    name: "Vextorium API",
    homepage: "https://api.vextorium.com",
    pay_to: { xrpl: ["rEac5rTEr7y81iEyrMTrHCRbnktSE2pNCp"], evm: ["0xb9f06D2734B7E9D7b21B64C4D8b95bd774b71aCf"] },
    endpoints: [{ url: "https://api.vextorium.com/v1/wikipedia-trending", method: "POST", body: {"language": "en", "limit": 3}, listed_price: "0.002", listed_asset: "RLUSD", test_buy: true }],
  },
  {
    id: "cocoeatsai-launchlab",
    name: "Launch Lab agent tools (cocoeatsai)",
    homepage: "https://cocoeatsai.com",
    pay_to: { xrpl: ["rJyvqmdsqvpzayX9Y2mKr6LKkAME5TjcrY"], evm: ["0x6fE6079cDAe9199b1aCE8E89b11A687636E7b895"] },
    endpoints: [{ url: "https://cocoeatsai.com/area4/agent/tools/json-format?data=%5B%7B%22name%22%3A%22example%22%2C%22value%22%3A1%7D%5D&mode=pretty", method: "GET", listed_price: "0.0001", listed_asset: "XRP", test_buy: true }],
  },
  {
    id: "emerge-digital",
    name: "Emerge Digital Agent Commerce",
    homepage: "https://agent-commerce.emergedigital.com",
    pay_to: { xrpl: ["rERHPAkbSH8bEHYJWKDERJJ9meDab8Zb1N"] },
    endpoints: [{ url: "https://agent-commerce.emergedigital.com/api/xrpl/utm-build?base_url=https%3A%2F%2Fexample.com%2F&utm_source=newsletter&utm_medium=email&utm_campaign=test", method: "GET", listed_price: "0.001", listed_asset: "XRP", test_buy: true }],
  },
  {
    id: "xrplhub",
    name: "XRPLHub (screening)",
    homepage: "https://www.xrplhub.io",
    pay_to: { xrpl: ["rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF"] },
    endpoints: [{ url: "https://www.xrplhub.io/api/x402/screen/ofac?address=rnXyVQzgxZe7TR1EPzTkGj2jxH4LMJYh66", method: "GET", listed_price: "0.01", listed_asset: "RLUSD", test_buy: true }],
  },
  {
    id: "cryptobuddy",
    name: "CryptoBuddy (AU crypto data)",
    homepage: "https://x402.cryptobuddy.com.au",
    pay_to: { xrpl: ["rpvQtAL2zoFV6BARKRWGRqzL2yDfNy6eH5"] },
    endpoints: [{ url: "https://x402.cryptobuddy.com.au/crypto/australia/asset-mainnet?symbol=XRP&amount=5000", method: "GET", listed_price: "0.001", listed_asset: "XRP", test_buy: true }],
  },
  {
    id: "helpmyagent",
    name: "HelpMyAgent (validation APIs)",
    homepage: "https://api.helpmyagent.com",
    pay_to: { xrpl: ["rUXKCZetEbwQc1i5vkJL6SNXYK3hG7Fezy"], evm: ["0xEaB9543AcF710a24fe096913A428E7d066c88F59"] },
    endpoints: [{ url: "https://api.helpmyagent.com/v1/iban/validate", method: "POST", body: {"iban": "DE89370400440532013000"}, listed_price: "0.002", listed_asset: "RLUSD", test_buy: true }],
  },
  {
    id: "edge-agents",
    name: "Edge Agents (data services)",
    homepage: "https://pay.edge-agents.ai",
    pay_to: { xrpl: ["rKv7LTd19CUsKKirVzdZWK4HuFChHf4Hp7"], evm: ["0x7d9C21AcB6be3F6EA4723c148A32DC327a3eCB5b"] },
    endpoints: [{ url: "https://pay.edge-agents.ai/v1/services/perp-funding-rates", method: "GET", listed_price: "0.01", listed_asset: "RLUSD", test_buy: true }],
  },
  {
    id: "x402lab",
    name: "x402lab (XRPL AMM data)",
    homepage: "https://api.x402lab.dev",
    pay_to: { xrpl: ["rPzwqkF8BC6uJWAVosexHqf3cpu7Vuuy7g"] },
    endpoints: [{ url: "https://api.x402lab.dev/products/demo", method: "GET", listed_price: "0.011", listed_asset: "RLUSD", test_buy: true }],
  },
  {
    id: "db-expert",
    name: "DB Expert Fishing Intelligence",
    homepage: "https://db-expert-x402.onrender.com",
    pay_to: { xrpl: ["rLNmmcNEizWaygypRVTKaWoZG6RrqfsJpi"] },
    endpoints: [{ url: "https://db-expert-x402.onrender.com/search?q=method", method: "GET", listed_price: "0.01", listed_asset: "XRP", test_buy: true }],
  },
  {
    id: "alsp",
    name: "ALSP XRPL session evidence",
    homepage: "https://alsp.vercel.app",
    pay_to: { xrpl: ["rMRaxFZnyNHmqfafLbAdGbi9cHi24UhiaG"] },
    endpoints: [{ url: "https://alsp.vercel.app/api/xrpl/paid-resource", method: "GET", listed_price: "0.01", listed_asset: "XRP", test_buy: true }],
  },
  {
    id: "sitecheck-api",
    name: "sitecheck-api (macro data)",
    homepage: "https://api.sitecheck-api.workers.dev",
    pay_to: { xrpl: ["rDxNZCDfLxUzeMWGGwsY3sjQT8eoZCf8UJ"], evm: ["0xb8491F953e6860D3b5840b73c60883Ff099ceAfA"] },
    endpoints: [{ url: "https://api.sitecheck-api.workers.dev/api/macro?series=fed_funds&limit=3", method: "GET", listed_price: "0.001", listed_asset: "RLUSD", test_buy: true }],
  },
  {
    id: "horizonpulse",
    name: "HorizonPulse (market pulse)",
    homepage: "https://horizonpulse.dev",
    pay_to: { xrpl: ["r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcf"], evm: ["0x5b32c973596078a967562ca652761404f19be0e9"] },
    endpoints: [{ url: "https://horizonpulse.dev/api/pulse", method: "GET", listed_price: "0.002", listed_asset: "RLUSD", test_buy: true }],
  },
  {
    id: "bitbooth",
    name: "BitBooth (heinrichstech)",
    homepage: "https://app.heinrichstech.com",
    pay_to: { xrpl: ["rfryheo6yzFdLWj8qUQtZc7zG9MKkBkUEy"], evm: ["0xDa2F35d283c42dd60B965322394bc658a5c1769F"] },
    endpoints: [{ url: "https://app.heinrichstech.com/v1/cdp/echo", method: "POST", body: { message: "hello bitbooth" }, listed_price: "0.001", listed_asset: "RLUSD", test_buy: true }],
  },
  {
    id: "xrpreflight",
    name: "XRPreflight (destinationpreflight)",
    homepage: "https://destinationpreflight.com",
    pay_to: { xrpl: ["rEB3eMYcrd1L7WXQMrAAWKfFiM1fRtpggt"] },
    endpoints: [{ url: "https://destinationpreflight.com/v1/post-send?hash=4A676BC446BCF9499935EC71F1DA4CDC4F7C30D273093157C819D9861DEC96EF&destination=ra9b6JX5aPVbdJhogDDddsRAcasWg7gzC3", method: "GET", listed_price: "0.0005", listed_asset: "XRP", test_buy: true }],
  },
  {
    id: "bruk",
    name: "Brük agent API (XRPL checks)",
    homepage: "https://bruk-agent-api.fly.dev",
    pay_to: { xrpl: ["r36sbDCAsaCj44ZUXWY2jjGE1jBpsCoRQ4"] },
    endpoints: [{ url: "https://bruk-agent-api.fly.dev/v1/send-check?amount=5&currency=RLUSD&destination=r36sbDCAsaCj44ZUXWY2jjGE1jBpsCoRQ4", method: "GET", listed_price: "0.00385", listed_asset: "XRP", test_buy: true }],
  },
];

export const vendorById = (id: string): Vendor | undefined => VENDORS.find((v) => v.id === id);

export function vendorPayTos(v: Vendor): string[] {
  return [...v.pay_to.xrpl, ...(v.pay_to.evm ?? []).map((a) => a.toLowerCase())];
}
