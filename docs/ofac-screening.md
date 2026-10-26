# OFAC SDN screening of payTo addresses

Lumi never test-buys from an OFAC-listed address, never enrols or bills one for monitoring, and never returns anything
except `block` for one. Shipped to production on 2026-10-24 (merged into main with the free `/v1/check`).

## Source
- U.S. Treasury OFAC, Specially Designated Nationals (SDN) list, Advanced XML export:
  <https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_ADVANCED.XML>
  (public, no key; about 128 MB). Entries are the `Feature` elements whose FeatureType is
  `Digital Currency Address - <ASSET>`.
- `scripts/ofac_refresh.py` streams the XML (iterparse) and writes a compact JSON set:
  `evm` (every 0x address, lower-cased; ETH/USDC/USDT/ARB/BSC… all share one EVM key space), `xrpl` (r-addresses on
  `- XRP` features), `stellar` (G keys). Other formats (BTC, TRX, SOL, XMR…) are counted and skipped, because Lumi
  pays only on Base, XRPL and Stellar. The script fails closed: fewer than 50 EVM entries means it keeps the old file.
- Snapshot in this branch: `data/ofac_sdn_addresses.json`, publication date 2026-10-21: 124 EVM, 1 XRPL
  (`rnXyVQzgxZe7TR1EPzTkGj2jxH4LMJYh66`), 0 Stellar, 932 other-format addresses skipped.

## Normalisation (`src/sanctions_addr.ts`)
- EVM: lower-case. CAIP prefixes (`eip155:8453:`) are stripped.
- XRPL: case-sensitive base58. `r…:tag` and `r…?dt=` map to the classic address, and X-addresses (main or test)
  decode to the classic address.
- Stellar: upper-case. Muxed `M…` decodes to its `G…` account, and a bad checksum is rejected.

## Worker side (`src/sanctions.ts`, no D1)
- The bundled snapshot becomes a `Set` once per isolate, so each lookup is O(1) with no table and no per-request read.
- There is an optional KV copy: binding `SANCTIONS_KV`, key `ofac_sdn_addresses`, same JSON. It is read at most once
  every 6 hours per isolate and **unioned** with the snapshot, so a refresh can add entries but never silently drop
  one. The KV binding is not in wrangler.toml (creating it needs approval). Without it, the list refreshes through a
  commit and a deploy.
- Hooks (refusals log `{event:"sanctioned_address_refused", where, address, …}`):
  - `/v1/trust/check` (`trustVerdict`): the quoted payTo, or any payTo Lumi has on record for the resource, gives
    `verdict: "block"` and the first reason `sanctioned_address`.
  - `buyCandidate`: a sanctioned verdict never enters the test-buy queue.
  - `GET /v1/trust/catalog/buy-queue` (owner): rows whose listing pays a listed address are withheld and returned under
    `refused`.
  - Monitor:
    - `/v1/monitor/challenge`, enrol (proof address and quoted payTos), and subscribe (before any 402 or settlement)
      all return 403 `sanctioned_address`, "Not charged".
    - `/v1/owner/monitor/due` skips listed enrolments.
- Post-buy evidence POSTs are still accepted, because they record what already happened.

## Box side
- `scripts/ofac_refresh_daily.sh` writes `~/.lumi/ofac/ofac_sdn_addresses.json` (or `$LUMI_OFAC_DIR`) and appends to
  `refresh.log`. Use `--once` for a single run (schedule it daily); with no argument it loops every 24 hours
  (flock single-instance).
- `scripts/ofac_guard.ts` exports `assertPayToAllowed(payTo, where)`, which the runners call right before paying. It
  reads the union of the box copy and the repo snapshot, appends refusals to `~/.lumi/ofac/refused.log`, and fails
  closed when no list loads.
- The test-buy runners (catalog, daily XRPL and Stellar, and monitor runs) must call the guard before every payment; that wiring lives outside this repo and is not yet confirmed.

## Free pre-pay check (`/v1/check`, Lumi Check)
- `freeCheck` goes through the same `checkVerdict` / `payToVerdict` helpers as `/v1/trust/check`, so a listed `payTo`
  (quoted, or on record for the resource) returns `verdict: "block"` with the first reason `sanctioned_address`, and the
  refusal is logged with `where: "free_check"`.
