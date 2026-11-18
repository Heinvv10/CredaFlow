# /goal — KYC + demo-tooling follow-ups: 8 items (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-16-kyc-followups-goal.md to completion. Work autonomously through Spec → Build (TDD) → Integrate → Acceptance → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§13) or a genuine external blocker. Loop until every Success Criterion (§12) is proven with evidence, then open the PRs, queue them with mq, write a handoff and stop.`

## 1. Mission

Close the follow-ups left by PR #102 (KYC replacement-ID rules) and last night's demo bake. Every KYC change is enforced where it lives today, so where a rule exists in SQL as well as TypeScript, both layers change together. Each change ships with:
- a mutation-verified test, against a real database where the rule runs in Postgres;
- for UI changes, a real browser check against a seeded local stack, with a screenshot.

Demo-tooling items need tests that fail on the real failure mode. Mock data or unverified claims don't count as done.

## 2. What already exists — do NOT redo

- **Main:** origin/main at `c0b1aca5` or later. Read `.claude/handoffs/2026-10-16-0625-kyc-leftovers-flakes-done.md` and `lib/kyc/.claude.md` first.
- **#102 (merged):**
  - `lib/kyc/id-replacement.ts`: `pendingIdReplacement`, the "created after newest verified" rule with the identical-sha256 exemption.
  - SQL `subject_has_pending_id_replacement`, migration `prisma/migrations/20261015130000_identical_id_reupload_not_replacement`.
  - `lib/kyc/verification-restorable.ts`: the hint predicate and `newestVerifiedIdCopyId`.
  - `lib/kyc/kyc-rederive.server.ts` and `app/api/clients/[id]/kyc-rederive/route.ts`: re-derive only, audit `KYC_STATUS_REDERIVED`.
  - UI: `components/clients/RestorableVerificationHint.tsx`, `KycChecklistTab.tsx`, `SelfieKycTab.tsx`.
- **Real-DB suites to keep green:**
  - `RUN_KYC_ID_UPLOAD_IT` (`lib/kyc/id-identical-reupload.integration.test.ts`)
  - `RUN_KYC_REDERIVE_IT` (`lib/kyc/kyc-rederive.integration.test.ts`)
  - every `lib/kyc` suite listed in `lib/kyc/.claude.md`
  - `npm run ci:full`, the whole gate
- **#99 (merged):** de-flaked the lender lock and specimen tests. **#117:** signing-OTP sim env tests. **#115:** sim `DEMO_MODE` + `UNSUB_TOKEN_SECRET`.
- **Merging:** CredaFlow merges ONLY via `mq add <pr>`. `gh pr merge` is blocked by a hook, and `--admin` is never used.

## 2a. Product decisions (already made by Hein, 2026-10-16)

1. **An identical ID re-upload IS the verified copy.** A newer copy whose well-formed `contentSha256` equals the newest verified copy's:
   - binds selfies as that verified copy (TS + SQL);
   - shows in the staff checklist as "Identical to verified copy", with no Verify/Reject on it;
   - counts as verified.
2. **Hide the Re-verify hint and button when the latest KYC status change was a deliberate manual PENDING by staff.**
3. **Add a DB CHECK** forbidding a `ClientDocument` row that is `verified = true` and also carries a refusal marker (`verificationRejectedAt` / `verificationRejectedById`). Hein approved this migration. It must abort with a count if existing rows violate it, never auto-fix them. The code ships in the same PR.
4. **The top KYC badge shows the STORED status.** What the evidence supports may appear as secondary text.

## 3. F1 — Identical copy = verified copy (selfie binding + checklist)

- **Today:** selfie capture binds to the newest copy that isn't rejected (`CURRENT_ID_DOCUMENT` in `lib/kyc/biometric-evidence.ts`, near lines 355 and 533–564). After an identical re-upload that is the unverified twin, so a selfie fails `subject_identity_changed` and counts as an adverse attempt.
- **Find every mirror:** grep the migrations for the SQL that picks the current ID document for biometric binding and the composite rule. Make TS and SQL resolve an identical twin to the verified copy, using the same well-formed-digest, NULL-never-matches rule as `pendingIdReplacement`.
- **SQL changes go in a NEW migration** (`CREATE OR REPLACE FUNCTION`). Update the static body tests that pin function bodies (`lib/db-baseline.test-helpers.ts` and the per-migration tests).
- **Checklist:** `KycChecklistTab.tsx` picks the latest copy per type. Render the twin as identical to the verified copy, hide its Verify/Reject, and count it as verified. Show no "3/4 verified" next to a VERIFIED badge.
- **Real-DB tests:**
  - identical re-upload, then selfie → passes against the verified copy;
  - a different re-upload, then selfie → unchanged behaviour (still bound to the new copy);
  - TS/SQL parity for both.
- **Browser:** checklist with an identical twin. Screenshot.

## 4. F2 — Hide the hint after a manual PENDING

- **Find the manual-status write:** `app/api/clients/[id]/route.ts` (the KYC status override, ~line 1189). Find the audit row it writes.
- **Predicate:** extend `verificationRestorable`, or its caller, to return false when the latest KYC status change for the client was that manual staff PENDING. Read it from the audit trail or an existing stamp — **[agent decides]**, but prefer an existing column over parsing audit JSON if one exists.
- **`kyc-rederive.server.ts` must refuse in the same case (409)** so the API can't bypass the hidden button.
- **Tests:**
  - unit: the predicate;
  - real-DB: manual PENDING → re-derive 409;
  - real-DB: a downgrade by a client delete → still restorable;
  - component: hint hidden.

## 5. F3 — DB CHECK: verified ⟂ refused

