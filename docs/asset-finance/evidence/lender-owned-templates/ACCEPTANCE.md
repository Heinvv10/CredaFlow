# Lender-owned templates — acceptance

Goal: `.claude/handoffs/2026-10-18-lender-owned-legal-templates-goal.md`.
Spec: [SPEC.md](SPEC.md). Mutation evidence: [MUTATIONS.md](MUTATIONS.md).
Live DB catalog: [DB-CATALOG.md](DB-CATALOG.md). Browser: [browser/](browser/README.md).
Reviews: [REVIEW.md](REVIEW.md).

Test files (all under `lib/asset-finance/documents/templates/` unless noted):

| Short name | File | Kind |
|---|---|---|
| U | `templates.test.ts` | unit: families, content hash, validation, rendering, preview |
| F | `fingerprint.test.ts` | unit: protected-output fingerprints pinned; every shape distinct; branch markers |
| EV | `edge-validator.test.ts` | unit: independent edge tester's validator/render repros |
| G | `templates-governance.integration.test.ts` | real PG (RUN_ASSET_TEMPLATES_IT) |
| I | `templates-issuance.integration.test.ts` | real PG (RUN_ASSET_TEMPLATES_IT) |
| E | `edge-templates.integration.test.ts` | real PG, independent edge tester (RUN_ASSET_TEMPLATES_EDGE_IT) |
| NCA | `lib/asset-finance/deal-decision.integration.test.ts` | real PG: entity NCA finance lease and natural-person NCA instalment sale issued and reproduced |
| LEASE | `lib/asset-finance/lease.integration-fixture.ts` (`signLease`) | every lease suite: lease issuance reproduced per variant |
| NU | `lib/asset-finance/legal-wording-flag-nca-*.test.ts` | unit: NCA issuance mark, refusal, quotation gate |
| BT | `lib/asset-finance/booking-terms.integration.test.ts` | real PG: contract re-render bound to issued identity |

## Success criteria → evidence

| §7 | Criterion | Evidence |
|---|---|---|
| 1 | Inventory/spec of every in-scope document and variant; protected vs editable; compatibility | SPEC §1–§5; U "every family variant's starter content is valid", "which variants take lender text" |
| 2 | Two tenants adopt/customise independently; isolation; no silent starter overwrite | G "adoption is a LOAN_ADMIN's, per lender, idempotent…", G "routes refuse … another lender's template"; I "re-preparing … never ALPHA"; E "another lender's templates … invisible"; browser steps 2–4 |
| 3 | Protected disclosures/calculations/tokens cannot be bypassed (edit, preview, API, publication, issuance); financial rules still pass | U validation + CPA-appendix-after-override; EV; G routes 422; I "refuses a published version whose wording breaks the template rules"; starter render byte-identical (U) and legal sample PDFs reproduced; full ci:full |
| 4 | Exact-version approval, fresh approval after edits, SoD, TOTP, audit; concurrency; raw-DB invariants | G approval / publication / race tests; DB-CATALOG; MUTATIONS s3–s5 |
| 5 | Wrong/missing/stale approval cannot authorise execution; legacy flag cannot approve; demo cannot confer legal authority | I refusals (none, flag on, invalid version, wrong variant, other lender); G demo-basis test; I demo mark survives flag; NU; MUTATIONS m6, s1, s4, s6 |
| 6 | Issued documents retain template/input/identity/approval/PDF provenance; signing/downloads bound to original bytes; history readable | I "issues every document … reproducibly", "after a new publication and an identity change … signed and downloaded exactly as shown", "re-preparing … supersedes (hashes kept)"; NCA; LEASE; BT; MUTATIONS m7, m9 |
| 7 | Browser: both lenders, NCA/CPA/commercial variants, negative gates, v2/history | [browser/README.md](browser/README.md): 53/53 at cd6f83c5, password+TOTP, two synthetic demo lenders; commercial ISA ×2 lenders, CPA ISA, entity NCA finance lease, CPA operating lease; v1 issued bytes unchanged after v3 |
| 8 | PDF/text/render checks; consumer PASQ/pins unchanged | U starter parity; legal sample renderers reproduce committed PDFs; no change under `lib/pdf/`, `nca/quote-pdf.ts`, `lib/compliance/pasq`; browser text extracts |
| 9 | Unit + real-PG + ci:full on the PR; independent reviewers and edge tester SHIP with committed regressions | ci:full and hosted CI: see the PR and final handoff; [REVIEW.md](REVIEW.md); E/EV are the edge tester's committed repros |
| 10 | Merged through mq, ancestry/tree identity | final handoff |
| 11 | Docs, handoff, memory | `docs/ARCHITECTURE.md`, `docs/asset-finance/DESIGN.md`, `legal-wording/README.md`, `lib/asset-finance/.claude.md`; final handoff |
| 12 | Cleanup | final handoff |

## Rule → test (database rules)

| Rule (migration `20261018140100_lender_asset_templates`) | Test |
|---|---|
| Version content immutable, hashed, never deleted | G "the database keeps lender wording immutable…" |
| Approval once, on a draft, not the author, same-tenant LOAN_ADMIN+, exact hash, basis vs demo flag, LENDER_LEGAL only by SUPER_ADMIN | G approval test (raw updates); E "CREDIT_OFFICER" |
| DRAFT→ACTIVE→ARCHIVED only; ACTIVE needs approval and a different publisher; one ACTIVE; `currentVersionId` = the ACTIVE version | G publication + race tests; E raw-SQL guard |
| Issuance only from the current approved version of the same tenant fitting the deal (contract type, regime, CPA); immutable; signed never superseded | I DB refusal test; I sign test; E finance-lease fit |
| New DealSigner binds a current issuance of its bytes; pre-template rows not signed or confirmed; superseded not signed | I legacy-signer test; E superseded-signing |
| Generic CUSTOM/SYSTEM templates unaffected (except one ACTIVE per template) | full ci:full (generic template suites) |
