# The Kenyan demo lender (KE)

The Kenya counterpart of `docs/non-nca-go-live.md`, which still applies in full: a Kenyan lender is a key-facts lender
(offer letter, key facts statement, loan agreement, arrears letter; no PASQ, no Section 129, no credit life). This page
lists only what is Kenyan. **Kenya is a demo, not a go-live:** every Kenyan fact below is DRAFT until the lender's Kenyan
counsel and finance team confirm it. The end-to-end proof is `lib/non-nca-documents/ke-end-to-end.integration.test.ts`.

## What the demo supports

- Instance jurisdiction KE, currency KES; amounts print as `KSh 1,234.56` on screen and in the documents.
- Client capture: Kenyan national ID (shape only), +254 / 07… / 01… mobiles, the 47 counties, 5-digit postal codes.
- Debit and due dates skip Kenyan public holidays (`lib/jurisdiction/business-days.ts`).
- Products `MPESA30` (KSh 1,000–50,000, 30 days) and `PERSONAL` (KSh 10,000–500,000, 90–1,800 days), each with the
  placeholder CBK approval reference `CBK/DEMO/0001` (`prisma/seed/kenya-products.ts`).
- The lender's own four templates (`prisma/seed/kenya-templates.ts`), SAMPLE wording only. The key facts statement adds
  the CBK approval reference, the excise duty included in the fees and the total cost of credit (interest and fees).
- Payout: manual. The officer records the M-Pesa transaction code (or bank reference) as the payout reference.
- Repayment by M-Pesa, simulated (`lib/mobile-money/.claude.md`): Paybill (C2B) payments quoting the loan reference book
  against the loan; a payment with an unknown reference waits on Payments, M-Pesa until staff allocate or reject it; the
  portal shows the Paybill number and offers "Pay with M-Pesa" (a simulated STK push).
- Arrears letter from the lender's template, emailed with the PDF.

## Environment

| Variable | Value for the demo |
|---|---|
| `MPESA_PAYBILL_SHORTCODE` | A 4–8 digit number (e.g. `600000`). Unset: no M-Pesa panel in the portal. |
| `SIMULATED_MPESA_WEBHOOK_SECRET` | Any secret. Unset: simulated callbacks are refused and "Simulate paybill payment" answers 503. |
| `SIMULATED_INTEGRATIONS` | On a production build only: `screening,simulated-mpesa`. `npm run dev` needs neither. Never on a real lender. |
| `DEMO_MODE` | `true` to offer "Simulate paybill payment" (404 otherwise). With `DEMO_CLEAR_STAFF_TOTP=true` too, staff may clear credit checks without 2FA. |

## Seeding

On a fresh local database, after `npx prisma migrate deploy`:

```bash
DEMO_LENDER=nairobi SEED_PRINT_CREDENTIALS=1 npm run seed:base
```

Not `npm run seed`: that also runs `seed-staging.ts`, which knows nothing about jurisdiction. The seed sets the instance
to KE/KES (refused once any application or loan exists), creates "Demo Nairobi Credit Ltd", the staff
(`admin@`, `credit.officer@`, `loan.admin.one@`, `loan.admin.two@`, `super.admin@`, `payout.confirmer@nairobi-credit.example`),
five borrowers (`<first>.<last>@nairobi-credit.invalid`, IDs 99000001–99000005), the templates, an approval matrix for
ungraded applications, an approved application `APP-SEED-0005` (Kevin Mwangi, `MPESA30`) and verified evidence for
Dennis Kiprono, who applies in the portal.

## Demo script

1. **Portal, Dennis Kiprono:** Apply, `PERSONAL`, KSh 20,000, 180 days. Open the indicative key facts statement (KSh figures,
   CBK reference, excise, total cost of credit), then submit.
2. **Staff, credit officer:** open the application, start the review. The credit checks panel shows `NO_STATEMENT` (the
   seeded statement is old): a loan admin clears it with a written reason (2FA, or the demo waiver above).
3. **Loan admin one:** approve, repayment method EFT (the only method a key-facts approval records; the documents say M-Pesa
   Paybill). The three documents issue and the borrower is emailed.
