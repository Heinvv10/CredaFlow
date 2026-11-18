# /goal — Asset finance slice 5 follow-ups: 7 review-item decisions (run autonomously until DONE)

## Start a new session

Start on **Opus** in `/home/hein/Workspace/CredaFlow` and paste:

> /goal Execute .claude/handoffs/2026-10-22-asset-finance-slice5-followups-goal.md to completion. Work autonomously through Spec → Build (TDD) → Integrate → Acceptance → independent Review → Fix loops, one PR per part (§3 D, T, W, in that order). Do not stop to ask except at a Confirmation Gate (§8) or a genuine external blocker. Prove every Success Criterion (§7), merge each PR through mq, write the handoff and memory update, clean up your worktrees, branches and containers, then stop.

This file prepares a future session; it does not start implementation.

## §1 Mission

Slice 5 (dealer portal #216, telematics #222, valuation guides #229) is merged.
Its review items went to Hein on 2026-10-22, and he decided seven of them
(§2a). This goal builds those seven, in three PRs:

- **D. Dealer:** consent wording that allows remote signing; dealers can cancel
  drafts; a 90-day purge of abandoned or declined dealer drafts.
- **T. Telematics:** a THEFT position purpose; a position trail instead of
  latest-only; a four-eyes void for a wrong meter reading; at closure, a staff
  removal task plus a borrower notice (portal, message, PDF letter).
- **W. Wording:** a commission disclosure line on the asset-finance quote and
  agreement templates.

"Built" means:
- real DB rows and enforcement, with DB rules proven by real-PG tests that fail
  when a rule is removed;
- real routes with RBAC and audit;
- a real UI;
- browser acceptance with screenshots, **committed** under
  `docs/asset-finance/evidence/slice5-followups/browser/<part>/`. Slice 5's
  Part A screenshots were lost because they lived only in a scratchpad.

No real provider, no real money, no real message (§8).

## §2 Verified starting point (2026-10-22, origin/main e5ae8f30). Re-check live.

- **Read first:**
  - `docs/asset-finance/SLICE5.md`: Known limitations and Review items for Parts A, B and C, plus Part B's Deviations 3, 14, 15 and 16;
  - `.claude/handoffs/2026-10-22-asset-finance-slice5-done.md`;
  - `lib/asset-finance/.claude.md`, `lib/dealer/.claude.md` and `lib/telematics/.claude.md`;
  - `docs/asset-finance/evidence/slice5/MUTATIONS.md` for the mutation-evidence format.
- **Shared checkout:**
  - `/home/hein/Workspace/CredaFlow` is dirty and shared. Never reset, stash, clean, pull into or commit from it, and never touch `.claude/handoffs/LATEST.md`.
  - Work in your own worktrees, each with its own `npm ci --legacy-peer-deps`.
  - Run the collision check first (`git worktree list`, `gh pr list`, `mq status`).
- **Dealer consent:**
  - `lib/dealer/consent.ts` holds `DEALER_CONSENT_STATEMENT` and `DEALER_CONSENT_VERSION = "dealer-consent-v1"` (marked `// UNTESTED: legal`).
  - `attestDealerConsent` snapshots `statementVersion` and `statementText` onto each `DealerConsentAttestation`.
  - It is pinned in `lib/dealer/dealer-submit.integration.test.ts`.
  - UI: `app/(dealer)/dealer/(signed-in)/deals/[id]/page.tsx` (`DealerConsentPanel`). Route: `app/api/dealer/deals/[id]/consents/route.ts`.
- **Dealer drafts:**
  - `createDealerDeal` is in `lib/dealer/deals.ts`; Client capture (`Client.createdByDealerId`) is in `lib/dealer/capture.ts`; documents are `EntityDocument` with `dealId` and `uploadedByType "dealer"` (`lib/dealer/documents.ts`).
  - `app/api/dealer/deals/[id]/route.ts` has GET only, so dealers cannot cancel.
  - There is no draft retention cron and no Client erasure helper. DSAR (`DataSubjectRequest`, `app/api/dsar/`) only tracks requests.
  - The existing retention crons to copy are `lib/registry/cron-jobs/070-lender-api.ts` and `140-asset-finance-telematics.ts`.
- **Telematics positions:**
  - `TelematicsPosition` is `@@unique([tenantId, deviceId])` (latest only), replaced in `lib/telematics/ingest.ts` by find, delete, create. `guardTelematicsPosition` allows DELETE and refuses UPDATE.
  - Purge: `lib/telematics/purge.ts` `purgeTelematicsPositions()`, under `TenantConfig.telematicsPositionRetentionDays` (default 90).
  - The purpose enum is `TelematicsPositionContext { DEFAULT, RECOVERY, LEGAL_MATTER }`.
  - The access log is `TelematicsPositionAccess`. Its SQL guard `guardTelematicsPositionAccess` (migration `20261020160100_telematics`) enforces append-only plus loan, asset and device matching, **but not purpose**.
  - The purpose gate is TypeScript only: `lib/telematics/position-purpose.ts` (`positionPurposes`, `positionRefusalFor`, `PURPOSE_REFUSAL`). Route: `app/api/asset-finance/loans/[loanId]/telematics/position/route.ts`.
- **Meter readings:**
  - `AssetMeterReading` (`prisma/schema/asset-finance-leases.prisma`) is immutable: `guardAssetMeterReading` (migration `20261014100000_asset_finance_lease_servicing`) plus `guardTelematicsMeterReading`.
  - There is no void column. Sources are `STAFF | PORTAL | TELEMATICS`.
  - Readings are picked as the start reading (earliest by readingDate, then value) in `lease-end-invoice.ts` and `meter-readings.ts`, and through `LeaseEndOfTerm.finalReadingId`. Meter verification is Deviation 16.
- **Closure:**
  - `Loan.closedAt` and `COMPLETED` are set in `lib/loan/apply-payment.ts`, `lib/asset-finance/lease-end-invoice.ts` and `lib/asset-finance/reprice-payoff-write.ts`.
  - Tracking stops through the SQL `telematicsLoanAt` (Deviation 14; test `lib/telematics/after-settlement.integration.test.ts`).
  - The only task model is `AgentTask` (`prisma/schema/crm.prisma`). There is no closure letter; the nearest PDF is `lib/pdf/certificateOfBalance.ts`.
  - Messaging: `lib/messaging/` (read its `.claude.md`: SMS is off by policy; consent and kill switches from #217).
- **Templates:**
  - `lib/asset-finance/documents/templates/families.ts` has `SYSTEM_REVISION = "2026-10-19.1"`, `ASSET_TEMPLATE_FAMILIES` and `LENDER_TEXT_KEYS`. Starter wording is in `content.ts`.
  - `fingerprint.test.ts` pins a sha256 for every key.
  - NCA variants are `af.nca.instalment_sale` and `af.nca.finance_lease` (protected clauses only). The NCA quote is `lib/asset-finance/documents/nca/quote-pdf.ts` with `wording/nca-quote.ts`.
  - `validate.ts`'s `OVERRIDING` regex refuses the word "commission" in lender text.
  - No document has any commission or intermediary disclosure today.
  - A protected-wording change moves fingerprints and lapses every lender's approval, which is a release event. Demo lenders re-approve via `scripts/asset-finance/ensure-demo-templates.ts`.
- **IT gates and migrations:**
  - The real-PG suite variables are `RUN_ASSET_FINANCE_DEALER_IT` and `RUN_ASSET_FINANCE_TELEMATICS_IT`.
  - The latest migration is `20261021090300_valuation_guide_review_fixes`.

## §2a Product decisions (Hein, 2026-10-22). Build as written.

If evidence shows a default here is wrong, record why in the spec, choose the
safer option, and flag it in the handoff, without stopping.

1. **Remote consent signing is allowed.** Write `dealer-consent-v2` wording that is true both for in-person and for remote (e-)signing:
   - no "in my presence";
   - the dealer attests how it was signed (`IN_PERSON | REMOTE`, a new enum column on the attestation);
   - for REMOTE, how identity was checked.

   v1 attestations stay as they are (immutable snapshots). The wording merges on a blind SA-legal reviewer's SHIP (decision 7).
2. **Commission disclosure.** Add a plain protected clause to the commercial ISA, commercial lease and NCA quote and agreement variants, saying the lender may pay the dealer or broker a commission from its own funds and that it is not part of the borrower's charges or cost of credit:
   - The amounts do not change. Never add commission to the borrower's charges or cost of credit.
   - Bump `SYSTEM_REVISION`, re-pin `fingerprint.test.ts` with a proof of what changed, and run `ensure-demo-templates` in the tests.
   - The DEALER channel only, or every deal? **[agent decides; recommended: every deal that has a dealer, and no clause on a non-dealer deal]**.
3. **THEFT position purpose:**
   - Add `THEFT` to `TelematicsPositionContext` (an additive enum value).
   - Usable on a loan in good standing only with a recorded theft report: a SAPS case number (format-checked) plus the date reported. The report is audited and visible on the loan.
   - Valid for 30 days unless renewed (**[agent decides the window; recommended 30]**).
   - Same roles as today (COLLECTIONS_OFFICER+); READONLY, INSURANCE_OFFICER and dealers are refused.
   - **Move the purpose gate into SQL:** an access row must name a purpose that holds at insert time. Today it is TS only.
4. **Position trail:**
   - Keep every position for the retention period: drop the per-device unique and append. Retention and purge stay as they are, per position.
   - The view shows the latest position by default. The trail (a time-ordered list, optionally a map with no external tile calls) is shown only under THEFT, RECOVERY or LEGAL_MATTER, and each trail view writes an access row.
   - Migration: replacing the unique index is non-additive DDL, but it is on new tables with no production data. Ship it with its code. It is NOT a §8 gate, because no shared or production DB exists; never apply it to a shared DB by hand.
5. **Meter-reading void:**
   - A four-eyes, audited void of any meter reading (STAFF, PORTAL or TELEMATICS) with a reason. One staff user requests and another approves, with the CHECK in the DB.
   - A voided reading is ignored by monotonic checks, start-reading selection, excess projection and end-of-term billing.
   - Refused once the reading is referenced by an issued end-of-term invoice or `LeaseEndOfTerm.finalReadingId`.
   - The row stays; it is never deleted or edited apart from the void fields, and the trigger allows only that transition.
   - The portal shows a voided reading as voided.
6. **At closure (Loan COMPLETED/closedAt with an active TrackerDevice):**
   - (a) a staff task to remove or deactivate the device, using `AgentTask` or a dedicated table **[agent decides]**;
   - (b) a client portal notice that tracking has stopped;
   - (c) an outbound message through the existing messaging path, honouring consent and kill switches;
   - (d) a stored PDF "tracking stopped" letter on the loan.

   Each happens once per device, idempotently, from all three closure paths. (c) is built and tested against the simulated or captured transport only. Turning on a real send is a §8 gate. The wording of (b), (c) and (d) merges on legal SHIP.
7. **Wording gate:** the new consent, commission and closure-notice wording may merge once a blind SA-legal reviewer says SHIP (as with #164). Real lenders still approve their own templates before go-live.
8. **Dealer drafts:**
   - Dealers (DEALER_ADMIN, or the DEALER_SALES user who created the draft) may cancel their own DRAFT deals, with a reason, audited. Staff can already cancel.
   - A daily purge cron deletes the dealer-captured Client data and documents of deals that have been DRAFT with no activity for 90 days, or CANCELLED or DECLINED for 90 days.
   - Not purged: a deal that became a loan, and a Client linked to any other deal, application or loan.
   - The audit row and a tombstone (deal id, purge date, counts) remain.
   - Purge logic (delete versus anonymise, for rows FK-referenced by audit or consent attestations) **[agent decides; prefer anonymise-in-place for referenced rows and delete for the rest]**.
   - Prove on real PG that a booked deal's data is never touched.
9. **Not built (record only):**
   - LTV stays display only.
   - GUIDE is still refused as the s127/s131 estimate.
   - Commission input VAT stays 100% (the accountant adjusts on the VAT201), and commission stays expensed at booking.
   - The counsel-only items stay open in SLICE5.md: POPIA operator agreements, s57 prior authorisation, drivers of juristic borrowers, the s18 notice text, s61 pricing discretion, and tax items a, c, d, e and g.

## §3 Scope per PR

Each PR does the following:
- Write a concise spec section and a rule-to-test matrix first, in a new `docs/asset-finance/SLICE5-FOLLOWUPS.md`, one section per part.
- Ship migrations together with the code that satisfies their triggers.
- Build TDD, with failing regressions first.
- Prove DB rules with real-PG suites.
- Record mutation evidence in `docs/asset-finance/evidence/slice5-followups/MUTATIONS.md`.
- Update SLICE5.md's Review items and Known limitations to mark what this PR decides or closes.

- **PR D (decisions 1 and 8):**
  - consent v2 with its signing method;
  - dealer draft cancel;
  - the draft purge cron (registered in `lib/registry/cron-jobs/`, gated by `CRON_SECRET`).

  Negative cases:
  - a v1 row altered;
  - REMOTE without an identity method;
  - a dealer cancelling another dealer's draft or a submitted deal;
  - the purge touching a booked deal or a shared Client;
  - the purge on a deal that was active within 90 days.
- **PR T (decisions 3 to 6):**
  - the THEFT purpose and the SQL purpose gate;
  - the position trail;
  - the meter void;
  - the closure task, notice, message and letter.

  Negative cases:
  - THEFT without a report, or with an expired one;
  - READONLY or a dealer viewing a position or the trail;
  - an access row inserted by SQL with no valid purpose;
  - the trail outliving retention;
  - a self-approved void;
  - voiding a billed or final reading;
  - a voided reading still counting toward excess or the monotonic floor;
  - closure firing twice;
  - a message sent with consent off or the kill switch on;
  - a real transport being used.
- **PR W (decision 2):** the commission clause on the asset-finance templates, re-pinned fingerprints, and demo re-approval.

  Negative cases:
  - the clause shown on a non-dealer deal (if so decided);
  - the NCA quote's cost-of-credit figures changing (pin them);
  - lender text using "commission" still refused.

## §4 Execution process

1. Collision check, then fetch origin/main.
2. Write the spec and matrix, then build TDD in an isolated worktree.
3. Run scoped checks while iterating. Then run the complete `npm run ci:full` on the exact head being merged.
   - IT DBs only via `scripts/it-db.sh up cf-it-<unique>`, then `check` before migrate, torn down with `it-db.sh down` (`docker rm -fv`).
   - Note: CI's integration job runs about 40 min, and the simulated telematics heartbeat lands at 06:00 SAST, so derive time-of-day expectations from the poll instant.
4. Run fresh blind reviewers, each receiving only the diff and the CLAUDE.md files:
   - code;
   - security, plus an adversarial policy-breaker on position access and purge scope;
   - tests (mutation);
   - architecture (Opus);
   - SA legal: POPIA location trail and THEFT, consent v2, commission disclosure, closure-notice wording;
   - tax only if PR W touches amounts (it must not);
   - an independent edge tester in its own clone.

   Loop until all SHIP, and commit their repros.
5. Run browser acceptance against an isolated seeded local stack. Commit the screenshots plus a README and RESULTS.md per part, within the PR.
6. Merge only via `mq add <pr>`. Verify that the reviewed head is an ancestor of main and that the tested tree is identical. Start the next part from fresh main.

## §5 Acceptance (browser, per part)

- **D.**
  - A dealer attests a REMOTE consent (method shown on the staff deal page).
  - A dealer cancels its own draft; a second dealer gets 404.
  - Staff see the purge tombstone after a cron run on a seeded 91-day-old draft, while a booked deal is untouched.
- **T.**
  - A collections officer records a SAPS theft report on a loan in good standing and sees the position and trail; after expiry they are refused.
  - READONLY is refused.
  - A wrong TELEMATICS reading is voided by two staff users, and the excess projection changes.
  - Settling the loan creates the removal task, the portal notice, a captured (not sent) message and the stored PDF.
- **W.**
  - The rendered NCA quote and commercial ISA for a dealer deal show the clause; a non-dealer deal does not.
  - The demo lender's templates are re-approved.

## §6 Documentation and handoff

- Update:
  - SLICE5.md;
  - `SLICE5-FOLLOWUPS.md`;
  - `lib/asset-finance/.claude.md` and any module `.claude.md` (then `npm run agents:mirror`);
  - `docs/DEPLOY-ENV.md` for the new cron;
  - `docs/asset-finance/legal-wording/README.md` for the new wording.
- Write the final handoff to `.claude/handoffs/<date>-asset-finance-slice5-followups-done.md`, committed via its own PR and mq, never LATEST.md.
- Memory: update the "Slice 5 review-item decisions" block in the asset finance memory with what was built.

## §7 Success criteria (all must be proven)

1. `SLICE5-FOLLOWUPS.md` spec and matrix cover §2a items 1 to 8.
2. Consent v2 has a signing method, v1 rows are unchanged, and it is proven on real PG.
3. Dealer draft cancel works and is isolated per dealer. The 90-day purge deletes or anonymises exactly the right rows and never touches booked or shared data, proven on real PG.
4. THEFT purpose with a report and expiry; the purpose gate is enforced in SQL; the trail is retained and purged per position; every view is logged. Proven on real PG, with a policy-breaker SHIP.
5. The four-eyes meter void is DB-enforced, voided readings are excluded everywhere, and billed or final readings are refused. Proven.
6. Closure produces the task, notice, captured message and PDF exactly once, from all three closure paths; there is no real send.
7. The commission clause is on the agreed variants, fingerprints are re-pinned with a proof, borrower amounts are unchanged, and demo templates are re-approved.
8. Browser acceptance for D, T and W, with committed screenshots and READMEs, and 0 page errors.
9. Every PR has: `ci:full` green on its merged head; all reviewers SHIP; mutations killed; `scripts/integration-baseline.txt` not grown.
10. Three PRs merged via mq in order D → T → W, with ancestry and tree identity verified. Docs, handoff and memory written. Worktrees, branches and containers you created removed.

## §8 Confirmation gates (stop and ask Hein)

- Any real telematics provider, credentials, contract or paid API.
- **Sending a real message** (email, WhatsApp, SMS), enabling a real transport, making a real payment, or any spend.
- DDL on any shared database, or any migration that drops data a deployed stack holds.
- Deploying, restoring or re-baking any demo or Fairscore stack, or changing another agent's runtime.
- Changing Section 129, credit-agreement or certificate-of-balance wording or pins under `lib/pdf/`, changing signed-off calculations, or setting any lender's legal-approval flag. The asset-finance template wording in §2a 1, 2 and 6 is authorised on legal SHIP.
- Adding commission to a borrower's charges or cost of credit.

Before asking, finish the authorised work and present the exact proposal and evidence.
