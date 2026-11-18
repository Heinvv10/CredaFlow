# /goal — KYC override policy: per-lender rules for overriding a failed face match (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/CredaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-13-kyc-override-policy-goal.md to completion. Work autonomously through Spec → Build (TDD) → Integrate → Acceptance → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§9) or a genuine external blocker. Loop until every Success Criterion (§8) is proven with evidence, then publish the evidence, open the PR, write a handoff and stop.`

## 1. Mission

Make overriding a failed selfie/ID face match a **per-lender policy**, enforced in the API and in Postgres. Today any ADMIN can do two things, with no 2FA and no floor on how badly the faces disagreed:
- grant a KYC exception over a low match score;
- record an in-person verification after a failed selfie.

After this work:
- a **clear mismatch can never be overridden** by anyone;
- a **borderline** failure can be overridden by a senior whose minimum role is set per lender;
- a lender can require a **second, different approver**;
- every override needs 2FA whenever the lender requires staff 2FA;
- every step is audited.

"Built" means all of the following:
- the policy lives in real `TenantConfig` columns;
- the rule is enforced in the routes AND by a database trigger;
- there is UI on the existing Security & KYC policy page and on the client's Selfie/KYC tab;
- real-Postgres integration tests pass;
- browser acceptance has screenshots.

Never mock data.

## 2. What already exists — do NOT redo

The base is `origin/main` at `b43ea9c` or later. Branch `feat/kyc-override-policy` from current `main` in a worktree `../CredaFlow-wt-kyc-override` and run `npm ci --legacy-peer-deps` there. Start by reading `CLAUDE.md`, `docs/ARCHITECTURE.md` and `lib/.claude.md`.

- **Face match pipeline:**
  - `lib/kyc/selfie-biometric.server.ts` (`runBiometricVerification`) feeds the pure decision `decideBiometricAttempt` in `lib/kyc/biometric-decision.ts`.
  - The face model (YuNet + SFace, `lib/kyc/face-model/compare.server.ts`) alone decides same-person. `FACE_SIMILARITY_THRESHOLD = 0.363` lives in `lib/kyc/face-model/models.ts`, with an SQL mirror in `prisma/migrations/20261011080000_face_match_v3_evidence/migration.sql`.
  - The VLM judge (`lib/kyc/vlm-face-match.ts`, verdict `same | different | uncertain`) can only refuse.
  - On a pass, `FaceModelEvidence.similarity` is stored inside `biometricResult`. Every attempt either judge answered also stores `biometricResult.faceVerdict` (`{samePerson, faceMatch, faceModelSamePerson}`).
  - Failure reasons and their benign/adverse classes are in `lib/kyc/biometric-evidence.ts` (`BIOMETRIC_FAILURE_REASON_CLASS`, `isAdversePriorAttempt`).
- **Retakes are already unlimited.** Each attempt is a `ClientDocument` (`docType = SELFIE`) with `biometricAttemptSequence`, assigned by a trigger. Do not add a cap.
- **Existing override paths:** both are ADMIN-only today, with no TOTP check.
  - Senior exception: `app/api/clients/[id]/kyc-exception/route.ts`. Policy in `lib/kyc/manual-exception-policy.ts` (excepted reasons; reason and evidence of at least 20 code points). Writes in `lib/kyc/manual-exception.ts` (`ComplianceRecord` `KYC_EXCEPTION`, audit `KYC_EXCEPTION_GRANTED`, bound to the selfie, its sha, the subject fingerprint and the reason). `id_document_portrait_invalid` and `selfie_not_real_photograph` can never be excepted; keep that.
  - In-person verification: `app/api/clients/[id]/kyc-in-person-verification/route.ts` and `lib/kyc/in-person-verification.ts` (audit `KYC_IN_PERSON_VERIFICATION_GRANTED`).
  - UI: `components/clients/SelfieKycTab.tsx` (`canGrantManualException`), set in `app/(dashboard)/clients/[id]/page.tsx`.
- **Database KYC enforcement** (baseline plus v2/v3 face-match migrations):
  - `enforce_composite_kyc_projection`;
  - `subject_has_composite_kyc`, which ORs together the biometric pass, `subject_has_manual_kyc_exception` and `subject_has_in_person_kyc_verification`;
  - `guard_completed_kyc_exception_immutable`;
  - `revoke_stale_kyc_exception`.

  None of these checks the approver's role or the face score. Enumerate the live triggers and CHECKs (CLAUDE.md SQL) before changing anything.