4. **Admin:** on the client, attest in-person KYC.
5. **Portal:** acknowledge the key facts statement, accept the offer, sign the agreement.
6. **Payout confirmer:** confirm the payout account with a note. **Loan admin two:** pay out, entering an M-Pesa transaction
   code (e.g. `SKA1B2C3D4`) as the reference. The loan gets its reference (`LN-…`).
7. **Portal:** Payments shows the Paybill number and the loan reference as the account number; "Pay with M-Pesa" with a phone
   ending in anything but `0000` books a payment (`…0000` is a cancelled push).
8. **Staff, Payments, M-Pesa:** "Simulate paybill payment" with the loan reference books at once; with a mistyped reference it
   waits UNMATCHED. Allocate it to the loan, confirming the amount.
9. **Collections:** on the seeded loan, or once an instalment is overdue and the DPD job has run, issue the arrears letter.

## UNVERIFIED Kenyan facts

Each is marked UNVERIFIED in the code. Kenyan counsel or finance must confirm or correct it before a real lender.

| Fact | Where | Who confirms |
|---|---|---|
| National ID is 8 digits, Maisha Namba 9; shape only, no checksum, nothing derived from it; shorter old IDs refused | `lib/jurisdiction/national-id.ts` | Counsel / NRB |
| Mobile prefixes 07…, 010…, 011…; landlines refused | `lib/jurisdiction/profiles.ts` | Communications Authority numbering plan |
| Public holidays (1 Jan, Good Friday, Easter Monday, 1 May, 1 Jun, 10 Oct, 20 Oct, 12 Dec, 25–26 Dec); a Sunday holiday moves to Monday; gazetted one-off days not modelled | `lib/jurisdiction/business-days.ts` | Counsel |
| Eid al-Fitr dates 2026–2028 are expected, not gazetted; a year missing from the table has no Eid holiday | `KENYA_EID_AL_FITR`, same file | Gazette each year |
| Excise duty 20% on fees, disclosed as **included** in the fees (`fees × 0.2 / 1.2`), not charged on top | `lib/jurisdiction/kenya-rules.ts`, `lib/documents/tokens.ts` | Finance and counsel; charging on top changes the calculator |
| Total cost of credit = interest + initiation fee + service fees | `lib/documents/tokens.ts` | Counsel (CBK disclosure rules) |
| Repayment allocation order principal, fees, interest: **not wired**, the collections engine keeps its own order | `kenya-rules.ts` | Counsel |
| Interest on a non-performing loan capped at the principal outstanding then: **not wired** | `kenya-rules.ts` | Counsel |
| 30 days' notice before a negative CRB listing, no listing below KSh 1,000: **not wired** | `kenya-rules.ts` | Counsel |
| 30 days' notice of a change of terms, 30-day complaint resolution, 14 days before contacting a guarantor: **not wired** | `kenya-rules.ts` | Counsel |
| Arrears letter: any statutory form, period or delivery method | template | Counsel |
| `CBK/DEMO/0001` is a placeholder; the demo lender holds no CBK licence | `kenya-products.ts`, templates | The lender |

## Out of scope

- **Real M-Pesa (Daraja):** only the simulated provider exists (KE-6). No money moves.
- **M-Pesa B2C payouts:** payout is manual and still needs a bank account matching a verified bank statement; a borrower
  paid to an M-Pesa wallet is not supported (KE-7, a design change to the payout account rule).
- **Credit bureaus (CRBs):** no Metropol, TransUnion Kenya or Creditinfo adapter, no CRB submission. Instant approval stays off,
  so every decision is a person's.
- **Kenyan conduct rules** in `kenya-rules.ts` other than the excise disclosure.
- **Time zone:** the system's date is SAST (UTC+2), Nairobi is EAT (UTC+3); between 00:00 and 01:00 EAT the system's date is
  still the previous day, and jobs run on SAST hours. Run the demo in business hours.
- Swahili, SmileIdentity KYC for Kenya (in-person KYC instead), check-off/payroll deduction, USSD, Airtel Money, KRA PIN.
- An M-Pesa repayment method on the approval (`LoanRepaymentMethod` is EFT or DEBIT_ORDER).
- The demo snapshot bake (`scripts/demo`) has no key-facts path.
