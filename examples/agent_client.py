"""
Minimal agent client (Python) using the official XRPL x402 SDK (PyPI: x402-xrpl).

    pip install x402-xrpl xrpl-py
    XRPL_SEED=s... LUMI_API_URL=https://api.lumitrades.io XRPL_NETWORK=xrpl:0 \
        python examples/agent_client.py /v1/fear-greed
"""
import json
import os
import sys

from xrpl.wallet import Wallet
from x402_xrpl.clients import x402_requests, decode_payment_response

base = os.environ.get("LUMI_API_URL", "http://127.0.0.1:8787")
network = os.environ.get("XRPL_NETWORK", "xrpl:1")
rpc_url = os.environ.get(
    "XRPL_RPC_URL",
    "https://xrplcluster.com/" if network == "xrpl:0" else "https://testnet.xrpl-labs.com/",
)
path = sys.argv[1] if len(sys.argv) > 1 else "/v1/fear-greed"

session = x402_requests(
    Wallet.from_seed(os.environ["XRPL_SEED"]),
    rpc_url=rpc_url,
    network_filter=network,
    scheme_filter="exact",
)
r = session.get(base + path, timeout=180)
print(r.status_code)
body = r.json()
print(json.dumps({k: body[k] for k in list(body)[:6]}, indent=2)[:1500])
if "PAYMENT-RESPONSE" in r.headers:
    print("receipt:", decode_payment_response(r.headers["PAYMENT-RESPONSE"]))