- **New migration:** first a pre-check that `RAISE EXCEPTION`s with the count of violating rows, then `ADD CONSTRAINT … CHECK (NOT (verified AND ("verificationRejectedAt" IS NOT NULL OR "verificationRejectedById" IS NOT NULL)))`.
- **Check every writer** that sets `verified` or the refusal markers. Grep `verificationRejectedAt` and `verified:` on ClientDocument writes, and make each one clear the other side in the same write. The verify route already does.
- **Integration test:** a direct insert or update violating it is rejected; every app writer still succeeds. Run the CLAUDE.md catalog queries before and after.

## 6. F4 — Badge = stored status

- Find the top "KYC Status" badge on the client page / KYC tab. It currently shows a derived "VERIFIED IN PERSON" while the stored status is PENDING. Make it show the stored status. Derived provenance ("in person", "biometric") may show only when stored = VERIFIED, or as secondary text.
- **Tests:** a component test. **Browser:** a stored-PENDING client with VERIFIED evidence. Screenshot.

## 7. F5 — ADMIN and the KYC checklist (reproduce first)

- **Reported:** an ADMIN session got 401 on the client document list, so the checklist stayed empty and the Re-verify button never showed. On current main `lib/document-auth.ts` `STAFF_ROLES` DOES include ADMIN, so the cause is elsewhere: session role mapping, tenant check, or the list route's own guard.
- Reproduce with an ADMIN login on a seeded local stack, then add logging at each boundary before fixing.
- **If it doesn't reproduce,** add a route test proving ADMIN gets 200 and a `DocumentAccessLog` row, then close it.
- **Never** weaken `DocumentAccessLog` writing (POPIA).

## 8. F6 — Re-derive test gaps

Add real-DB tests in `lib/kyc/kyc-rederive.integration.test.ts` for:
- **the selfie path:** BIOMETRIC provenance, null verifier, stamped with the selfie's `biometricVerifiedAt`;
- **refusal when the stored status isn't PENDING,** isolated so no other check fires first.

Mutation-prove each.

## 9. F7 — `scripts/demo/restore.test.ts` flake

It timed out once at 5 s in a full parallel `npm test`.
- Reproduce under load the way #99 did: busy loops started and killed by exact PID, never pkill.
- Find the timing assumption (fixed sleeps, heavy setup inside the test budget) and fix the root cause.
- Raise a timeout only with measured durations, as #99 did.

## 10. F8 — Bake preflight

`scripts/demo/bake.sh` / `scripts/demo/simulate.ts` ran 70 minutes before failing on a sim env missing `DEMO_MODE=true` / `UNSUB_TOKEN_SECRET`.
- Add a preflight that fails within seconds, naming the missing key. It checks the sim app container's env and `secrets.env`, printing names only, never values.
- **Tests:** a test that fails without the preflight, with mutation proof.
- Also fix the `lib.sh` comment that says only "a production build refuses": the redacted-send guard applies in every environment.

## 11. Out of scope

Do not touch any of these:
- live demo, Tsela or Fairscore stacks; runner checkouts; cron;
- `~/credaflow-*-data`;
- the Acme runner `.env.demo-sim`;
- image or worktree cleanup;
- NCA document wording.

## 12. Success criteria (evidence for each)

- [ ] **F1:** TS+SQL parity real-DB tests (identical → bound to verified; different → unchanged), mutation-verified; static body tests updated; checklist component test plus browser screenshot.
- [ ] **F2:** real-DB 409 after manual PENDING, and still restorable after a client delete; component test; mutation-verified.
- [ ] **F3:** migration with a pre-check abort; integration test shows a violating write rejected and all app writers OK; catalog query before and after.
- [ ] **F4:** component test plus browser screenshot showing the stored status.
- [ ] **F5:** a reproduction (or proof it doesn't reproduce) plus a route test showing ADMIN 200 with a `DocumentAccessLog` row.
- [ ] **F6:** two new real-DB tests, each mutation-verified.
- [ ] **F7:** before/after pass counts under load, and the root cause stated.
- [ ] **F8:** the preflight fails fast in a test; mutation-verified.
- [ ] **All:**
  - `npm run ci:full` green twice in a row;
  - every PR blind-reviewed by a fresh reviewer: Opus plus an Opus breaker for F1–F3 (KYC/DB), Sonnet for the rest;
  - review findings fixed and re-confirmed;
  - hosted CI green;
  - `mq add` done;
  - handoff written; memory `project_credaflow_finish_plan.md` updated.
- **Suggested PR split [agent decides]:**
  - (A) F1+F3, KYC/DB, one migration each or combined;
  - (B) F2+F4+F5+F6, KYC app/UI;
  - (C) F7+F8, demo tooling.

## 13. Confirmation gates — STOP and ask Hein

- **Any migration other than F1's function redefinition and F3's CHECK.**
- **F3's pre-check finds violating rows** on any shared or demo DB. Report the count; don't fix the data.
- **Any change to NCA document text, audit semantics, or 2FA/TOTP rules.**
- **Any deploy or live-stack action** (demo, Tsela, Fairscore), and any `--admin` merge.
- **F1 turns out to need loosening a DB trigger** beyond resolving the identical twin.

## Rules (from CLAUDE.md, restated)

- Work in worktrees off origin/main; install with `npm ci --legacy-peer-deps`.
- Never `git add -A`, amend, force-push or push to main.
- Every IT container has a unique name, fails fast if `docker run` or the port fails, and is torn down with `docker rm -fv`. Never touch other sessions' containers.
- No `console.log`; no empty catch; files under 300 lines; `--cf-*` theme tokens only; synthetic data only.
