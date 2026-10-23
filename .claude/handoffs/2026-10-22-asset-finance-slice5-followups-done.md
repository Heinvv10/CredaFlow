# Asset finance slice 5 follow-ups — done (dealer D, telematics T, commission W)

Goal: `.claude/handoffs/2026-10-22-asset-finance-slice5-followups-goal.md` (untracked; main checkout only).
Spec, decisions, deviations, rule-to-test matrices and known limitations per part:
`docs/asset-finance/SLICE5-FOLLOWUPS.md`. Mutation evidence:
`docs/asset-finance/evidence/slice5-followups/MUTATIONS.md`. Browser seeds, steps, results and screenshots:
`docs/asset-finance/evidence/slice5-followups/browser/{D,T,W}/`. Fingerprint proof for W:
`docs/asset-finance/evidence/slice5-followups/commission/`.

## What merged

| Part | PR | Merge | Head |
|---|---|---|---|
| D dealer: consent v2 (remote signing), dealer draft cancel, 90-day draft purge | #237 | 76d67783 | ae26208f |
| T telematics: THEFT purpose + SAPS report, SQL purpose gate, position trail, four-eyes meter-reading void, closure (task, portal notice, captured email, stored letter) | #238 | 4782bc9d | 556baa51 |
| W commission disclosure on dealer/broker deals (ISA, leases, NCA quote + agreement) | #239 | a14373b4 | 0d77955b |

Every PR: `npm run ci:full` green on its final head; blind reviews (code, security/breaker,
tests, architecture on Opus, SA legal, edge tester in its own clone) all SHIP on the final
round; browser acceptance PASS; merged via `mq`; ancestry and tree identity verified.
Review rounds: T 3 (legal and architecture SHIP at 2), W 3. W final: ci:full 469/471 suites green (2 opt-in skipped) on 0d77955b; merge tree identical. W touched no amounts, so no tax review.

## Needs Hein / the lender

- **Demo and Fairscore stacks were NOT redeployed or re-baked (§8).** W bumps `SYSTEM_REVISION` to
  2026-10-22.1 and moves 8 template fingerprints, so after deploying, run
  `scripts/asset-finance/ensure-demo-templates.ts <slug> <admin1> <admin2>` on each demo lender (it re-approves the
  lapsed variants), then re-snapshot. D and T add migrations. After hours, with Hein's approval.
- **Real lenders re-approve their asset-finance templates** after W deploys (release event).
- **Counsel items:**
  - D: SLICE5-FOLLOWUPS part D "Known limitations" (remote-signing identity check wording; Reg 55: deals handed to
    the lender are not purged, their retention is the application's; DSAR wording still open).
  - T: closure-notice wording and THEFT/trail (part T decisions and limitations; SLICE5.md Part B counsel items 1–10
    updated where built).
  - W: part W "for the lender's counsel": may vs will when a rate is on record; offering the amount on request;
    printing when commission source is NONE; commission on the financed amount (conduct); CPA s27; supplier legal
    name vs dealer trading name; insurance commission scope; no rule found requiring the amount (MEDIUM).
- **NCA quotation wording approval is the `assetFinanceLegalWordingApproved` flag, not a fingerprint:** a lender
  that already set it prints the new commission section without DRAFT. No lender is live.

## Found on the way (not fixed here)

- **Local `ci:full` ran integration suites four at a time:** this machine exports `VITEST_MAX_WORKERS=4` /
  `VITEST_MAX_THREADS=4`, which override `--no-file-parallelism`, so real-DB suites deadlocked each other (main too).
  Fixed in #238: `scripts/run-integration-tests.sh` pins one worker. The integration gate now takes ~1 h serially.
- GitHub integration shard 2 on #238 failed once with "Worker exited unexpectedly" after all 155 suites passed;
  green on rerun.
- `withoutTenantScope` fails in the dev server for the closure cron (worked around by listing tenants through a
  relation filter); the rate-notices cron fails the same way (pre-existing, noted in the slice 5 handoff).
- The staff app has no button to issue the NCA quotation: only `POST /api/asset-finance/deals/<id>/nca-quote`.
- The staff deal page heads a BROKER "Dealer: …".
- Bug A from the slice 5 handoff still holds: preparing with today's start date when the first instalment is
  +2 months is refused "prepared term exceeds approved term" (the W browser README says to pick start = first due − 1 month).
- W limitations: an old issued document with a word wider than its line re-renders differently (wrapText now
  breaks it), so e-sign fails closed `document_changed`; a deal prepared before W deploys is signed without the
  clause; pinned signing needs the retained render input; dealer names of 81–160 chars stored before must be
  shortened (render refuses).
- T limitations: void-approval vs end-of-term invoice deadlock window (one aborts, retry); a later longer retention
  is not reflected in notices already logged; colluding staff can invent a SAPS case; a void approved by SQL
  directly is not audited.

## Cleanup

Worktrees `af-s5f-dealer`, `af-s5f-telematics`, `af-s5f-commission`, `ci-t` removed; branches deleted local and
remote; IT containers torn down (`it-db.sh down`); dev servers and the SMTP capture stopped by PID.
