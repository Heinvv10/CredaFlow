# Handoff — 2026-10-17 08:00 SAST

**Project:** CredaFlow
**Branch:** nothing open from this session; `origin/main` = `6cd882d9`. Worktrees removed, IT containers torn down.
**Session goal:** (1) CredaFlow favicon in the staff app, client portal and website; (2) reference rates update automatically.

## Status: all MERGED
- **#132 favicon** (2026-10-16 15:14Z): `app/favicon.ico` (16/32/48) + `public/icon.svg` + `public/apple-touch-icon.png`, declared in `app/layout.tsx` `icons`; allowlisted pre-login in `lib/proxy/static-image.ts`. Built from `CredaFlow-marketing/brand/ci/logo/credaflow-mark.svg`.
- **#135 SARB reference-rate feed** (2026-10-16 16:33Z): weekday cron `30 8 * * 1-5` SAST, `app/api/cron/reference-rate-feed`, registry `lib/registry/cron-jobs/050-asset-finance.ts`.
  - Source: `custom.resbank.co.za/SarbWebApi/WebIndicators/HomePageRates` — MMRD002A→REPO, MMRD000A→PRIME, MMRD855A→ZARONIA. JIBAR / LENDER_BASE stay manual (no free JIBAR source).
  - Hein's decisions: fetched values land **PENDING** (source `SARB_FEED`, null requester), loan admins get a `REFERENCE_RATE_FEED_PENDING` bell, **one** approver suffices (manual still needs two). Repo/Prime recorded on any change; ZARONIA only on a ≥25bp move.
  - Skips: matching pending feed row, same value last REJECTED, stale observation, future date (SAST); P2002 = already recorded. Only tenants with `featureAssetFinance`.
  - Migration `20261016130000_reference_rate_sarb_feed`: enum `ReferenceRateSource` + `source` column (immutable via lifecycle trigger), nullable `requestedById`, CHECK `ReferenceRate_requester_source`, four-eyes CHECK rewritten with `IS DISTINCT FROM`.
  - Verified: full gates (18186 unit, 2762 IT), real-feed smoke on seeded DB (REPO 7.25%, ZARONIA 7.097% pending; PRIME unchanged; rerun idempotent), 5-reviewer team SHIP incl. fix commit a3210ad8.
- **#136 bell light theme** (2026-10-16 16:44Z): `NotificationBell.tsx` panel uses `var(--cf-bg-panel)`; browser-checked in light and dark.

## Open — Hein to decide
- ~~Tenant favicon override~~ — Hein 2026-10-17: keep the CredaFlow favicon for all tenants for now (`TenantConfig.faviconUrl` stays unused).

## Known follow-ups (not started)
- Feed `effectiveDate` is the observation date, may trail the real MPC change (UI tells approvers to check it).
- A never-approved far-future MANUAL pending row makes the feed treat every value as stale.
- Same-date manual vs feed conflict is silent; PENDING feed rows can stack up; past feed dates unbounded.
- A feed outage alerts no lender staff (only audit row, 503, stale heartbeat).
- Table shows ZARONIA 7.10% while 7.097% is stored; rates table scrolls horizontally on mobile.
- Reviewer nit: log `error.code` alongside the error name.
- Bell: read items `opacity-60` push muted text below AA on white (pre-existing).

## Demos
Tsela and Fair Score have asset finance on, so once rebuilt they get feed rows + bells each weekday until the nightly restore. They have the code only after a rebuild (another session was rebuilding both from ba16fbc3 on 2026-10-16 night). No demo work done here.
