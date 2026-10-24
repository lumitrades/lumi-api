#!/usr/bin/env python3
"""Refresh the OFAC SDN digital-currency address set used by Lumi's sanctions screen (src/sanctions.ts).

Source (official, public, no key): U.S. Treasury OFAC Sanctions List Service, SDN list, Advanced XML
  https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_ADVANCED.XML
Every "Digital Currency Address - <ASSET>" feature (FeatureTypeGroupID 1) is extracted. Only the address formats Lumi can
pay to are kept: EVM (0x + 40 hex, lower-cased: ETH, USDC, USDT, ARB, BSC, BNB, ETC ...), XRPL classic (r...) and
Stellar (G..., 56 chars). The output is a compact JSON file:
  {"source": ..., "fetched_at": ..., "publication_date": ..., "counts": {...}, "evm": [...], "xrpl": [...], "stellar": [...]}

Usage: scripts/ofac_refresh.py [--xml PATH] [--out data/ofac_sdn_addresses.json]
The output is written atomically and only when the parse found a sane number of addresses (fail closed: keep the old file).
"""
import argparse, datetime, json, os, re, sys, tempfile, urllib.request
import xml.etree.ElementTree as ET

URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_ADVANCED.XML"
EVM = re.compile(r"^0x[0-9a-fA-F]{40}$")
XRPL = re.compile(r"^r[1-9A-HJ-NP-Za-km-z]{24,34}$")
STELLAR = re.compile(r"^G[A-Z2-7]{55}$")
MIN_EVM = 50  # the list had 100+ EVM addresses on 2026-10-23; far fewer means a broken download or schema change


def local(tag):
    return tag.rsplit("}", 1)[-1]


def parse(path):
    feature_types = {}  # id -> asset
    pub_date = None
    out = {"evm": set(), "xrpl": set(), "stellar": set()}
    other = 0
    for _ev, el in ET.iterparse(path, events=("end",)):
        t = local(el.tag)
        if t == "FeatureType" and (el.text or "").startswith("Digital Currency Address - "):
            feature_types[el.get("ID")] = el.text.split(" - ", 1)[1].strip()
        elif t == "DateOfIssue" and pub_date is None:  # first one is the publication header
            ymd = {local(c.tag): c.text for c in el}
            if {"Year", "Month", "Day"} <= ymd.keys():
                pub_date = f"{int(ymd['Year']):04d}-{int(ymd['Month']):02d}-{int(ymd['Day']):02d}"
        elif t == "Feature":
            if el.get("FeatureTypeID") in feature_types:
                for vd in el.iter():
                    if local(vd.tag) == "VersionDetail" and vd.text:
                        a = vd.text.strip()
                        if EVM.match(a):
                            out["evm"].add(a.lower())
                        elif STELLAR.match(a):
                            out["stellar"].add(a)
                        elif XRPL.match(a) and feature_types[el.get("FeatureTypeID")] == "XRP":
                            out["xrpl"].add(a)
                        else:
                            other += 1
            el.clear()
        elif t in ("DistinctParty", "Profile"):
            el.clear()
    if not feature_types:
        raise SystemExit("no 'Digital Currency Address' feature types found: schema change?")
    return pub_date, sorted(feature_types.values()), {k: sorted(v) for k, v in out.items()}, other


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--xml", help="parse a local SDN_ADVANCED.XML instead of downloading")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "ofac_sdn_addresses.json"))
    a = ap.parse_args()
    path = a.xml
    tmp = None
    if not path:
        fd, tmp = tempfile.mkstemp(suffix=".xml")
        os.close(fd)
        req = urllib.request.Request(URL, headers={"User-Agent": "lumi-ofac-refresh/1"})
        with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        path = tmp
    try:
        pub, assets, sets, other = parse(path)
    finally:
        if tmp:
            os.unlink(tmp)
    if len(sets["evm"]) < MIN_EVM:
        raise SystemExit(f"only {len(sets['evm'])} EVM addresses parsed (< {MIN_EVM}); keeping the existing file")
    doc = {
        "source": URL,
        "source_name": "U.S. Treasury OFAC SDN list (Advanced XML), Digital Currency Address features",
        "publication_date": pub,
        "fetched_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "assets_on_list": assets,
        "counts": {k: len(v) for k, v in sets.items()} | {"other_formats_skipped": other},
        **sets,
    }
    out = os.path.abspath(a.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    fd, t = tempfile.mkstemp(dir=os.path.dirname(out), suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(doc, f, separators=(",", ":"))
        f.write("\n")
    os.replace(t, out)
    print(json.dumps({"out": out, "publication_date": pub, "counts": doc["counts"]}))


if __name__ == "__main__":
    sys.exit(main())
