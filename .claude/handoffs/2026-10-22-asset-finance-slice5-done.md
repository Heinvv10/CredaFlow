# Asset finance slice 5 — done (dealer portal, telematics, valuation guides)

Goal: `.claude/handoffs/2026-10-19-asset-finance-slice5-goal.md` (untracked; in the main checkout only). Spec, deviations,
rule-to-test matrices, known limitations and review items per part:
`docs/asset-finance/SLICE5.md`. Mutation evidence: `docs/asset-finance/evidence/slice5/MUTATIONS.md`.
Browser seeds, steps and results: `docs/asset-finance/evidence/slice5/browser/{B,C}/` (README, RESULTS.md, screenshots); Part A: `browser/A/README.md`.

## What merged

| Part | PR | Merge | Notes |
|---|---|---|---|
| A dealer/broker portal + commission | #216 | 715b299f | |
| CI integration timeout 30 → 45 min | #221 | 0d29dddc | |
| CI integration timeout 45 → 75 min | #230 | ebb21568 | 440 gated suites; a green #222 run was cancelled at 45 |
| CI quality timeout 30 → 45 min | #231 | d4703980 | unit + build reached 29.5 min |
| B telematics adapter + simulator | #222 | d24b48b8 | head 668b40e8 |
| C valuation guides (CSV + provider adapter) | #229 | 51ab0697 | head 01cd849e |

Every PR: `npm run ci:full` green on its final head (fresh clone), blind reviews
(code, breaker, tests, architecture, legal, edge) all SHIP on the final round, browser
acceptance PASS (§5), merged via `mq`. B and C screenshots are committed under
`evidence/slice5/browser/`; Part A's were never committed and are lost (`browser/A/README.md`).
Review rounds: A 2, B 5 (the last a confirmation), C 3.

## Needs Hein / the lender before a lender switches anything on

- **Part A legal items 1–7 and tax items a–g:** SLICE5.md Part A "Review items".
- **Part B counsel items 1–10:** SLICE5.md Part B "Review items". Among them:
  - positions are POPIA location data;
  - PENDING_WRITE_OFF counts as covering and as default (item 2);
  - erasure: a position can be erased at any time, an event only once past retention and unreferenced (item 5);
  - there is no void path for a tracker meter reading (item 6).
- **Part C:**
  - May a guide value stand as the NCA s127/s131 estimate? Until counsel says yes, the DB refuses GUIDE there, fail-closed.
  - The guide VAT basis must be settled before that.
  - The licensing terms of any commercial guide a lender loads.
  - Credit policy: the trade-value basis and LTV thresholds (none enforced).
- No real telematics or valuation provider is wired. Both run as simulated or synthetic providers only (§8).

## Known limitations (accepted; details in SLICE5.md)
- **B:**
  - The retention floor at ingest also refuses genuinely late events under a short retention setting (pinned by a test).
  - SQLSTATE 57014 (statement timeout) is transient, so a statement that times out every time retries for ever.
  - A device stops being polled once no agreement covers "now", so an outage spanning the asset's return loses its tail events.
  - There are no per-tenant provider credentials yet.
  - DSAR for telematics data is manual.
- **C:**
  - Matching is textual on make, model and year (no M&M code), and inner whitespace is not folded.
  - The Greek final sigma gives a safe-side false duplicate refusal.
  - The DB four-eyes check doesn't check the publisher's permission (TS gate only).
  - The revaluation report is unbounded, and its LTV is principal-only.
  - **Rollback hazard:** once a GUIDE valuation exists, an older app image breaks on the enum value.
  - The static guard check misses `FUNCTION "public"."guardRecovery"` and lowercase spellings; the real-PG statutory test backstops it.
- Test LOW survivors left:
  - B: the `DRIVER_SQLSTATE` anchoring, and the `sqlStateOf` cause depth;
  - C: the CSV 1950/2100 year boundaries.

## Follow-ups found on the way (not fixed here)
- **Bug A (pre-existing):**
  - A deal starting today with the first instalment due in +1 month fails "prepared term exceeds approved term".
  - A future start date blocks receipts.
  - The staff payment form shows only a generic error.
- `GET /api/cron/asset-finance-rate-notices` returns 500 `TenantScopeError missing-context` on `AssetFinanceRateNotice.findMany`, from the in-process scheduler (seen in the B browser run; the file was untouched by slice 5).
- **The shared `ruleRefuses` false-pass risk:** with Prisma's default errorFormat, the code frame can make a refusal regex match its own source. The telematics suites use `telematicsTestClient()` (errorFormat "minimal"); other suites may carry the same risk.
- **Oversized files:**
  - `app/(dashboard)/loans/[id]/page.tsx` is 387 lines;
  - the selfie `route.test.ts` is 338 lines.
- **From PR #216 review:**
  - the client page's verify button;
  - the wet-ink CONTRACTED path completing before contact verification (SLICE5 Part A known limitations).
- GitHub Actions stopped starting jobs on 2026-10-21 (failed payment / spending limit) until Hein fixed billing; #222 then failed once on a clock-dependent test (heartbeats before 06:00 SAST), fixed in 668b40e8.
- The integration job keeps growing (29 → 37+ min in a day). Unit tests are now sharded (#232/#233); shard integration next rather than raise the timeout again.
- **Migration checksums:** 20261019120400 and 20261019120600 (Part A) were rewritten after their first push. Only throwaway DBs ever applied them. Any DB that applied the old versions needs a reset, not `migrate deploy`.
- **Demo stacks:** after any upgrade that keeps the DB, run `scripts/asset-finance/ensure-demo-templates.ts` (a note from a peer session). Slice 5 adds migrations; the demo and Fairscore stacks were NOT redeployed (§8; needs Hein, after hours).
