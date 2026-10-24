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

Price = per-endpoint price x N endpoints (N <= 20). 10+ endpoints -20 %, 3 prepaid terms -10 %. The discounts do NOT stack: when both apply only the larger (-20 % volume) is used.
No auto-renew; terms stack (a new purchase starts when the current block ends). Test-buy budget per term = 50 % of the fee actually paid.
Watch Pro budget check at -20 %: fee $16 / endpoint / term, budget $8.00; worst case 30 daily buys x 3 chains x $0.10 cap = $9.00 (over by $1.00).
At list price ($10 budget) and at -10 % prepay ($9 budget) the worst case fits. At -20 % the enrolment gate (planned spend <= budget) rejects
endpoints priced near the cap (average per-buy price above ~$0.0889 on 3 chains); Watch ($2.00 budget vs $0.25) and Watch Plus ($4.80 vs $3.00) fit.

## Deploy checklist (needs Bobby's yes; ship together with the seller pitch emails)
1. `wrangler d1 migrations apply lumi_trust --remote` with migrations/0023_monitor_watch.sql (additive). Renumber first if another branch lands 0023.
2. `wrangler deploy` (no wrangler.toml / plan change, no new bindings, no new cron).
3. Schedule the box probe: `tools/monitor_probe.ts` every 15 min with MONITOR_PROBE_POST=1 (one owner POST per run, upserts ~1 D1 row per endpoint per day).
4. Update the site (separate repo): see "Site changes".

## Retiring legacy monitor ($9) / monitor_plus ($29) later
Set `retired: true` on PLANS.monitor / PLANS.monitor_plus: subscribe answers 410 (never charged), pay links disappear, existing rows run to term end.
After the last legacy row ends, remove the ids from MONITOR_PLANS / PLAN_ORDER / discovery and the a2a/mcp text.
