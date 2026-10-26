# Per-endpoint Watch plans: launch notes (branch monitor-per-endpoint, NOT deployed)

## Plans
| id | price | checks | test-buys | per-buy cap | extras |
|---|---|---|---|---|---|
| watch | $5 / endpoint / 30 d | hourly | weekly | $0.05 | badge, status page |
| watch_plus | retired 2026-10-25 (was $12 / endpoint / 30 d); existing terms run to their end | every 30 min | daily, rotating chains | $0.10 | replaced by the test-buy packs |
| retest_pack | $6.50 one-off, 30 test-buys, valid 12 months | | seller-queued, one per endpoint per UTC day | $0.10 | "Fixed something? Get re-tested now" |
| founder_pack | $5 one-off, 24 test-buys, valid 12 months | | seller-queued, one per endpoint per UTC day | $0.10 | first 10 sellers, one place per company, rebuy up to 12 times |
| watch_pro | $20 / endpoint / 30 d | every 15 min | daily buys on up to 3 chains, limited by the test-buy budget | $0.10 | monthly signed report |
| audit | $99 one-off (unchanged) | | | | |
| watch_free | $0, 1 endpoint | daily | none | | no badge, label "free tier, no test-buys" |
| watch_plus_trial | $0, 14 days, up to 3 endpoints | Watch Plus quote checks (every 30 min) | daily, limited to $0.25 in total (Lumi-funded), so only a few buys | | one per seller, never converts; day 14: see below |

Price = per-endpoint price x N endpoints (N <= 20). 10+ endpoints -20 %, 3 prepaid terms -10 %. The discounts do NOT stack: when both apply only the larger (-20 % volume) is used.
No auto-renew; terms stack (a new purchase starts when the current block ends). Test-buy budget per term = 50 % of the fee actually paid.
Watch Pro budget check at -20 %: fee $16 / endpoint / term, budget $8.00; worst case 30 daily buys x 3 chains x $0.10 cap = $9.00 (over by $1.00).
At list price ($10 budget) and at -10 % prepay ($9 budget) the worst case fits. At -20 % the enrolment gate (planned spend <= budget) rejects
endpoints priced near the cap (average per-buy price above ~$0.0889 on 3 chains); Watch ($2.00 budget vs $0.25) and Watch Plus ($4.80 vs $3.00) fit.

## Free trial (the only trial offer)
One version everywhere: a 14-day Watch Plus trial, once per seller, for up to 3 endpoints, after the domain and payTo wallet are proven.
Watch Plus quote checks every 30 min; Lumi-funded test-buys limited to $0.25 in total.
**Day 14:** nothing is charged (no payment method is ever stored), checks and test-buys stop, the Monitored badge comes off, and the
history freezes read-only (the status page shows "Trial ended <date>, not monitored"). It never converts to a paid plan.

The 60-day complimentary Watch pilot in the earlier offer notes is a different, earlier thing: the invite-only badge pilot for
14 sellers. It is not a public offer and not this trial.

## Badge labels
Paid plans: "Monitored by Lumi · paid plan" on the SVG and in the JSON (`paid: true`). Trial: "Monitored by Lumi · free trial" (`paid: false`).
Lumi's own test enrolment: "Lumi test enrolment". Free tier: no badge.

## Deploy checklist (needs owner approval)
1. `wrangler d1 migrations apply lumi_trust --remote` with migrations/0025_monitor_watch.sql (additive; renumbered from 0023 at the 2026-10-24 release).
2. `wrangler deploy` (no wrangler.toml / plan change, no new bindings, no new cron).
3. Schedule the box probe: `tools/monitor_probe.ts` every 15 min with MONITOR_PROBE_POST=1 (one owner POST per run, upserts ~1 D1 row per endpoint per day).
4. Update the site (separate repo): see "Site changes".

## Legacy monitor ($9) / monitor_plus ($29): retired 2026-10-25
`retired: true` is set on PLANS.monitor / PLANS.monitor_plus. Their subscribe paths answer 410 plan_retired before any quote
(never charged, also with a payment header), they are gone from PLAN_ORDER (well-known, OpenAPI, root plans, bazaar) and from
enrolment pay links and planEconomics. Rows bought before the retirement keep working to their term end (probes, test-buys,
status page, badge). The Watch tiers, Audit and the free tier are unchanged.
After the last legacy row ends, remove the ids from MONITOR_PLANS, PlanId, MONITOR_LIMITS and the scheduler branches.
