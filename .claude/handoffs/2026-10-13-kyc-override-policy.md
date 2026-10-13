# Handoff — KYC override policy (PR #64)

**Repository:** `github.com/Heinvv10/CredaFlow`  
**Branch:** `feat/kyc-override-policy`  
**Commit:** `3c82d3f`  
**PR:** https://github.com/Heinvv10/CredaFlow/pull/64  
**Base:** `main` at `b43ea9c`

## Outcome

PR #64 implements the per-lender KYC override policy end to end. It is open and intentionally unmerged. No shared/demo database migration, deployment, external API, real face, or real identity was used.

- `TenantConfig`: enabled, minimum role (`BRANCH_MANAGER|ADMIN`), optional second approver.
- Clear selfie mismatch is non-overridable in application code and PostgreSQL: VLM `different`, similarity below `0.30`, or missing similarity.
- In-person verification remains possible after a clear selfie mismatch, under the same role/TOTP/dual-control policy.
- Dual control uses immutable seven-day requests, a different eligible approver, exact payload binding, one-use grants, and approval/grant atomicity.
- Future and PostgreSQL `infinity` timestamps are rejected at insert.
- All request, decision, expiry, grant, and policy updates are audited.
- Settings and client KYC UI are complete.

## Evidence

Published at [the evidence index](../evidence/kyc-override-policy/README.md), including four browser screenshots:

1. TOTP-verified SUPER_ADMIN policy change with last-change audit.
2. Clear mismatch with no exception offered.
3. Borderline direct exception reaching VERIFIED.
4. Request by one senior, approval by another, reaching VERIFIED.

The browser acceptance used an isolated local Chrome profile and synthetic stored evidence.

## Verification

- `npx tsc --noEmit`: pass.
- `npm run lint`: pass.
- `npm test`: 938 files / 13,356 tests passed; 119 files / 1,157 repository-gated tests skipped.
- Full PostgreSQL integration register: 115 files / 1,136 tests passed; 2 expected skips.
- Focused `RUN_KYC_OVERRIDE_IT`: 19/19 passed.
- Prisma schema validates and migration/schema diff reported no difference.
- `claude-md:check` and `agents:check`: pass.
- Review team: SHIP.
- Policy breaker: SHIP after the future/infinite timestamp fix.
- Security review: SHIP.

Mutation proof covers every pure eligibility branch and the database/request guards. The final two adversarial mutations disabled approval/grant atomicity and timestamp validation; both made their focused tests fail and were restored.

## Calibration and operational boundary

`FACE_MISMATCH_FLOOR = 0.30` is unchanged from the approved decision and mirrored in SQL. It is unmeasured because there is no real impostor-pair dataset. The existing face-match threshold, never-exceptionable reasons, origination gates, NCA documents, and affordability code were not changed.

The migration adds immediate enforcement and must ship atomically with the code. Applying it to a shared/demo database, merging, or deploying remains a confirmation gate.

## Next action

Review PR #64. Do not merge or apply migration `20261013213000_kyc_override_policy` without Hein's explicit confirmation.

