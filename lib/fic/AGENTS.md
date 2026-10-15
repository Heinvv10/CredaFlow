<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: fic
<!-- summary: FIC registers (CTR, STR, RMCP); tipping off; unverified threshold -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
FIC Act tooling for the lender's compliance officer: the cash threshold
register (`lib/fic/cash-threshold.ts`, `lib/fic/registers.ts`), a split-deposit
flag (`lib/fic/cash-aggregation.ts`), the suspicious / unusual transaction
register (`lib/fic/str-cases.ts`), goAML-ready draft exports
(`lib/fic/goaml-export.ts`) and the RMCP record (`lib/fic/rmcp.ts`). PEP /
sanctions screening is `lib/screening`.

## Critical Rules
- **The cash threshold is ONE constant, `CASH_THRESHOLD_CENTS`, unverified.**
  Never state the figure anywhere else (copy, docs, tests other than its own).
  The lender's compliance officer confirms it before go-live. Aggregation
  rules are unverified too: the split-deposit flag only flags.
- **Exports are a "goAML-ready draft", never "goAML-compliant".** No goAML
  schema is in the repo; do not claim conformance until one is and a test
  validates against it. Exports are never capped; open work is never capped.
- **Tipping off.** The STR register is `manage_fic_compliance` only; every
  read, update and export writes a `SuspiciousReportAccess` row; nothing about
  a case appears on client, loan or portal screens; audit rows carry the case
  id and status only, and every general AuditLog reader hides STR rows from
  everyone else (`lib/fic/audit-visibility.ts`). Add it to any new reader.
- **2FA:** every FIC route and the FIC page refuse a session that skipped TOTP
  where the lender requires staff 2FA (`lib/fic/session.ts`).
- **Maker-checker** (per lender, `TenantConfig.requireSecondReviewer`, default
  on; DB trigger too): the raiser never decides an STR case; the uploader never
  approves an RMCP version.
- **Registers are records.** STR cases, CTR outcomes, the access log and RMCP
  versions cannot be deleted; decided STR cases and CTR outcomes never change.
- **No generated legal text.** The RMCP is the lender's own uploaded PDF.

## Tests
`cash-threshold.test.ts` (boundary), `cash-aggregation.test.ts`,
`str-cases.test.ts`, `goaml-export.test.ts`; `RUN_SCREENING_IT=1` for
`db-enforcement` and `audit-visibility`.
