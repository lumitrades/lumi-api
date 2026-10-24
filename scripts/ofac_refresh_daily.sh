#!/usr/bin/env bash
# Box-side daily refresh of the OFAC SDN digital-currency address set (public data, no secrets, no network writes
# other than the download). Writes $LUMI_OFAC_DIR/ofac_sdn_addresses.json (default ~/.lumi/ofac), which the
# test-buy runners read through scripts/ofac_guard.ts. Refreshing the Worker's copy is separate: either commit the
# new data/ofac_sdn_addresses.json and deploy, or (with approval) `wrangler kv key put` it into SANCTIONS_KV.
#
#   scripts/ofac_refresh_daily.sh --once     # one refresh now
#   scripts/ofac_refresh_daily.sh            # loop: refresh, then every 24 h (single instance via flock)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dir="${LUMI_OFAC_DIR:-$HOME/.lumi/ofac}"
mkdir -p "$dir"
log="$dir/refresh.log"
run() {
  if out="$(python3 "$here/ofac_refresh.py" --out "$dir/ofac_sdn_addresses.json" 2>&1)"; then
    echo "$(date -u +%FT%TZ) ok $out" >>"$log"
  else
    echo "$(date -u +%FT%TZ) FAILED (kept previous file): ${out//$'\n'/ }" >>"$log"
  fi
}
if [[ "${1:-}" == "--once" ]]; then run; tail -1 "$log"; exit 0; fi
exec 9>"$dir/refresh.lock"
flock -n 9 || { echo "already running"; exit 0; }
while true; do run; sleep 86400; done
