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
one this deployment runs as. One instance serves one lender, so a process-wide
value is the design, not a shortcut.

## Critical Rules
- **ZA must behave exactly as before.** The default (nothing loaded, or a read
  that failed) is ZA / ZAR with the NCA gates ON: failure can only be stricter.
- **Gate NCA-only steps with `isNcaJurisdiction()` / `ncaOnlyRefusal()`, at the
  step's entry point.** Today: the rate cap (`lib/loan/nca-interest-cap.server.ts`,
  `lib/product-config/`), Section 129 (`evaluateCollectionsEligibility`, which
  every s129 route, bulk run, escalation and automation rule goes through),
  the NCR return (route, page, nav). A new NCA-only step adds its own gate;
  never test `jurisdiction === "ZA"` inline.
- **Money goes through `formatZAR` / `formatZarPdf`** (they read the active
  currency). Do not add another `"R " + ...` formatter; a few exist (see the PR
  that added this module) and show rand regardless.
- **Statutory deadlines stay South African**: `lib/compliance/sa-business-days.ts`
  is NCA law and is called directly. Debit/due-date logic uses
  `business-days.ts`, which follows the lender.
- **Lesotho ID is shape-only** (`national-id.ts`): the layout is unconfirmed.
  Do not derive date of birth or gender from it until it is.
- Lesotho holidays are MEDIUM confidence and have no proclaimed-day table
  (`business-days.ts` says what is missing).
- `active.ts` is on `globalThis` (Next bundles entry points separately). The
  server loads it in `instrumentation.ts` and the root layout
  (`load.server.ts`); the browser is primed by `components/JurisdictionProvider`.
  Changing a lender's jurisdiction needs a restart.
- Lesotho documents (credit agreement, quotation, notices) need Lesotho legal
  wording; the NCA ones refuse to render without an NCR number.

## Key Files
| File | Purpose |
|------|---------|
| `profiles.ts` | Jurisdiction/currency codes and per-jurisdiction facts |
| `active.ts` | The active value, `isNcaJurisdiction()` |
| `money.ts` | `formatMoney` by currency (ZAR output unchanged) |
| `business-days.ts` | Business-day maths and Lesotho holidays |
| `nca-only.ts` | 404 for NCA-only API routes |
