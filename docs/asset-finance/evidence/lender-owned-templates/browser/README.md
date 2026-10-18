# Lender-owned templates: two-lender browser acceptance (synthetic)

**Result: 53/53 checks passed** (`result.json`), 0 browser page errors. Synthetic data only.

## Environment

- Source: commit `cd6f83c5ed755b1bc63c6808ccfda6759e06d99e` (branch feat/lender-owned-templates), plus the
  uncommitted seed `lib/asset-finance/documents/templates/two-lender-browser-seed.test.ts`. The app, the
  migrations and the seed ran from a frozen copy (`git archive` of that commit, with its own generated Prisma
  client and hard-linked node_modules), so later edits in the worktree could not hot-reload into the run.
- `next dev` (16.4.1), Node 20, its own disposable PostgreSQL 16 (`scripts/it-db.sh up cf-it-lotdemo`),
  `prisma migrate deploy`/`reset` from that tree. Hosts `alpha.localhost` / `bravo.localhost` through
  `TENANT_HOST_MAP`. TRUSTED_PROXY, DEMO_MODE, CRON_SECRET and every provider key were unset. No message,
  payment, bureau call or deployment left the machine.
- Seed: `TWO_LENDER_BROWSER_SEED=1 npx vitest run lib/asset-finance/documents/templates/two-lender-browser-seed.test.ts`
  on an owned, migrated DB. It builds two demo lenders (`isDemoLender`, `requireStaffTotp`) with complete
  synthetic identities, author/approver LOAN_ADMINs and a CREDIT_OFFICER with bcrypt passwords and TOTP
  secrets, and APPROVED deals through the real routes, with **no templates adopted**. Private metadata
  goes to `/tmp/claude-1003/lot-browser.json`, never the repo.
  - Alpha ("Synthetic Alpha Asset Finance (Pty) Ltd" t/a "Alpha Demo Finance"): two commercial instalment
    sales, a CPA instalment sale (R1.5m-turnover company), and an entity NCA finance lease with its PASQ
    acknowledged.
  - Bravo ("Synthetic Bravo Equipment Credit (Pty) Ltd" t/a "Bravo Demo Credit"): two commercial
    instalment sales and a CPA operating lease to a sole proprietor.
- Runner: `PORT=<port> IT_CONTAINER=cf-it-lotdemo node browser.cjs` (Playwright and Google Chrome, headless).
  Every login goes through `/login` with a password and then a TOTP code. The runner looks up a few ids
  and hashes with psql. It uses them only to address routes, never as proof.

## Checks

| # | Check | Result |
|---|---|---|
| 1 | Bravo officer: Prepare documents before anything is adopted → 422 "…template has not been adopted…" (01) | PASS |
| 2 | Alpha author adopts af.isa / af.resolution / af.suretyship / af.nca (02) | PASS |
| 2 | Save with "an administration fee of R 500 … notwithstanding …" → 422; reasons shown in the editor (money; "fee") (03) | PASS |
| 2 | ALPHA 7.6 insurance wording and "ALPHA site visits" (7.14) saved as v2 (04) | PASS |
| 2 | Author sees "Awaiting approval by another admin", no Approve control; direct API approve by the author → 409 "Cannot approve your own draft" | PASS |
| 2 | Starter v1 of af.isa.commercial previews (200) | PASS |
| 3 | Approver picks three deal shapes in the "Preview deal" dropdown (prime-linked company; fixed-rate trust; ZARONIA-linked CC, out of 7 offered) and previews v2 under each, all 200, each request carrying its shape (05a) | PASS |
| 3 | Approver previews v2, attests, sees the demo-lender notice, approves → `SYNTHETIC_DEMO` (05, 06) | PASS |
| 3 | Approver sees no Publish control; API publish → 409 "The approver cannot also publish…" | PASS |
| 3 | Author publishes v2 (07); af.isa.cpa, resolution, suretyship.commercial, nca.finance_lease approved and published the same way (08) | PASS |
| 4 | Bravo adopts, saves BRAVO 7.11 cession wording + "BRAVO equipment logbook" term, approver approves, author publishes; resolution, suretyship, lease.operating.cpa likewise (09–12) | PASS |
| 4 | Alpha session: GET Bravo template → 404; approve Bravo version → 404; editor URL shows no Bravo wording (13) | PASS |
| 5 | Officers prepare 5 deals (14–18): panel shows "Template version N (synthetic demo)" and the synthetic-demo banner | PASS ×5 |
| 5 | Every page of every downloaded agreement draws "SYNTHETIC DEMO — NOT LEGALLY APPROVED" (`watermark-pages.ts`, pdf-lib content streams) | PASS ×5 |
| 5 | Alpha commercial: Alpha identity, ALPHA wording only, protected "7.3 Payment" present | PASS |
| 5 | Bravo commercial: Bravo identity, BRAVO wording only, "7.3 Payment" present | PASS |
| 5 | Alpha CPA ISA: "NOTICE UNDER SECTION 49" present, no lender text | PASS |
| 5 | Bravo CPA operating lease: Bravo identity, CPA s49 notices with "Lessee's initials" lines, no lender text | PASS |
| 5 | Alpha NCA finance lease: Alpha identity, NCA clause headings (1 Interpretation … 11 General, "National Credit Act"), no lender text | PASS |
| 6 | Alpha v3 (adds "ALPHA-V3 operator training"): saved, approved, published; v2 shows Archived in history (19) | PASS |
| 6 | Archived v2 still previews (UI button 200, direct 200), text has ALPHA site visits and no ALPHA-V3 | PASS |
| 6 | Second Alpha commercial deal prepared → "Template version 3", ALPHA-V3 text, watermark on every page (20) | PASS |
| 6 | First Alpha deal re-downloaded: identical sha256, still v2, no ALPHA-V3 (21) | PASS |

