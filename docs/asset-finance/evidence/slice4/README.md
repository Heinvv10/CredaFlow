# Asset finance slice 4a — browser evidence (legal matter, recovery, portal)

Captured 2026-10-15 from a local `next dev` on branch `feat/af-slice4-recovery`
(base commit `c168124b` plus the uncommitted consumer-page wiring of this
phase), Chrome 1280 px wide for desktop and 390 px for mobile. Every name,
number, VIN and document is synthetic. The notices are DRAFT: their wording
needs the lender's legal sign-off (`// UNTESTED: legal`).

## State used

- A throwaway Postgres 16 (`scripts/it-db.sh`), `npx prisma migrate reset
  --force` (migrations plus the seed), **staff TOTP on**. Staff signed in with
  password and the TOTP code generated from the seeded secret
  (`lib/totp.ts generateTotpCode`) as `loan.admin.one@acme-lending.example`
  (proposer, recorder, completer) and `loan.admin.two@acme-lending.example`
  (second approver). Passwords were set through the `SEED_*_PASSWORD`
  variables for the run; none is in source.
- The deal walked through the whole path is **TEST Family Farming Trust's NCA
  finance lease** (seeded, booked, ACTIVE, `ncaRegime = NCA`, an entity
  borrower). The seed has no other booked NCA instalment sale that is not
  already recovered (the sole proprietor's TLB instalment sale is seeded at
  SHORTFALL_OPEN), so the finance lease stands in for the "NCA instalment
  sale".
- Two things were set by SQL on that loan, because nothing in the seed does
  them: a COMPLETED `SECTION_129_NOTICE` ComplianceRecord (completed 28 Aug
  2026, `data.lifecycle = ISSUED`, the shape the manual attorney-referral
  route requires) and `collectionsStage = SECTION_129_SENT`. Everything else
  went through the staff screens and the app's routes. No trigger was disabled.
- Step dates were typed (the section 129 step on 1 Sep 2026, its summons
  10 SA business days later or more), so the dates in the shots are those of
  the walk-through, not "today" (15 Oct 2026).
- The seeded recoveries (shots 30 to 32) come from the same seed, untouched.

## Staff walk-through, light desktop

| # | Screen | What it shows |
|---|---|---|
| 01 | Legal matter | The loan has no matter; "Open legal matter" |
| 02 | Legal matter | Opened (OPEN, NCA); next step "Send the section 129 notice" |
| 03 | Legal matter | Appointing the attorney before a section 129 step is refused with the server's sentence, verbatim |
| 04 | Legal matter | Section 129 step recorded against the completed notice record, with an evidence file; next step "Summons may issue from 15 Sept 2026" |
| 05 | Legal matter | Attorney (a supplier) appointed from 3 Sep 2026 |
| 06 | Legal matter | A summons dated 8 Sep (fewer than 10 business days after the section 129 step) refused, verbatim |
| 07 | Legal matter | Summons issued and served, judgment recorded; next "apply for the attachment order" |
| 08 | Legal matter | Attachment order recorded; next "attach the asset and record it as recovered" |
| 09 | Legal matter | ASSET_RECOVERED (yard and condition) recorded: the timeline is complete |
| 10 | Recovery | The recovery that step created (NCA s131 attachment, RECOVERED) with the stepper including the notice steps |
| 11 | Recovery | Valuation recorded (R 320 000, assessor); next "Issue the valuation notice" |
| 12 | Recovery | Valuation notice issued; next "List for sale" |
| 13 | PDF | First page of the s131 valuation notice (`13-valuation-notice-draft.pdf`, DRAFT watermark) |
| 14 | Recovery | Listed for sale: the sale form (valuation relied on, buyer, price) |
| 15 | Recovery | A towing cost recorded by loan admin one: pending, no approve button for its recorder |
| 16 | Recovery | The same cost seen by loan admin two, who can approve or reject it |
| 17 | Recovery | The cost approved; the ledger and the deducted total |
| 18 | Recovery | A sale at R 280 000, under the R 320 000 valuation, with a reason: "Needs a second person"; its proposer can only wait |
| 19 | Recovery | The same sale seen by loan admin two: "Approve sale" |
| 20 | Recovery | Approved; "Complete sale" |
| 21 | Recovery | Sold (the buyer's tax invoice and the VAT event are made on completion); next "Apply the sale proceeds" |
| 22 | Recovery | Proceeds applied: settlement R 382 131.83, net R 278 000 after R 2 000 costs, shortfall R 104 131.83; the charge freeze runs 15 to 29 Oct; next "Issue the final notice" |
| 23 | Recovery | Final notice issued; next "Open the outcome" |
| 24 | PDF | First page of the s131 final account notice (`24-final-notice-draft.pdf`): valuation, settlement, proceeds, costs, shortfall, DRAFT watermark |
| 25 | Recovery | Outcome SHORTFALL_OPEN, the finished stepper, the sale, the account, notices and the cost ledger |

## Final state, other themes and widths

| # | Screen | What it shows |
|---|---|---|
| 26 | Recovery, dark desktop | Shot 25 in dark |
| 27 | Recovery, dark 390 px | Stepper stacked, figures in one column, ledger scrolls inside its card; no page-level sideways scroll |
| 28 | Recovery, light 390 px | The same in light |

## Portal

| # | Screen | What it shows |
|---|---|---|
| 40 | Portal, trustee, `-light-desktop`, `-dark-desktop`, `-dark-390`, `-light-390` | The borrower's "Recovery of your asset" card on the trust's contract page: SHORTFALL OPEN, valuation, notices issued (valuation and final), sale proceeds, costs deducted, net proceeds, shortfall owed, the charge freeze to 29 Oct and the cost lines. No buyer, sale or screening detail |

The trustee signs in at `/portal/login` as `test.trustee.one@acme-lending.invalid`
(`SEED_AF_TRUSTEE_PASSWORD`).

## Seeded recoveries as staff see them (light desktop)

| # | Screen | What it shows |
|---|---|---|
| 30 | Recovery on the sole proprietor's TLB instalment sale | Seeded NCA s131 recovery at SHORTFALL_OPEN: sale R 400 000 under the R 450 000 valuation (approved), R 6 500 storage deducted, shortfall R 374 696.19. This loan's staff page is the consumer loan page, which now shows the Legal and Recovery panels for any loan on an asset |
| 31 | Legal matter on the same loan | The seeded matter that produced it |
| 32 | Recovery on the seeded full-maintenance lease | Seeded NON_NCA voluntary recovery at LISTED (valuation R 320 000, R 4 200 storage approved): the non-NCA stepper has no notice steps |
