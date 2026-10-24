# Per-endpoint Watch plans: launch notes (branch monitor-per-endpoint, NOT deployed)

## Plans
| id | price | checks | test-buys | per-buy cap | extras |
|---|---|---|---|---|---|
| watch | $5 / endpoint / 30 d | hourly | weekly | $0.05 | badge, status page |
| watch_plus | $12 / endpoint / 30 d | every 30 min (15-30 band) | daily, rotating chains | $0.10 | schema + p95 alerts, 90-day history |
| watch_pro | $20 / endpoint / 30 d | every 15 min | daily on up to 3 chains | $0.10 | monthly signed report |
| audit | $99 one-off (unchanged) | | | | |
| watch_free | $0, 1 endpoint | daily | none | | no badge, label "free tier, no test-buys" |
| watch_plus_trial | $0, 14 days, up to 3 endpoints | as Watch Plus | daily, $0.25 total cap (Lumi-funded) | | one per seller, freezes read-only, never converts |

Price = per-endpoint price x N endpoints (N <= 20). 10+ endpoints -20 %, 3 prepaid terms -10 % (stack multiplicatively: 28 % off).
No auto-renew; terms stack (a new purchase starts when the current block ends). Test-buy budget per term = 50 % of the fee actually paid.

## Deploy checklist (needs the owner's yes; ship together with the seller pitch emails)
1. `wrangler d1 migrations apply lumi_trust --remote` with migrations/0023_monitor_watch.sql (additive). Renumber first if another branch lands 0023.
2. `wrangler deploy` (no wrangler.toml / plan change, no new bindings, no new cron).
3. Schedule the box probe: `tools/monitor_probe.ts` every 15 min with MONITOR_PROBE_POST=1 (one owner POST per run, upserts ~1 D1 row per endpoint per day).
4. Update the site (separate repo): see "Site changes".

## Retiring legacy monitor ($9) / monitor_plus ($29) later
Set `retired: true` on PLANS.monitor / PLANS.monitor_plus: subscribe answers 410 (never charged), pay links disappear, existing rows run to term end.
After the last legacy row ends, remove the ids from MONITOR_PLANS / PLAN_ORDER / discovery and the a2a/mcp text.
