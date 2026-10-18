# Lender-owned asset-finance legal templates — specification

Goal: `.claude/handoffs/2026-10-18-lender-owned-legal-templates-goal.md`.
Base: origin/main `e09956d5`. This is the spec written before the build; the
rule-to-test matrix at the end is updated with the test that proves each rule.

## 1. Document inventory

Every asset-finance PDF on main, its render path, and whether a lender template
selects its wording.

| Document | Renderer | Variant(s) | Issued / signed by | Today's gate | Template family |
|---|---|---|---|---|---|
| Instalment sale agreement (commercial) | `documents/agreement-pdf.ts` | CPA applies / does not (`isaCpaApplies`) | `signing-prepare.ts` → `DealSigner`; e-sign `signing-esign.ts`; contract `signing-contract.ts` | flag watermark | `af.isa.cpa`, `af.isa.commercial` |
| Operating lease agreement | `documents/lease/agreement-pdf.ts` | CPA / commercial | as above | flag watermark | `af.lease.operating.cpa`, `af.lease.operating.commercial` |
| Full-maintenance lease agreement | same | CPA / commercial | as above | flag watermark | `af.lease.fml.cpa`, `af.lease.fml.commercial` |
| NCA instalment agreement (asset) | `documents/nca/agreement-pdf.ts` | natural person (`nca-agreement-store.ts`, ClientDocument + DealSigner) and juristic NCA (`nca-entity-signing.ts`) | portal e-sign of stored bytes; provider countersign | flag watermark + subtitle | `af.nca.instalment_sale` |
| NCA finance lease agreement (asset) | same | as above | as above | as above | `af.nca.finance_lease` |
| Deed of suretyship | `documents/suretyship-pdf.ts` | NCA principal / commercial (`ncaApplies`) | `DealSigner`, wet ink only | flag watermark | `af.suretyship.nca`, `af.suretyship.commercial` |
| Entity resolution | `documents/resolution-pdf.ts` | one (entity type is data, not wording) | `DealSigner` | flag watermark | `af.resolution` |

System-only (not lender templates), unchanged by this work and still governed
by `TenantConfig.assetFinanceLegalWordingApproved`:

| Document | Why system-only |
|---|---|
| NCA asset pre-agreement quotation (`nca/quote-pdf.ts`) | NCA s92 statutory disclosure; the consumer acknowledges its hash before the agreement (`pasq*`). Its content is the disclosure itself. |
| NCA valuation / final / surrender / recovery notices, surplus instruction (`nca/*-pdf.ts`) | Statutory notices (s127, s129, s131) whose every sentence is an obligation the system computes and times. |
| Lease expiry notice, inspection report, termination quote, statements (`lease/*.ts`, `statement-pdf.ts`, `post-sale-statement.ts`) | Servicing notices produced from ledger events; their figures and CPA s14 content are system obligations. |
| Consumer NCA documents (`lib/pdf/*`) and consumer PASQ | Out of scope; pinned. Not touched. |

Boundary: a lender template owns contractual wording a lender may legitimately
vary between lenders. A notice whose content is a statutory obligation stays
system-only; its prose being editable would not make the obligation configurable.

## 2. Three responsibilities

1. **Identity/branding** — `getLenderIdentity(tenantId)` (legal/trading name,
   registration, NCR, office). Never in a template. Snapshotted on issuance.
2. **Lender wording** — a versioned `DocumentTemplateVersion` of kind
   `ASSET_FINANCE`: (a) replacement text for a small whitelist of *editable
   clauses* and (b) up to 10 *additional terms* appended after the last
   protected clause of the terms section, numbered on from it. Nothing else.
3. **Protected content** — sections, party/goods/supplier particulars, pricing,
   schedules, rate and recalculation clauses, enforcement, statutory notices,
   CPA s49/s48 appendices and the NCA/CPA variant logic, signatures: rendered by
   the existing trusted renderers from validated deal data. A template cannot
   remove, reorder, renumber or replace them.

### Editable surface (`lib/asset-finance/documents/templates/families.ts`)

