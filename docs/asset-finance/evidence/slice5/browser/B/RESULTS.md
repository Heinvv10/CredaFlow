# Slice 5 part B browser results

Final verdict PASS. Screenshots: `round2/` (full re-acceptance, head 5e7c0acd), `round3/` (recheck of the round-2 defects).

## Round 2

Steps 1–10 PASS; BR1–BR8 PASS; verify-meter control PASS; portal source label PASS. Screenshots: `round2/`.
Defects:
1. Low: REMOVED device still shows amber TRACKER ID MISMATCH hint (11a). Hide for removed devices.
2. Low: "Meter verified <date>" shows neither who nor the note (11b).
3. Low: README step 6 wording: before any purpose the panel shows the generic PURPOSE_REFUSAL; "This loan is not in default." appears once a legal matter is open (06a/06b).
4. Low, not this PR: GET /api/cron/asset-finance-rate-notices 500 TenantScopeError missing-context on AssetFinanceRateNotice.findMany (in-process scheduler, commit 693aa800). Own ticket.
5. Info: refused Accept / 403 refusals write no audit row.
6. Info: stale localhost cookies across dev ports -> JWTSessionError after AUTH_SECRET change.
Disclosed SQL assists on throwaway DB: reset held reading with trigger disabled for 390px photo; loan DEFAULTED by SQL; portal password hash; non-simulated device inserted.
