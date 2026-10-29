<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: jurisdiction
<!-- summary: ZA vs LS: currency, ID, holidays, and the one gate for NCA-only steps -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Lets one lender run outside South Africa. `TenantConfig.jurisdiction` (ZA|LS)
and `currency` (ZAR|LSL) choose a profile (`profiles.ts`); `active.ts` holds the
one this deployment runs as. **One jurisdiction per instance**: boot throws
`JurisdictionConflictError` if the ACTIVE tenants differ, and DB triggers keep
them agreeing (a ZA lender cannot be provisioned or activated on an LS instance).

## Critical Rules
- **ZA must behave exactly as before.** The default (nothing loaded, or a read
  that failed) is ZA / ZAR with the NCA gates ON: failure can only be stricter.
  ZA is ZAR only (`setActiveJurisdiction` and a DB CHECK).
- **Entry points await `ensureActiveJurisdiction()`** (crons, `withTenantContext`,
  `getStaffTenantId`, root layout): add to a choke point, not per file.
- **No app write path for jurisdiction**; a trigger freezes jurisdiction and
  currency once the lender has applications or loans. Set it (operator, in the
  database) before the first application. Provision/activate paths pre-check
  with `instance.server.ts` and answer 409.
- **Gate NCA-only steps with `await ncaOnlyRefusal()` / `ncaOnlyPage()` /
  `ncaOnlyCronSkip()` (they load the jurisdiction first), and declare the
  surface in `lib/registry/nca-only/`**: the census fails on an unlisted
  NCA-looking route, and `nca-only-behaviour.test.ts` calls each under LS.
  Never test `jurisdiction === "ZA"` inline; jurisdiction-specific facts (ID,
  mobile, regions, postcode, copy) are fields of `profiles.ts`, read through it.
- **Money goes through `formatZAR` / `formatZarPdf`** (active currency). Do not
  add another `"R " + ...` formatter. `formatZarPdf` keeps ZAR's original
  negative form ("R -0.05"): the NCA PDFs are pinned.
- **Statutory deadlines stay South African** (`lib/compliance/sa-business-days.ts`
  is NCA law); debit/due-date logic uses `business-days.ts`, which follows the lender.
- **Lesotho ID is shape-only** (`national-id.ts`): the layout is unconfirmed.
  Do not derive date of birth or gender from it until it is.
- Lesotho holidays: MEDIUM confidence, no proclaimed-day table (`business-days.ts`).
- `active.ts` is on `globalThis` (Next bundles entry points separately); the
  browser is primed by `components/JurisdictionProvider`. A change needs a restart.
- Lesotho documents (credit agreement, quotation, notices) need Lesotho legal
  wording; the NCA ones refuse to render without an NCR number. Unblocking LS
  approval and signing is a separate item (persisted non-NCA regime on the loan,
  key facts and agreement from lender templates).
- Store and compare IDs through `canonicalIdNumber` (LS: trimmed, upper case).

## Key Files
| File | Purpose |
|------|---------|
| `profiles.ts` | Jurisdiction/currency codes and per-jurisdiction facts |
| `active.ts` | The active value, `isNcaJurisdiction()` |
| `business-days.ts` | Business-day maths and Lesotho holidays |
| `nca-only.ts` | 404 for NCA-only API routes |