| Family | Editable clauses (number) | Required tokens |
|---|---|---|
| `af.isa.*` | Insurance of the goods (7.6); Cession and assignment (7.11); Domicilium and notices (7.12) | 7.12: `{{lender.registeredOffice}}`, `{{purchaser.domicilium}}` |
| `af.lease.*` | Cession and assignment (9.13 operating / 9.13 FML) | — |
| `af.nca.*` | none — additional terms only (clause 11.3's s90 saving clause stays protected and covers them) | — |
| `af.suretyship.*` | none — additional terms only | — |
| `af.resolution` | none — additional terms only | — |

CPA appendices that `cpaInstalmentSaleClauses` adds (s49 notice, s48 costs, CPA
cession saving) are applied **after** an override, so they cannot be removed.

### Lender text validation (`templates/validate.ts`, server-side on create, preview, approve and issue)

- Plain text; WinAnsi-printable only (a character the PDF fonts would substitute is refused).
- No money (`R 1`, `R1`, `ZAR`, `rand`), no percentages/rates (`%`, `per cent`,
  `basis points`): figures come only from protected sections.
- Tokens only from the whitelist (`lender.legalName`, `lender.tradingName`,
  `lender.registeredOffice`, `agreement.reference`, `purchaser.domicilium` for
  ISA 7.12); unknown or malformed `{{…}}` refused; required tokens enforced.
- `clause N.M` references must name a clause that exists in that document.
- Editable clause text 20–6000 chars; additional term heading 3–80, text
  20–4000; ≤10 additional terms. Blank editable clause refused (cannot omit).
- Semantic limits that cannot be machine-checked (e.g. a sentence claiming
  behaviour the system does not perform) are an approval responsibility: the
  approver attests to having read the full preview and that the wording
  changes no fee, rate, schedule, statutory right or system process. This is a
  stated proof limit, not a guarantee.

## 3. Versions, approval and publication

Reuses `DocumentTemplate` / `DocumentTemplateVersion` and the existing routes
under `app/api/documents/templates/`; `kind = ASSET_FINANCE` branches into
`lib/asset-finance/documents/templates/*`.

- **Adopt** (`POST /api/documents/templates/asset-finance/adopt {family}`): creates
  this tenant's template per variant (key = family key, `requiresApproval = true`)
  and a version-1 DRAFT holding the *current starter text* of the editable clauses
  copied into `content`. Idempotent per tenant/key; audited. Nothing is copied
  from another tenant. Later starter changes never alter a lender's stored text
  (the version records `starterRevision`; the editor flags a newer starter).
- **Edit** = new DRAFT version (`POST …/versions` with `content`). Versions are
  immutable (DB trigger): approved/issued content cannot change in place.
- **Content hash**: `content` is canonical JSON text; the DB computes and checks
  `contentSha256 = sha256(content)`.
- **Approve** (`POST …/approve {contentSha256, attestation, legalSignOffReference?}`):
  DRAFT only, not yet approved, approver ≠ author, approver a user of the tenant,
  TOTP-verified session (demo waiver only under `demoStaffWithoutTotp`, audited),
  the posted hash must equal the stored hash (stale approval refused). The
  approval binds `approvedContentSha256` + the template's family/variant scope.
- **Basis** (server-derived, never posted): `TenantConfig.isDemoLender` →
  `SYNTHETIC_DEMO`; otherwise `LENDER_LEGAL`, which requires a legal sign-off
  reference and is refused when `DEMO_MODE` is on. DB triggers refuse
  `LENDER_LEGAL` on a demo lender and `SYNTHETIC_DEMO` on a non-demo lender.
- **Publish**: approved DRAFT only, publisher ≠ approver, TOTP; locks the template
  row, archives the previous ACTIVE, sets `currentVersionId`. DB: one ACTIVE per
  template (partial unique index); AF versions move DRAFT→ACTIVE→ARCHIVED only
  (no republish of an archived version: copy it to a new draft and approve it);
  ACTIVE requires a matching approval; `currentVersionId` must be an ACTIVE
  version of the same template.

### Relationship to `assetFinanceLegalWordingApproved`

The boolean no longer affects any template-family document: it neither removes
the watermark nor authorises issuance. No tenant is promoted by the migration.
It continues to govern only the system-only notices above. The settings page says so.

### Watermarks

| Situation | Mark |
|---|---|
| Template preview, any version | `DRAFT — NOT FOR EXECUTION` (unchanged) |
| Issued from a `SYNTHETIC_DEMO` approval | `SYNTHETIC DEMO — NOT LEGALLY APPROVED` on every page; NCA subtitle says the same |
| Issued from a `LENDER_LEGAL` approval | none |
| No active approved version | issuance refused |

## 4. Issuance and provenance

`selectIssuableTemplate(tx, tenantId, familyKey)` reads the template's
`currentVersionId` inside the issuing transaction and refuses unless that
version is ACTIVE, approved, `approvedContentSha256 = contentSha256`, basis
matches the tenant and the content still validates. No fallback to the starter
or to another tenant.

New table `AssetDocumentIssuance` (one row per rendered document): tenant, deal,
document kind, family key, template/version ids, version number, content hash,
approval basis/approver/time/reference, `systemRevision`, lender identity
snapshot (company data, no personal data), input snapshot hash + storage path
(the canonical render input, which contains personal data, is stored in
`lib/storage` like the PDF, never in the DB, logs or audit rows), PDF hash +
storage path, issued at/by. `DealSigner.issuanceId` links each signer row.

DB enforcement: insert only from an ACTIVE, approved version of the same tenant
whose hashes match, with a matching basis; the row is immutable except a single
`supersededAt` stamp when an unsigned preparation is replaced (its personal-data
files are then deleted as today; the hashes, version and approval remain).
A new `DealSigner` row that binds a document must carry an `issuanceId` whose
`pdfSha256` equals its `documentSha256`.

Signing and contracting re-render with the **issuance's pinned version content
and identity snapshot** (not the current active version or identity) and
compare hashes, so a later publication or identity edit never switches or
blocks the document a signer was shown; a changed deal still refuses. Rows
prepared before this migration (no issuance) stay downloadable; an unsigned
legacy row cannot be e-signed ("prepare the documents again"). Downloads serve
stored bytes (unchanged). Suretyships stay wet-ink only.

## 5. Schema / compatibility

Additive only: new enum value `ASSET_FINANCE` (own migration), new enum
`DocumentTemplateApprovalBasis`, nullable columns on `DocumentTemplate`,
`DocumentTemplateVersion`, `DealSigner`, new table `AssetDocumentIssuance`,
triggers/CHECKs scoped to `ASSET_FINANCE` templates except: one-ACTIVE-per-
template unique index (the publish route already maintains it) and the
`currentVersionId` belongs-to-template check. Existing CUSTOM/SYSTEM behaviour
is unchanged.

Behaviour change (deliberate, per goal §3.4): preparing/issuing an in-scope
document now requires the lender's published, approved template. Demo seeds
adopt and approve synthetic templates for their demo lender (`SYNTHETIC_DEMO`).

## 6. Rule-to-test matrix

Filled in during the build; see `ACCEPTANCE.md`.
