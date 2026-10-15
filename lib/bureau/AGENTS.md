<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: bureau (credit ENQUIRY framework)
<!-- summary: bureau enquiry providers, fallback, freshness -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Provider-agnostic credit bureau enquiry. Adapters behind `BureauProvider`
(`lib/bureau/types.ts`) return a normalised `BureauReport`; the registry
(`lib/bureau/registry.ts`) resolves them by id; `lib/bureau/enquiry.ts` runs one
enquiry across a tenant's bureaus. Bureau DATA SUBMISSION is
`lib/bureau-submission` — a different thing.

## Critical Rules
- **No bureau-specific names or fields outside its adapter** under `providers/`.
- **Never invent a wire format.** XDS, VCCB, CPB and MyData are skeletons
  (`providers/skeletons.ts`) that throw NOT_CONFIGURED / NOT_IMPLEMENTED until
  the bureau's integration pack arrives. Their credential fields are provisional.
- **The Experian and TransUnion adapters are wrappers.** They call the existing
  clients in `lib/integrations/`; change the wire there, not here.
- **One ordered list is the tenant's policy:** `TenantConfig.bureauProviderOrder`,
  primary first. Fallback rule (top of `lib/bureau/enquiry.ts`): fall back on a
  bureau-side failure, stop on a report or on SUBJECT_REJECTED (consent, bad ID:
  another bureau would refuse it too). Every attempt is one `CreditBureauCheck`
  row (`attempt`, `status`), written by `lib/compliance/bureau-review.ts` and
  `lib/asset-finance/deal-bureau.ts` (both through `runBureauEnquiry`).
- **Only `APPROVAL_BUREAU_PROVIDERS` (`lib/compliance/bureau.ts`) can approve.**
  The score floor is calibrated on the Sigma band and the gate needs the
  hard-stop flags. Adding a bureau there needs per-bureau calibration first.
  Origination runs pass `eligible: isApprovalBureau`: any other bureau is
  recorded SKIPPED_NOT_APPROVABLE and never called; the settings API refuses
  one as primary.
- **Freshness is per tenant:** `TenantConfig.bureauMaxAgeDays` (default 60,
  CHECK 1..60). Approval-path reads go through `approvalBureauCheckWhere` /
  `approvalBureauCheckUsableWhere`; the deal path reuses a check for that window.
- **Simulated reports carry their guard key** (`obligations.simulationSource`);
  `simulatedBureauBlock(check)` applies that provider's policy, and a
  `provider: "simulated"` row is governed by `simulated-bureau` whatever its
  marker says. Nothing else (not `EXPERIAN_ENV=UAT`) opens the simulator.
- **Bureau debt into affordability:** `bureauInstalmentTotalCents` (larger of the
  bureau's stated total and its not-closed tradelines, negatives as zero) is
  stored as `obligations.totalMonthly`; affordability takes max(declared,
  bureau). A report with no accounts and no total stores `null`, and the bureau
  gate refuses it without an audited override — never read it as zero debt.
- **Credentials** for per-tenant bureaus live sealed in
  `TenantConfig.bureauCredentials` (`lib/bureau/credentials.ts`); plaintext is
  refused. Written only by `app/api/settings/bureau`; any response returning a
  whole TenantConfig row must pass it through `redactBureauCredentials`.

## Tests
Unit: `npx vitest run lib/bureau lib/compliance/bureau lib/decision/bureau-simulated`.
DB: `RUN_BUREAU_FRAMEWORK_IT=1` (`lib/bureau/framework.integration.test.ts`).
