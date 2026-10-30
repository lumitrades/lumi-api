/**
 * "Pay in 10 lines": the shortest working x402 v2 buyer for Lumi's paid routes, USDC on Base (EIP-3009, gasless for the buyer).
 * Served in /skill.md (and /llms.txt on the API host) and linked from every 402 (`how_to_pay`). The same text is committed as
 * examples/pay-in-10-lines.mjs and examples/pay_in_10_lines.py (test/pay_in_10_lines.test.ts keeps them identical) and was
 * dry-run against scripts/pay10-local.ts (local app + fake facilitator that checks the EIP-3009 signature; no real payment).
 * Both cap a single payment at $0.25 (Lumi's highest per-call price is $0.25: the high-value check cap).
 */
export const PAY_NODE = "// npm i @x402/fetch @x402/evm viem   then: EVM_PRIVATE_KEY=0x... node pay-in-10-lines.mjs \"<Lumi paid URL>\"\nimport { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from \"@x402/fetch\";\nimport { registerExactEvmScheme } from \"@x402/evm/exact/client\";\nimport { privateKeyToAccount } from \"viem/accounts\";\nconst NET = process.env.X402_NETWORK ?? \"eip155:8453\", MAX = 250000n; // USDC on Base, at most $0.25 (6 decimals)\nconst client = new x402Client((_v, accepts) => accepts.find((a) => a.network === NET && BigInt(a.amount) <= MAX) ?? (() => { throw new Error(\"no Base USDC quote <= $0.25\"); })());\nregisterExactEvmScheme(client, { signer: privateKeyToAccount(process.env.EVM_PRIVATE_KEY) });\nconst res = await wrapFetchWithPayment(fetch, client)(process.argv[2]);   // 402 -> sign EIP-3009 -> retry with PAYMENT-SIGNATURE\nconst receipt = res.headers.get(\"PAYMENT-RESPONSE\");\nconsole.log(res.status, await res.text(), receipt ? decodePaymentResponseHeader(receipt) : \"not paid\");\n";

export const PAY_PYTHON = "# pip install \"x402[requests,evm]==2.26.0\"   then: EVM_PRIVATE_KEY=0x... python pay_in_10_lines.py \"<Lumi paid URL>\"\nimport base64, json, os, sys\nfrom eth_account import Account\nfrom x402 import x402ClientSync\nfrom x402.http.clients import x402_requests\nfrom x402.mechanisms.evm.exact import register_exact_evm_client\nNET, MAX = os.environ.get(\"X402_NETWORK\", \"eip155:8453\"), 250000  # USDC on Base, at most $0.25 (6 decimals)\nclient = register_exact_evm_client(x402ClientSync(lambda v, accepts: next(a for a in accepts if a.network == NET and int(a.amount) <= MAX)), Account.from_key(os.environ[\"EVM_PRIVATE_KEY\"]))\nr = x402_requests(client).get(sys.argv[1])  # 402 -> sign EIP-3009 -> retry with PAYMENT-SIGNATURE\npr = r.headers.get(\"PAYMENT-RESPONSE\"); print(r.status_code, r.text, json.loads(base64.b64decode(pr)) if pr else \"not paid\")\n";

/** Short pointer carried in every paid 402 body and PAYMENT-REQUIRED header. */
/** One short pointer (not the code itself): every 402 header byte counts, and the full examples live in skill.md. */
export function howToPay(base: string): string {
  return `${base}/skill.md#pay-in-10-lines-usdc-on-base (node or Python, USDC on Base)`;
}
