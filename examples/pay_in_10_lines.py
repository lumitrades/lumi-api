# pip install "x402[requests,evm]==2.26.0"   then: EVM_PRIVATE_KEY=0x... python pay_in_10_lines.py "<Lumi paid URL>"
import base64, json, os, sys
from eth_account import Account
from x402 import x402ClientSync
from x402.http.clients import x402_requests
from x402.mechanisms.evm.exact import register_exact_evm_client
NET, MAX = os.environ.get("X402_NETWORK", "eip155:8453"), 250000  # USDC on Base, at most $0.25 (6 decimals)
client = register_exact_evm_client(x402ClientSync(lambda v, accepts: next(a for a in accepts if a.network == NET and int(a.amount) <= MAX)), Account.from_key(os.environ["EVM_PRIVATE_KEY"]))
r = x402_requests(client).get(sys.argv[1])  # 402 -> sign EIP-3009 -> retry with PAYMENT-SIGNATURE
pr = r.headers.get("PAYMENT-RESPONSE"); print(r.status_code, r.text, json.loads(base64.b64decode(pr)) if pr else "not paid")
