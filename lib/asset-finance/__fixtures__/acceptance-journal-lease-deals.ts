/**
 * Journal acceptance deals for leases (slice 4b); see ./acceptance-journal-deals.ts
 * for the rules and the status of these figures (worked by hand, synthetic cents).
 * VAT is 15%, half-up per line. Dr is +, Cr is -.
 *
 * Lease asset: cash price R11 500.00 incl. VAT (excl 1 000 000, VAT 150 000), no deposit or
 * trade-in, so the supplier is paid 1 150 000:  Dr leased assets 1 000 000, Dr input VAT 150 000, Cr bank 1 150 000.
 * Rental invoice (rental 100 000 + maintenance 20 000, VAT 15 000 + 3 000 = 18 000, total 138 000):
 *   Dr lease debtors 138 000, Cr rental income 100 000, Cr maintenance income 20 000, Cr output VAT 18 000.
 */
import type { SourceCreditNote, SourceLoan, Vector } from "@/lib/accounting/source-types"
import { afLoan, day, invoice, type JournalDeal } from "./acceptance-journal-deals"

const rental = (id: string, iso: string) => ({ id, invoice: invoice(`inv-${id}`, iso, 120_000, 18_000), rentalExclVatCents: 100_000, maintenanceExclVatCents: 20_000, vatCents: 18_000, totalCents: 138_000 })
const credit = (id: string, invoiceId: string, iso: string, exclVatCents: number, vatCents: number, invoiceIncome: SourceCreditNote["invoiceIncome"]): SourceCreditNote =>
  ({ id, invoiceId, issueDate: day(iso), exclVatCents, vatCents, inclVatCents: exclVatCents + vatCents, invoiceIncome })
const RENTAL_INCOME_PARTS: SourceCreditNote["invoiceIncome"] = [{ role: "RENTAL_INCOME", exclVatCents: 100_000 }, { role: "MAINTENANCE_INCOME", exclVatCents: 20_000 }]
const RENTAL: Vector = { LEASE_DEBTORS: 138_000, RENTAL_INCOME: -100_000, MAINTENANCE_INCOME: -20_000, OUTPUT_VAT: -18_000 }
const ASSET: Vector = { LEASED_ASSETS: 1_000_000, INPUT_VAT: 150_000, BANK: -1_150_000 }
const base = (id: string, reference: string, assetFinance: NonNullable<SourceLoan["assetFinance"]>) =>
  afLoan({ id, reference, principal: 138_000 * 4, startDate: day("2026-07-01"), receivableRole: "LEASE_DEBTORS", assetFinance })
const common = { financedFeesCents: 0, payout: { amountCents: 1_150_000, releasedAt: new Date("2026-07-01T09:00:00+02:00") }, inceptionInvoice: null, asset: { exclVatCents: 1_000_000, vatCents: 150_000 } }

/*
 * JRN-LSE-FML-LS — full-maintenance lease, lessee-settled fund, ends with a deficit.
 *   rentals invoiced 08-01, 09-01, 10-01 (a 4th, due 11-01, is not invoiced yet and posts nothing)
 *   fund: contributions 20 000 on 08-01, 09-01 and 10-01 (the rental's maintenance ex VAT); claim 75 000 paid 09-10
 *   balance = 60 000 - 75 000 = -15 000, a deficit: billed 15 000 on 10-14 (SETTLEMENT_BILLED)
 *   end-of-term invoice 2026-10-14: deficit line 15 000 + excess usage 10 000 = 25 000 excl, VAT 3 750, 28 750 incl
 *   The invoice credits the deficit line to the fund liability (it settles the fund; it is not income) and the usage line to rental income:
 *   Dr lease debtors 28 750, Cr output VAT 3 750, Cr fund liability 15 000, Cr rental income 10 000. The billed movement itself posts nothing.
 *   fund liability: -60 000 (contributions) + 75 000 (claim) - 15 000 (the invoice's deficit line) = 0 once settled
 *   credit note A (2026-09-20) on rental 2: 12 000 excl, VAT 12 000 x 15% = 1 800, 13 800 incl. The invoice credited rental 100 000 and
 *     maintenance 20 000, so the credit is spread 10 000 / 2 000 (exact): Dr rental income 10 000, Dr maintenance income 2 000,
 *     Dr output VAT 1 800, Cr lease debtors 13 800
 *   credit note B (2026-10-05) on rental 3: 100 excl, VAT 15, 115 incl. Spread 100 x 100/120 = 83.33 and 100 x 20/120 = 16.67:
 *     floors 83 + 16 leave 1 cent, which goes to the larger remainder (maintenance, .67): rental 83, maintenance 17
 *     Dr rental income 83, Dr maintenance income 17, Dr output VAT 15, Cr lease debtors 115
 *   asOf 2026-11-01. Receivable = 3 x 138 000 + 28 750 - 13 800 - 115 = 428 835 (no receipts)
 */
