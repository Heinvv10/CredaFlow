# Lender-owned asset-finance legal templates — complete

Goal: `2026-10-18-lender-owned-legal-templates-goal.md`. Completed 18 October 2026.

## Merge and source identity

| Item | Value |
|---|---|
| PR | [#183](https://github.com/Heinvv10/CredaFlow/pull/183) `feat/lender-owned-templates` |
| Reviewed / tested head | `a8e51274d2ae4c9362248ada6a82066ec069776a` (merges origin/main d0092e1a; union reviewed SHIP) |
| Merge (mq) | `ecefb3e52b82df1e67b86ce3b854ff5be42ccbf5` (mq add 183, 12:17 UTC; queue empty after) |
| Tree identity | a8e51274 is an ancestor of main; `git diff a8e51274 ecefb3e5` empty |

## What was built

- Lenders adopt the starter wording of all 11 asset-finance variants (ISA commercial/CPA, operating and FML lease commercial/CPA, NCA instalment sale/finance lease, suretyship NCA/commercial, resolution) as their own `DocumentTemplate` (kind `ASSET_FINANCE`) through Settings → Document templates.
- Lender text only on the three commercial agreement variants (editable ISA 7.6/7.11/7.12, lease 9.13; additional terms), validated everywhere. CPA/NCA/suretyship/resolution versions approve the protected starter (legal review).
- Exact-content approval by a second admin after previewing every deal shape; publication by someone else; one ACTIVE version. Demo lenders → SYNTHETIC_DEMO (watermarked); real lenders → LENDER_LEGAL by a SUPER_ADMIN with written sign-off confirmation + reference.
- Approvals bind a fingerprint of the protected output over a fixed set of deal shapes; protected-wording changes lapse approvals (`fingerprint.test.ts` pins; treat a change as a release event).
- Issuance only from the published approved version; immutable `AssetDocumentIssuance` provenance (version, approval, fingerprint, identity, input/PDF hashes, files in storage); e-sign/contract re-render with the pinned version and identity.
- Legacy flag no longer approves template documents; NCA agreement under a legal approval cannot follow a DRAFT quotation (recorded on the immutable quote audit row) and a DRAFT quotation is refused up front in that case.

## Evidence (in `docs/asset-finance/evidence/lender-owned-templates/`)

SPEC (inventory, protected vs editable, compatibility), ACCEPTANCE (criterion and DB-rule → test), MUTATIONS (21, all killed), DB-CATALOG, REVIEW (six independent roles all SHIP; edge repros committed), browser/ (53/53 at cd6f83c5, password+TOTP, two synthetic demo lenders, commercial/CPA ISA, NCA entity finance lease, CPA operating lease, v1 bytes unchanged after v3).

Local `ci:full` (fresh clone, own install, disposable PG16), all exit 0: 17a485c2 (20,017 unit), dff97b05 (20,020), a8e51274 (20,058 unit + 1 expected fail; 3,115 PG; 367/369 suites; the 2 opt-in Docker suites not run). Earlier runs at 1ca53233 and bb313e2e failed (5 unit tests; then 3 PG tests from fixtures) and were fixed — kept as failures in this record. Hosted on a8e51274: run 39123814768 quality pass (14m57s), integration pass (27m9s); on dff97b05: run 39120966777 pass.

## Compatibility and remaining external steps (gated — not done)

- **Demo stacks (other agent's runtime, not touched):** after upgrading, every demo lender needs templates: `npx tsx scripts/asset-finance/ensure-demo-templates.ts <slug> <author> <approver>` (two LOAN_ADMIN+ users) then re-snapshot, or re-bake (the seed does it). After a future protected-wording change, only a re-bake recovers a demo stack.
- **Real lenders:** documents cannot be prepared until each lender adopts, approves (SUPER_ADMIN, legal sign-off) and publishes; no legal approval was recorded anywhere.
- **Lender legal sign-off needed (not code):** meaning of lender text on commercial variants; clause 7.13's exemption for 7.12 notices; commercial finance lease documented on the ISA; CPA s13 if 7.6 nominates an insurer; all starter wording before any legal approval; starter typo "Lender base rate rate" (lease 9.3), pinned as an expected failure.
- Partly signed pre-template deals must be cancelled and originated again (no live data).
- LOW follow-ups: retention/erasure of retained render inputs; preview imports `synthetic-deal.fixture`; future audit-log erasure must exclude `ASSET_NCA_QUOTE_ISSUED`; explicit test that a deactivated approver's approval still issues; prepare-form layout crowding (browser README).

## Cleanup

Goal worktree `CredaFlow-lot`, branch `feat/lender-owned-templates` (local and remote), edge-import branches, the CI clone, the edge tester clone, legal scratch, PDFs and the `cf-it-lot1` container/volume removed; edge DB containers were removed by their agents each round; the browser agent removed `cf-it-lotdemo` and its frozen copy. Shared dirty local main (93f28b01) and its LATEST.md untouched; other sessions' containers and worktrees untouched.