- **Lifecycle gates:**
  - approve uses `okForOrigination`, and PASQ and disburse use the strict `ok` (`lib/kyc/document-state.ts`);
  - `lib/affordability/current-disbursement.ts` requires `kycStatus = VERIFIED`.

  Don't change the gates. Only change what counts as a valid override.
- **The staff 2FA policy (#55) is the pattern to copy:**
  - column `TenantConfig.requireStaffTotp` (migration `20261013110028_staff_totp_policy`);
  - library `lib/security/staff-totp-policy.ts` (`isStaffTotpRequired`, `getStaffTotpPolicyState`, `applyStaffTotpRequired`: advisory lock, row lock, `logAuditStrict`);
  - route `app/api/settings/security-policy/route.ts` (SUPER_ADMIN + `totpVerified`);
  - page `app/(dashboard)/settings/security-policy/page.tsx`, which has a placeholder comment where the KYC override card goes;
  - component `components/settings/StaffTotpPolicyToggle.tsx`;
  - tests in `lib/security/staff-totp-policy.integration.test.ts` (`RUN_DB_IT`).
- **Roles** (`lib/permissions.ts`), lowest to highest: … LOAN_ADMIN < BRANCH_MANAGER < ADMIN < SUPER_ADMIN. There is no CREDIT_MANAGER.
- **Demo stacks:** the demo lender has `requireStaffTotp = false` (and `DEMO_CLEAR_STAFF_TOTP`, `lib/config/demo-mode.ts`). With overrides gated on the lender's 2FA policy, demos keep working without an authenticator. Check that the demo bake and simulator (`scripts/demo/`) still pass any KYC override they perform.
- **KYC integration suites that must stay green:**
  - `RUN_KYC_EXCEPTION_PROJECTION_IT`, `RUN_KYC_IN_PERSON_IT`, `RUN_FACE_MATCH_V2_IT`, `RUN_FACE_MATCH_V3_IT`;
  - `RUN_BIOMETRIC_SEQUENCE_IT`, `RUN_BIOMETRIC_FINGERPRINT_IT`, `RUN_PORTAL_KYC_SNAPSHOT_IT`, `RUN_DB_IT`.
  - `scripts/integration-baseline.txt` is empty and may only shrink.

## 2a. Product decisions (made by Hein, 2026-10-13; build them, don't reopen)

1. **Clear mismatch, never overridable by anyone or any path.** Either of these is a clear mismatch:
   - the VLM judge said `different` (`faceVerdict.samePerson === "different"`);
   - or the face-model similarity is below **`FACE_MISMATCH_FLOOR = 0.30`**. That is a product constant beside `FACE_SIMILARITY_THRESHOLD`, mirrored in SQL, and not per-lender.

   **Fail closed:** a face-match failure with no similarity on record counts as a clear mismatch. Make the pipeline persist the face-model similarity on failing attempts too (in `biometricResult` or `faceVerdict`), so new attempts carry it. The 0.30 value is unmeasured: no real impostor pairs exist. Name it as such in a code comment and in the PR.
2. **Senior** = a per-lender minimum role, `BRANCH_MANAGER` or `ADMIN`, default `ADMIN`.
3. **Defaults for a new or existing lender:** overrides on, single approver. The second approver is opt-in.
4. **Second approver:**
   - a senior files an override *request*, and a **different** senior approves or declines it;
   - the database refuses requester = approver;
   - an undecided request expires after 7 days;
   - approving runs the existing grant path in the same transaction.
5. **The existing exception route is tightened, not removed:**
   - face-match failures (`match_score_below_threshold` and any reason caused by the face judges) go through rules 1–4;
   - the other excepted reasons (face not detected, unusable image, liveness and the like) keep working, under the same minimum role, second-approver and 2FA rules;
   - every KYC override needs `totpVerified` whenever `isStaffTotpRequired(tenant)` is true.
6. **In-person verification stays allowed after a clear mismatch**: physical presence with ID beats a selfie. It follows the same minimum-role, second-approver and 2FA rules.

## 3. Policy storage and settings

- `TenantConfig` gains three columns:
  - `kycOverrideEnabled Boolean @default(true)`;
  - `kycOverrideMinRole UserRole @default(ADMIN)`, with a CHECK that it is in (`BRANCH_MANAGER`, `ADMIN`);
  - `kycOverrideSecondApprover Boolean @default(false)`.

  All three are additive with defaults, so existing lenders get Hein's defaults.
- Add `lib/kyc/override-policy.ts`, mirroring `staff-totp-policy.ts`: read and apply under the same locking pattern, with a new audit action `KYC_OVERRIDE_POLICY_UPDATED` (old and new values).
- Extend `PUT /api/settings/security-policy`, or add a sibling route `[agent decides]`. Either way it needs SUPER_ADMIN plus `totpVerified`, with a 400 on bad types or a role outside the allowed two.
- Add a "KYC overrides" card at the page's placeholder: an enabled toggle, a minimum-role select and a second-approver toggle. It shows the last change (who and when) from audit. It is read-only below SUPER_ADMIN.
- **Turning overrides off** blocks new overrides and new requests. It does not revoke granted ones, and pending requests can no longer be approved. Say so on the card.

## 4. Override rules in the API

- Add one pure function, e.g. `overrideEligibility(attempt, policy, caller)`, in `lib/kyc/`. It returns allowed, or a refusal code:
  - `clear_mismatch`, `never_exceptionable`, `overrides_disabled`;
  - `role_below_policy`, `totp_required`, `second_approver_required`.

  Unit-test every branch red-first, at the boundaries (similarity exactly 0.30, 0.2999; `uncertain` vs `different`; a missing similarity).
- **Routes:**
  - `kyc-exception` and `kyc-in-person-verification` grant directly only when the second approver is off. When it is on, they answer 409 `second_approver_required`, and the UI files a request instead.
  - New request routes `[agent decides paths]`: create, approve, decline and list pending for a client. Approve re-checks eligibility under a lock (the policy or the attempt may have changed), refuses self-approval (403), and grants through the existing write path in one transaction.
  - All of them are audited, with new actions `KYC_OVERRIDE_REQUESTED`, `KYC_OVERRIDE_APPROVED`, `KYC_OVERRIDE_DECLINED` and `KYC_OVERRIDE_EXPIRED`. They use `withTenantContext` and pass `tenantId` explicitly.
- **Expiry:** decide whether a pending request is expired lazily when read and approved, or by a cron under `app/api/cron/*` `[agent decides]`. Expired requests can never be approved.

## 5. Database enforcement (migration; ships with the code)

- A new model, e.g. `KycOverrideRequest`, holds:
  - `id`, `tenantId`, `clientId`, `selfieDocumentId` (nullable for in-person), `kind` (EXCEPTION | IN_PERSON);
  - `payload` Json (reason, evidence, method, note);
  - `requestedById`, `requestedAt`, `status` (PENDING | APPROVED | DECLINED | EXPIRED), `decidedById`, `decidedAt`, `decisionNote`, `expiresAt`.

  The tenant-composite foreign keys follow the existing pattern. Add it to `TENANT_SCOPED_MODELS` and its test.
- **CHECKs:**
  - `decidedById <> requestedById`;
  - decided fields present if and only if the status is not PENDING;
  - `expiresAt = requestedAt + 7 days`.
- **Trigger:** no delete; a decided row is immutable; only PENDING → APPROVED, DECLINED or EXPIRED; no APPROVED after `expiresAt`.
- **A trigger or function on the KYC exception write** refuses a face-match exception whose selfie attempt is a clear mismatch. It reads the stored similarity and verdict and fails closed when they are missing. Do not rely on the route alone. Extend or wrap `subject_has_manual_kyc_exception` so that a clear-mismatch exception never counts toward composite KYC, even if a row exists.
- Write the SQL by hand in the migration's hand-written section and update the static tests that read migrations (`lib/db-baseline.test-helpers.ts`). Never edit an applied migration.

## 6. UI on the client's Selfie/KYC tab

- **A clear mismatch** shows "Faces clearly don't match — this can't be overridden. Ask the client for a new selfie, or verify them in person." with no override button.
- **A borderline failure:**
  - with the second approver off, a senior sees the existing grant form;
  - with it on, the senior sees "Request override", and the pending request shows who asked, when, and its expiry.
- **A different senior** sees Approve and Decline, which need a reason. The requester sees "awaiting another approver".
- **Below the minimum role,** the controls are hidden and a note names the role needed. Without TOTP when it's required, show a note in the pattern of the credit-checks panel's needs-2FA message.

## 7. Documentation

- Create `lib/kyc/.claude.md`, under 50 lines. It covers:
  - the override rules;
  - the clear-mismatch floor and why it is a constant;
  - the never-exceptionable reasons;
  - "the database enforces it";
  - the integration suites.

  Run `npm run agents:mirror`.
- Add a line to root `CLAUDE.md`'s Path-Scoped Rules.

## 8. Success criteria (all proven with evidence)

1. Every `overrideEligibility` branch has a red-first unit test, and each guard is mutation-verified: revert it, watch the test go red, restore it.
2. A real-PG integration suite (`RUN_KYC_OVERRIDE_IT`) proves each of these, and each assertion goes red when its trigger or CHECK is dropped:
   - **(a)** the DB refuses an exception on a clear-mismatch attempt (similarity 0.29; and verdict `different`), even inserted directly;
   - **(b)** a clear-mismatch exception never makes `subject_has_composite_kyc` true;
   - **(c)** a borderline exception (similarity 0.33, verdict `uncertain`) succeeds and the client reaches VERIFIED;
   - **(d)** requester = approver is refused;
   - **(e)** approve after expiry is refused;
   - **(f)** a decided request cannot change or be deleted;
   - **(g)** the policy CHECK refuses `kycOverrideMinRole = LOAN_ADMIN`.
3. Route tests cover:
   - role below policy, 403;
   - TOTP required and missing, 403;
   - TOTP not required, allowed;
   - second approver on, so a direct grant gets 409 and goes through request → approve by another user → VERIFIED;
   - self-approve, 403;
   - overrides disabled, refused;
   - every action audited.
4. Existing guards keep holding: the never-exceptionable reasons, the exception bound to its selfie and sha, and all the KYC suites listed in §2.
5. Gates, in CLAUDE.md order:
   - `tsc`, `lint` and the full `npm test`;
   - `bash scripts/run-integration-tests.sh` on a throwaway Postgres 16, torn down with `docker rm -fv`;
   - `claude-md:check` and `agents:check`.
6. Browser acceptance on a seeded local DB, with screenshots:
   - **(a)** the settings card, changed by a TOTP-verified SUPER_ADMIN, with its audit "last change";
   - **(b)** a clear mismatch with no override offered;
   - **(c)** a borderline override granted by a single approver;
   - **(d)** second approver on: request by one senior, approval by another, and the client VERIFIED.

   Make the biometric attempts synthetic by writing the stored evidence for seeded selfies; never use real faces.
7. Review loop until SHIP:
   - `/review-team`;
   - a policy-breaker reviewer whose job is to override a clear mismatch, self-approve, or skip 2FA by any path, the in-person route included;
   - a security review.

   Fix every finding, mutation-verify each fix, and post a reconciliation comment on the PR.
8. Evidence is published (the PR body, plus screenshots attached or linked). The handoff goes in `.claude/handoffs/`, and the memory `project_credaflow_finish_plan.md` gets "KYC override shipped as PR #N".

## 9. Confirmation gates — STOP and ask Hein

- **Merging, or applying the migration to any shared or demo database.** It adds enforcement, a schema change. Open the PR and stop.
- **Changing `FACE_MISMATCH_FLOOR` away from 0.30, or `FACE_SIMILARITY_THRESHOLD`, or the never-exceptionable list.**
- **Anything that would revoke or alter KYC already granted** to existing clients, beyond what the new trigger refuses going forward. If the migration would invalidate existing VERIFIED clients on a migrated database, stop and report the count first.
- **Any deploy, any real person's photo or ID, any external API.** Faces stay synthetic, and the VLM is only the local one.
- **NCA document wording, or `lib/affordability/mle.ts`.**

Commits: stage only the paths you changed; never commit to `main`; never force-push a shared branch.