const LS: JournalDeal = {
  id: "JRN-LSE-FML-LS",
  description: "Full-maintenance lease, lessee-settled fund, deficit billed at the end of term",
  asOf: "2026-11-01",
  loan: base("jrn-ls", "AF-LS-0001", {
    ...common, contractType: "FULL_MAINTENANCE_LEASE",
    rentals: [rental("ls-1", "2026-08-01"), rental("ls-2", "2026-09-01"), rental("ls-3", "2026-10-01")],
    sundryInvoices: [{ ...invoice("inv-ls-eot", "2026-10-14", 25_000, 3_750), fundBilledExclVatCents: 15_000 }],
    creditNotes: [credit("cn-ls-a", "inv-ls-2", "2026-09-20", 12_000, 1_800, RENTAL_INCOME_PARTS), credit("cn-ls-b", "inv-ls-3", "2026-10-05", 100, 15, RENTAL_INCOME_PARTS)],
    fund: { riskModel: "LESSEE_SETTLED", movements: [
      { id: "m1", kind: "CONTRIBUTION", amountCents: 20_000, occurredOn: day("2026-08-01") },
      { id: "m2", kind: "CONTRIBUTION", amountCents: 20_000, occurredOn: day("2026-09-01") },
      { id: "m5", kind: "CONTRIBUTION", amountCents: 20_000, occurredOn: day("2026-10-01") },
      { id: "m3", kind: "CLAIM", amountCents: 75_000, occurredOn: day("2026-09-10") },
      { id: "m4", kind: "SETTLEMENT_BILLED", amountCents: 15_000, occurredOn: day("2026-10-14") },
    ] },
    recoveries: [],
  }),
  expected: {
    "lease:jrn-ls:asset": ASSET,
    "lease-rental:ls-1": RENTAL, "lease-rental:ls-2": RENTAL, "lease-rental:ls-3": RENTAL,
    "lease-invoice:inv-ls-eot": { LEASE_DEBTORS: 28_750, OUTPUT_VAT: -3_750, MAINTENANCE_FUND_LIABILITY: -15_000, RENTAL_INCOME: -10_000 },
    "lease-credit:cn-ls-a": { RENTAL_INCOME: 10_000, MAINTENANCE_INCOME: 2_000, OUTPUT_VAT: 1_800, LEASE_DEBTORS: -13_800 },
    "lease-credit:cn-ls-b": { RENTAL_INCOME: 83, MAINTENANCE_INCOME: 17, OUTPUT_VAT: 15, LEASE_DEBTORS: -115 },
    "mf:m1": { MAINTENANCE_INCOME: 20_000, MAINTENANCE_FUND_LIABILITY: -20_000 },
    "mf:m2": { MAINTENANCE_INCOME: 20_000, MAINTENANCE_FUND_LIABILITY: -20_000 },
    "mf:m5": { MAINTENANCE_INCOME: 20_000, MAINTENANCE_FUND_LIABILITY: -20_000 },
    "mf:m3": { MAINTENANCE_FUND_LIABILITY: 75_000, BANK: -75_000 },
  },
  receivableCents: 428_835,
}