## Downloaded agreements (sha256)

| Document | Template | sha256 |
|---|---|---|
| alpha-commercial1 | v2 | `f1071703cc597b3ea9ec1451af014902abeb357ec69871de377fe868014977ad` |
| alpha-commercial1 re-download after v3 | v2 | `f1071703cc597b3ea9ec1451af014902abeb357ec69871de377fe868014977ad` (identical) |
| alpha-commercial2 | v3 | `9dcbf803719d921f17d3f9f9c1dc92bc21af174085d3238cde8e62a928e60ccf` |
| alpha-cpa-isa | v1 | `7716f5c8749280ee7a0ac06f7393865d128bf4d00b2666ac806aeac0f60be5c6` |
| alpha-nca-finance-lease | v1 | `f81fe6eb133512a33ecca787ab29fa38632c757065d8ed4c54146009f8af4aa8` |
| bravo-commercial1 | v2 | `69b1c18aca0440c0a379742e4a61bd6c7876580f556f1fbfc2489aa50caab520` |
| bravo-cpa-operating-lease | v1 | `2d5a30c6274eac4ae4f7da760ce1a2c24366af7a58f3329d0e629ff2afb4b518` |

The PDFs are not committed. The extracted text (`*.txt`, `pdftotext -layout`) is. pdftotext does not
extract the diagonal watermark run, so the watermark check reads the page content streams instead.

## Runs that do not count

- A 52/52 run at `1a68ba62` (before the shape-based fingerprints) was replaced by this run.

- An earlier run against the live worktree dev server was invalidated when the schema and migration
  changed mid-session. A second run against the live worktree failed one check: Bravo's commercial
  preparation returned 422 "CredaFlow's protected wording … changed after your approval". The protected
  ISA wording (`lib/asset-finance/documents/wording/instalment-sale.ts`) had been edited and hot-reloaded
  between Bravo's approval and its preparation. The fingerprint gate refused as designed; it is not a
  product bug. That run's files were replaced by this frozen-tree run.
- During the interim, the validator refused the word "replacement", which the af.isa.commercial starter
  clause 7.6 itself uses ("full replacement value"), so the starter failed its own rules. This was fixed
  in the tree before the counted run, where check "starter v1 previewable" passed.

## Not exercised / limits

- Portal e-signing, wet-ink, contracting, payout and booking. Non-demo (LENDER_LEGAL / SUPER_ADMIN)
  approval. FML, NCA instalment sale and suretyship-NCA variants. The 9.13 lease clause edit (Bravo's
  lease is CPA, which takes no lender text).
- The refusal UI showed the money and "fee" reasons. The validator reports the first override word
  only, so "notwithstanding" was not listed separately in that save.
- Each lender's surety and resolution documents were issued but not text-checked; only agreements were.
- The browser can't screenshot an open native `<select>`. Screenshot 05a shows the dropdown with the
  second shape selected; `result.json` (`previewShapes`) lists all 7 options and the three previews made.
  The preview response hash is the content hash, the same for every shape. Each shape's protected wording
  was not compared.
- Cosmetic: in the deal page's Documents & signing header, the prepare form squeezes the panel
  description into a narrow column, and the long refusal text runs off-screen (01).
- One local run on synthetic data. This is not a legal review of any wording.
