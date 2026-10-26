#!/usr/bin/env python3
"""Recompute the dated XRPL Bazaar sweep counts (SWEEP_COUNTS in src/trust/catalog_service.ts) from the sweep notes.
A bought host whose paid call got no HTTP response (status 0/null, Lumi client timeout, or Lumi run interrupted) is
inconclusive (Lumi-side), not "not delivered"."""
import json, sys
if len(sys.argv) < 2: sys.exit("usage: sweep_counts.py <sweep notes .json>")
p = sys.argv[1]
d = json.load(open(p))
att = {a.get("tx_hash"): a for a in d["attempts"] if a.get("tx_hash")}
cov = [x for x in d["bazaar_coverage"] if x["status"] != "excluded"]
bought = [x for x in cov if x["status"].startswith("bought")]
delivered = [x for x in bought if x["status"] in ("bought_delivered", "bought_earlier_2026-10-22")]
def inconclusive(x):
    a = att.get(x["detail"].split(":")[0].strip(), {})
    return a.get("http_status") in (0, None) and (a.get("fetch_error") or a.get("outcome") == "settled_response_lost")
nd = [x for x in bought if x["status"] == "bought_not_delivered"]
inc = [x for x in nd if inconclusive(x)]
out = {"hosts_total": len(cov), "hosts_checked": len(cov), "hosts_bought": len(bought), "delivered": len(delivered),
       "not_delivered": len(nd) - len(inc), "inconclusive": len(inc), "inconclusive_hosts": sorted(x["host"] for x in inc)}
print(json.dumps(out, indent=1))
