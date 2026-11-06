<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: jurisdiction
<!-- summary: ZA, LS, KE: currency, ID, holidays, and the one gate for NCA-only steps -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Lets one lender run outside South Africa: `profiles.ts` holds what differs
(ZA|LS|KE, ZAR|LSL|KES), `active.ts` the one this instance runs as. The model,
guards and loader: `docs/ARCHITECTURE.md`, "Jurisdiction".

## Critical Rules
- **ZA must behave exactly as before.** The default (nothing loaded, or a read
  that failed) is ZA / ZAR with the NCA gates ON: failure can only be stricter.
  Currencies per jurisdiction are `allowedCurrencies`, held again by two DB
  CHECKs (`migration.test.ts` compares).
- **Entry points await `ensureActiveJurisdiction()`** (crons, `withTenantContext`,
  `getStaffTenantId`, root layout): add to a choke point, not per file.
  Unloaded, a local "0…" phone normalises to "" (27 or 254?
  `trunkZeroDialCode`): a script must load first or name the jurisdiction.
- **No request can write the instance row**: only `instance-write.ts`
  (`npm run lender:set-jurisdiction`, the demo seed), audited, and refused once
  any application or loan has existed.
- **The guards need READ COMMITTED** (`lockInstanceJurisdiction()` refuses
  otherwise): never write `Tenant`/`TenantConfig` in a stricter transaction,
  and don't insert an application/loan and then a tenant/config in one
  transaction (deadlock risk).
- **Lenders are retired by status, never deleted** (a trigger refuses it once
  they have applications or loans; ITs delete loans first).
- **Gate NCA-only steps with `await ncaOnlyRefusal()` / `ncaOnlyPage()` /
  `ncaOnlyCronSkip()` and declare the surface in `lib/registry/nca-only/`**:
  the census fails on an unlisted NCA-looking route. Never test
  `jurisdiction === "ZA"` inline; jurisdiction-specific facts (ID, mobile,
  regions, postcode, copy) are fields of `profiles.ts`, read through it.
- **Money goes through `formatZAR` / `formatZarPdf`** (active currency). Do not
  add another `"R " + ...` formatter. `formatZarPdf` keeps ZAR's original
  negative form ("R -0.05"): the NCA PDFs are pinned.
- **Statutory deadlines stay South African** (`lib/compliance/sa-business-days.ts`
  is NCA law); debit/due-date logic uses `business-days.ts`, which follows the lender.
- **Lesotho and Kenyan IDs are shape-only** (`national-id.ts`): derive nothing
  from them. Store and compare IDs through `canonicalIdNumber`.
- **KE facts are DRAFT**: every unconfirmed one carries an UNVERIFIED comment
  (`docs/ARCHITECTURE.md` lists them, with the EAT time-zone gap).
- `active.ts` is on `globalThis` (Next bundles entry points separately); the
  browser is primed by `components/JurisdictionProvider`. A change needs a restart.
- Outside ZA the documents are the lender's own templates (`lib/non-nca-documents`);
  the NCA ones refuse to render without an NCR number.

## Key Files
| File | Purpose |
|------|---------|
| `profiles.ts` | Jurisdiction/currency codes and per-jurisdiction facts |