/*
 * JRN-LSE-FML-LR — full-maintenance lease, lender-risk fund, bought by the lessee at the end.
 *   rentals invoiced 08-01 and 09-01; the fund's contributions post nothing (the maintenance is income)
 *   claim 12 000 paid 09-05: Dr maintenance expense 12 000, Cr bank 12 000
 *   purchase invoice 2026-10-10: asset sold at 800 000 excl, VAT 120 000, 920 000 incl
 *   Dr lease debtors 920 000, Cr output VAT 120 000, Cr asset disposal proceeds 800 000 (nothing to rental income)
 *   a receipt of 276 000 on 2026-09-02 (two rentals paid). asOf 2026-11-01.
 *   credit note (2026-10-12) on the purchase invoice: 10 000 excl, VAT 1 500, 11 500 incl, all of it asset-sale income:
 *   Dr asset disposal proceeds 10 000, Dr output VAT 1 500, Cr lease debtors 11 500
 *   Receivable = 2 x 138 000 + 920 000 - 276 000 - 11 500 = 908 500.
 */
const LR: JournalDeal = {
  id: "JRN-LSE-FML-LR",
  description: "Full-maintenance lease, lender-risk fund, asset bought by the lessee",
  asOf: "2026-11-01",
  loan: {
    ...base("jrn-lr", "AF-LR-0001", {
      ...common, contractType: "FULL_MAINTENANCE_LEASE",
      rentals: [rental("lr-1", "2026-08-01"), rental("lr-2", "2026-09-01")],
      sundryInvoices: [invoice("inv-lr-buy", "2026-10-10", 800_000, 120_000, 800_000)],
      creditNotes: [credit("cn-lr-a", "inv-lr-buy", "2026-10-12", 10_000, 1_500, [{ role: "ASSET_DISPOSAL_PROCEEDS", exclVatCents: 800_000 }])],
      fund: { riskModel: "LENDER_RISK", movements: [
        { id: "n1", kind: "CONTRIBUTION", amountCents: 20_000, occurredOn: day("2026-08-01") },
        { id: "n2", kind: "CONTRIBUTION", amountCents: 20_000, occurredOn: day("2026-09-01") },
        { id: "n3", kind: "CLAIM", amountCents: 12_000, occurredOn: day("2026-09-05") },
      ] },
      recoveries: [],
    }),
    payments: [{ id: "pay-lr", amount: 276_000, paymentMethod: "EFT", receivedAt: new Date("2026-09-02T10:00:00+02:00"), allocationStatus: "ALLOCATED", reconciledAt: null, reversed: false, reversedAt: null, parentPaymentId: null, defaultInterestAllocated: 0, chargeFeesAllocated: 0 }],
  },
  expected: {
    "lease:jrn-lr:asset": ASSET,
    "lease-rental:lr-1": RENTAL, "lease-rental:lr-2": RENTAL,
    "lease-invoice:inv-lr-buy": { LEASE_DEBTORS: 920_000, OUTPUT_VAT: -120_000, ASSET_DISPOSAL_PROCEEDS: -800_000 },
    "lease-credit:cn-lr-a": { ASSET_DISPOSAL_PROCEEDS: 10_000, OUTPUT_VAT: 1_500, LEASE_DEBTORS: -11_500 },
    "mf:n3": { MAINTENANCE_EXPENSE: 12_000, BANK: -12_000 },
    "payment:pay-lr": { BANK: 276_000, LEASE_DEBTORS: -276_000 },
  },
  receivableCents: 908_500,
}

export const LEASE_JOURNAL_DEALS: JournalDeal[] = [LS, LR]
