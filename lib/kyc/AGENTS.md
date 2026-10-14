<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: lib/kyc (override rules)
<!-- Keep under 50 lines - reference, don't duplicate -->

## Failed-selfie overrides
- `lib/kyc/override-policy.ts` is the application policy boundary. Every direct
  grant, request and decision re-reads the lender policy under its lock.
- A selfie similarity below `FACE_MISMATCH_FLOOR` (0.30), or a VLM verdict of
  `different`, is a clear mismatch and can never receive a manual selfie
  exception. Missing similarity on a face-match failure fails closed.
- The floor is a fixed product constant, not a lender setting. It is initially
  unmeasured because no real impostor-pair dataset exists; changing it needs
  explicit product approval and the SQL mirror must change with it.
- `id_document_portrait_invalid` and `selfie_not_real_photograph` remain
  never-exceptionable. Do not weaken that list without explicit approval.
- In-person verification remains available after a clear selfie mismatch, but
  follows the same enabled, minimum-role, second-approver and TOTP policy.

## Replacement ID copies
- A newer, unreviewed, non-refused ID copy (`lib/kyc/id-replacement.ts`) holds
  the client PENDING in TypeScript and in `subject_has_composite_kyc` (the
  delimited "replacement-ID rule" conjunct). A later migration that redefines
  that function must carry the conjunct. The ID upload re-projects the stored
  status (`id-upload-projection.server.ts`); it never promotes.

## Enforcement and proof
- PostgreSQL independently enforces enabled, active minimum-role actors,
  one-use payload-bound dual approval, and a durable application TOTP assertion
  backed by the user's enrolled/used TOTP state. It also rejects clear
  mismatches, excludes them from composite KYC, and keeps the ledger immutable.
- The migration aborts with an affected-client count if a cached VERIFIED row
  currently depends on a clear-mismatch exception; reconciliation is a rollout
  confirmation gate, never an automatic migration side effect.
- Unit tests: `lib/kyc/override-policy.test.ts` and route tests beside the APIs.
- Real-DB suite: `RUN_KYC_OVERRIDE_IT=1` plus the existing
  `RUN_KYC_EXCEPTION_PROJECTION_IT`, `RUN_KYC_IN_PERSON_IT`,
  `RUN_FACE_MATCH_V2_IT`, `RUN_FACE_MATCH_V3_IT`,
  `RUN_BIOMETRIC_SEQUENCE_IT`, `RUN_BIOMETRIC_FINGERPRINT_IT`,
  `RUN_PORTAL_KYC_SNAPSHOT_IT`, and `RUN_DB_IT` suites.
