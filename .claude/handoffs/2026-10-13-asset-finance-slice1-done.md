# Handoff — Asset finance slice 1 built (2026-10-13)

Goal executed: `.claude/handoffs/2026-10-13-asset-finance-slice1-goal.md`.
Design: `docs/asset-finance/DESIGN.md`. **Nothing is merged; Hein merges.**

## The three stacked PRs (merge in this order)

| PR | Branch | Worktree | Items | Review state |
|---|---|---|---|---|
| #48 → main | `feat/asset-finance-foundation` | `../CredaFlow-af-a` | 4.1 schema, 4.2 regime gates, 4.3 classifier/overrides | Blind review team + 6 breaker rounds; final verdict **SHIP**; CI green |
| #50 → #48 | `feat/asset-finance-engine` | `../CredaFlow-af-b` | 4.4 solver/rates/repricing, 4.8 VAT/tax invoices | Review team + 3 breaker rounds; final verdict **SHIP** |
| #59 → #50 | `feat/asset-finance-origination` | `../CredaFlow-af-c` | 4.5–4.7, 4.9–4.13 | Review team + browser walk-through + 3 breaker rounds; last round **SHIP** (LOWs since fixed, last commit under review at writing) |

**Main keeps moving** (#49, #55, #58, #60 merged during this session). #48 was
merged with main twice and was green; it now conflicts again with the latest
main. At merge time, merge `origin/main` into #48 once more (then #48 into #50,
#50 into #59) and re-run the gates. Conflicts so far were mechanical: the
`TENANT_SCOPED_MODELS` list and its test, `AuditAction` keys, and new main code
that reads `application.client`/`loan.client` (narrow with `lib/borrower.ts`:
`hasClientBorrower` / `requireClientBorrower`, as done in
`lib/credit-checks/load-facts.ts`). The seed now uses main's `demoLender()`.

#48 contains merges of `origin/main` (up to #49);
#50 and #59 contain merges of their base (no force-pushes anywhere). After #48
merges, retarget #50 to main, then #59.

## Evidence (all re-run on the final heads)

- `tsc` 0, lint clean, full `npm test` green on each branch (≈13.1k tests on #59).
- `bash scripts/run-integration-tests.sh` on a fresh Postgres 16: gate OK on each
  branch (two known flakes outside this work passed on re-run:
  `lib/website-chat/handoff-caps`, `lib/kyc/face-match-v3-pipeline`).
- `prisma migrate diff` no drift; `prisma migrate reset` + seed runs twice clean.
- NCA render pins: `charges-off-identity` green; `scripts/nca-pdf-fingerprint.ts`
  output identical to main.
- Every DB rule mutation-verified (rule removed → its `RUN_*_IT` case red); the
  solver checked against an independent day-by-day oracle (200 random structures,
  every preset, balloon, skip, mid-term rate change); three synthetic acceptance
  deals derived independently and pinned to the cent.
- Screenshots: `docs/asset-finance/evidence/slice1/` (65+ walkthrough PNGs, staff +
  portal, light/dark, desktop/mobile; agreement DRAFT watermark; tax invoice;
  statement; surety denied 404). README there lists them and the seed logins.

## Confirmation gates — none crossed

No migration applied outside throwaway docker DBs; DRAFT watermark flag never
flipped (no UI to flip it); VAT supply timing marked UNTESTED; no new third-party
integration (company AVS and commercial bureau not added); nothing merged or
deployed; consumer NCA documents byte-identical.

## Decisions Hein / the lender / legal must make

1. **Legal (D5):** NCA thresholds R1m / R250k, the trust rule (s1 "juristic
   person"), and the `>=` boundaries — `lib/asset-finance/nca-thresholds.ts`,
   `nca-classifier.ts` (`// UNTESTED: citation/boundary to confirm with legal`).
2. **Legal:** agreement, suretyship and resolution wording (placeholders; DRAFT
   watermark until `TenantConfig.assetFinanceLegalWordingApproved`). Today a deal
   can be CONTRACTED and booked while documents are DRAFT — recommend requiring
   the flag before the first real lender. Also: who signs for a CC/partnership with
   no authorised signatory; whether the resolution is signed by directors/trustees.
3. **Tax advisor:** supply timing (`lib/vat/tax-invoice.ts` UNTESTED), the s20(4)
   content list, the tax-fraction VAT split, and VAT on financed fees (fees are not
   invoiced today).
4. **Settlement method (NON_NCA):** early settlement currently quotes all remaining
   scheduled interest (pinned in `lib/asset-finance/settlement-balloon.test.ts`).
   Must come from the client's deal pack (acceptance requires their figures to the
   cent).
5. **Credit policy:** DSCR denominator (instalments averaged per year, balloon
   excluded); `REPRICE_NOTICE_DAYS = 14`; payout amount = cash price − deposit −
   trade-in (assumes deposit is paid to the supplier).
6. **Portal authority:** one CREDIT_OFFICER can add a DIRECTOR/AUTHORISED_SIGNATORY,
   which grants portal access and signing — no second approver (security M2).
7. **Customer wording:** entity reminder/receipt messages (3 WhatsApp + 2 email)
   need approval and Meta template registration; existing tenants need
   `seedDefaultMessageTemplates` re-run.
8. **Money limits:** Loan/schedule/invoice columns are Int32 cents — a deal is
   capped near R21.47m (booking refuses cleanly). BigInt for those is a schema call.
9. **Charges switch:** one tenant switch governs NCA and NON_NCA default charges.
10. **NCR scope:** NON_NCA loans are excluded from the NCR return and exports;
    bureau files exclude entity loans; NCA-classified entity loans (slice 2) need a
    legal view on bureau reporting.

## Known gaps / follow-ups (not blocking slice 1)

- `// PARTIAL:` markers: repricing doesn't notify borrowers (bell item to loan
  admins only) and refuses NCA asset loans and contract variations; NON_NCA
  default interest uses the loan's current rate across replayed history
  (`lib/asset-finance/non-nca-charges.ts`); classification treats evidence ids as
  verified once the entity's AFS docs are verified (no separate figure-check flag).
- `// UNTESTED: NCA treatment of capitalised interest` (`schedule-records.ts`) —
  slice 2 (s103).
- Deals changed mid-signing: cancel and re-do (cancel path exists; no
  void-and-re-prepare).
- `logDocumentContentAccess` (main) and consumer signing routes (agreement/debit-mandate/documents sign) still record
  the client-supplied first `X-Forwarded-For` as signer IP — fix on main with
  `callerIp` (asset finance already does).
- Supplier AVS: company AVS isn't supported by the provider; payout relies on the
  manual verification evidence item.
- Seed copies some route logic (entity create, document verify) — would drift if
  routes change.
- Client acceptance pack slot `CLIENT_DEALS` is empty (test skipped with a message).

## Local state

- Throwaway Postgres container `cf-it-af` (127.0.0.1:55520, password `it`) with
  DBs af_a/af_b/af_c — safe to `docker rm -f cf-it-af`.
- Worktrees `../CredaFlow-af-a`, `-af-b`, `-af-c` (clean, pushed). Backup branch
  `backup/af-engine-rebased` (local only) can be deleted.
- Demo seed portal logins take passwords from `SEED_AF_DIRECTOR_PASSWORD` /
  `SEED_AF_SURETY_PASSWORD`.
- Bureau checks (`app/api/asset-finance/deals/[id]/bureau-checks/route.ts`): if
  one subject throws, later subjects are skipped and the route's audit row isn't
  written for enquiries already made (their compliance records exist); a "busy"
  result isn't shown on the deal page.
- Migrations on these branches were edited in place during review; they were
  only ever applied to throwaway DBs. Don't apply any of them to a shared DB
  before merge.
