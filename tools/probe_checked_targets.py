#!/usr/bin/env python3
"""Build the deduplicated seller universe + one probe target per host (box-side, read-only inputs).

Inputs (env PC_DIR, default /tmp/pc):
  catalog.json   read-only D1 SELECT of the live Bazaar catalog
  buys.json      read-only D1 SELECT domain, pay_to, network, delivered from catalog_buys
  x402scan_resources_live.json, x402scan_onchain_sellers_base_30d.json  public x402scan listings
  ACTIVITY_CSV   seller_income csv: ONLY the all_domains / payto_addresses columns are read (no income fields)
Output: targets.json
"""
import csv, json, os, collections
from urllib.parse import urlparse
import tldextract

PC = os.environ.get("PC_DIR", "/tmp/pc")
ACT = os.environ.get("ACTIVITY_CSV", "/workspace/notes/research/seller_income_2026-10-25.csv")
ext = tldextract.TLDExtract(include_psl_private_domains=True, suffix_list_urls=())
SELF = {"lumitrades.io"}

def reg(host):
    h = (host or "").lower().strip(".")
    if h.startswith("www."): h = h[4:]
    e = ext(h)
    return e.top_domain_under_public_suffix or h if e.suffix else h

def norm_host(u):
    try: return (urlparse(u).hostname or "").lower().removeprefix("www.")
    except Exception: return ""

hosts = {}  # host -> info
def H(h):
    return hosts.setdefault(h, {"host": h, "reg": reg(h), "sources": set(), "cands": [], "pay_tos": set(), "base_listed": False, "price": None, "complete": None})

cat = json.load(open(f"{PC}/catalog.json"))[0]["results"]
for r in cat:
    h = r["domain"]; i = H(h); i["sources"].add("bazaar")
    nets = (r["networks"] or "").split(",")
    if "eip155:8453" in nets: i["base_listed"] = True
    for p in (r["pay_tos"] or "").split(","):
        if p: i["pay_tos"].add(p.lower())
    if r["method"] != "MCP":
        i["cands"].append({"url": r["resource"], "method": r["method"], "src": "bazaar", "price": r["price_usd"], "pay_tos": [p for p in (r["pay_tos"] or "").split(",") if p],
                           "complete": bool((r["dlen"] or 0) >= 20 and (r["method"] == "GET" or r["has_body"])), "base": "eip155:8453" in nets,
                           "prod_valid": r["probe_valid"]})

for r in json.load(open(f"{PC}/x402scan_resources_live.json")):
    h = (r["host"] or "").lower().removeprefix("www.")
    if not h: continue
    i = H(h); i["sources"].add("x402scan")
    m = (r["method"] or "").upper()
    if m in ("", "GET", "POST"):
        i["cands"].append({"url": r["resource"], "method": m or "GET", "src": "x402scan", "last": r["last"]})

act_domains, act_paytos = set(), set()
with open(ACT) as f:
    for row in csv.DictReader(f):
        for d in (row.get("all_domains") or "").split():
            d = d.lower().removeprefix("www."); act_domains.add(d)
            H(d)["sources"].add("activity")
        for p in (row.get("payto_addresses") or "").split():
            if p.startswith("eip155:8453:"): act_paytos.add(p.split(":")[-1].lower())

buys = json.load(open(f"{PC}/buys.json"))[0]["results"]
buy_domains = collections.defaultdict(lambda: {"n": 0, "delivered": 0, "base": False})
buy_paytos = set()
for b in buys:
    d = buy_domains[b["domain"]]; d["n"] += b["n"]; d["delivered"] = max(d["delivered"], b["delivered"] or 0)
    if b["network"] == "eip155:8453": d["base"] = True; buy_paytos.add(b["pay_to"])
    if b["domain"] in hosts: hosts[b["domain"]]["pay_tos"].add(b["pay_to"])

onchain = json.load(open(f"{PC}/x402scan_onchain_sellers_base_30d.json"))

out = []
for h, i in hosts.items():
    if not h or reg(h) in SELF: continue
    c = i["cands"]
    # one endpoint per host: prefer a Bazaar Base GET listing, then any GET, then POST
    def rank(x):
        return (0 if x["src"] == "bazaar" and x.get("base") else 1, 0 if x["method"] == "GET" else 1, 0 if x.get("prod_valid") == 1 else 1, -(len(x.get("last") or "")), x["url"])
    pick = sorted(c, key=rank)[0] if c else None
    out.append({"host": h, "reg": i["reg"], "sources": sorted(i["sources"]), "pay_tos": sorted(i["pay_tos"]), "base_listed": i["base_listed"],
                "target": pick, "wellknown": bool({"bazaar", "activity"} & i["sources"]),
                "buys": buy_domains.get(h)})
json.dump({"hosts": out, "onchain": onchain, "act_paytos": sorted(act_paytos), "buy_paytos": sorted(buy_paytos)}, open(f"{PC}/targets.json", "w"))
c = collections.Counter(s for o in out for s in o["sources"])
print("hosts", len(out), dict(c), "with target", sum(1 for o in out if o["target"]), "wellknown", sum(o["wellknown"] for o in out), "regs", len({o["reg"] for o in out}))
