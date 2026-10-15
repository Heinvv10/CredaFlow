/**
 * Journal acceptance deals (slice 4b): asset-finance contracts as the
 * accounting export sees them (lib/accounting/sources-asset-finance.ts).
 * Every expectation was worked BY HAND from the written rules below, never by
 * calling the code under test; all money is integer cents, all values are
 * synthetic. Asserted by lib/accounting/sources-asset-finance.test.ts.
 *
 * CLIENT_JOURNAL_DEALS is the slot for the client's anonymised deal pack
 * (journals the client's accountant has signed). It is EMPTY until supplied;
 * the test skips that block with a message rather than inventing figures.
 *
 * The schedule rows are hand-built (a 1% monthly rate on the opening balance,
 * rounded half-up; the source reads the STORED amounts, so the rate model does
 * not matter here). Rules the expectations follow:
 *   B(r)       = capital balance the row accrued on (row opening balance)
 *   accrued(r) = B(r+1) - B(r) + totalDue(r)         (B after the last row = 0)
 *   inception  = Dr debtors F, Dr input VAT v, Cr output VAT v, Cr bank payout,
 *                Cr fee income fees;   F = payout + fees
 *   instalment = Dr debtors accrued(r), Cr interest income accrued(r), on its due date
 *   receipt    = Dr bank, Cr debtors
 * Dr is +, Cr is -.
 */
import type { SourceLoan, SourceInvoice, Vector } from "@/lib/accounting/source-types"

/** SAST midnight of a calendar day. */
export const day = (iso: string): Date => new Date(`${iso}T00:00:00+02:00`)

export function invoice(id: string, iso: string, exclVatCents: number, vatCents: number, assetSaleExclVatCents = 0): SourceInvoice {
  return { id, supplyDate: day(iso), issueDate: day(iso), exclVatCents, vatCents, inclVatCents: exclVatCents + vatCents, assetSaleExclVatCents }
}

export interface JournalDeal {
  id: string
  description: string
  /** Sources are desired as at SAST midnight of this day (exclusive). */
  asOf: string
  loan: SourceLoan
  /** Desired cumulative vector of each source, by base key. */
  expected: Record<string, Vector>
  /** Debt on the receivable role at asOf, worked by hand. */
  receivableCents: number
}

export const CLIENT_JOURNAL_DEALS: JournalDeal[] = []

export function afLoan(partial: Partial<SourceLoan> & Pick<SourceLoan, "id" | "reference" | "assetFinance">): SourceLoan {
  return {
    principal: 0, initiationFee: 0, upfrontFee: false, startDate: day("2026-07-15"), status: "ACTIVE", writeOffAt: null, closedAt: null, reversedAt: null,
    schedule: [], charges: [], payments: [], payouts: [], recoveries: [], ...partial,
  }
}

const row = (n: number, id: string, due: string, open: number, interestDue: number, totalDue: number) =>
  ({ id, installmentNo: n, dueDate: day(due), interestDue, feesDue: 0, creditLifePremiumDue: 0, totalDue, totalPaid: 0, openingBalanceCents: open })

/*
 * JRN-IS-1 — instalment sale with a skip period and a balloon.
 *   cash price R11 500.00 incl. VAT (excl 1 000 000, VAT 150 000), deposit 200 000, trade-in 0, financed fees 50 000
 *   payout = 1 150 000 - 200 000 = 950 000;  F = 950 000 + 50 000 = 1 000 000;  booked 2026-07-15
 *   row 1 (08-15, skip):  B 1 000 000, accrues 10 000 (1%), pays 0      -> interestDue 0, totalDue 0,  capitalised 10 000
 *   row 2 (09-15):        B 1 010 000, accrues 10 100, pays 400 000     -> B 620 100
 *   row 3 (10-15):        B   620 100, accrues  6 201, pays 400 000     -> B 226 301
 *   row 4 (11-15, last):  B   226 301, accrues  2 263 (2 263.01), balloon 200 000
 *                         regular payment 226 301 + 2 263 - 200 000 = 28 564; totalDue 228 564 -> B 0
 *   checks: sum totalDue 1 028 564 = F + I (I = 10 000 + 10 100 + 6 201 + 2 263 = 28 564); loan principal F + C = 1 010 000
 *   accrued(r) by the telescoping rule: row1 1 010 000 - 1 000 000 + 0 = 10 000; row2 620 100 - 1 010 000 + 400 000 = 10 100;
 *     row3 226 301 - 620 100 + 400 000 = 6 201; row4 0 - 226 301 + 228 564 = 2 263.  The balloon posts nothing of its own.
 *   receipt R1: 400 000 on 2026-09-16.   asOf 2026-10-01: rows 1 and 2 are due
 *   receivable = 1 000 000 + 10 000 + 10 100 - 400 000 = 620 100 (= B of row 3: the capital still owed)
 */
const IS_1: JournalDeal = {
  id: "JRN-IS-1",
  description: "Instalment sale: skip period, balloon, financed fees, one receipt",
  asOf: "2026-10-01",
  loan: afLoan({
    id: "jrn-is-1", reference: "AF-IS-0001", principal: 1_010_000, startDate: day("2026-07-15"),
    schedule: [
      row(1, "is1-r1", "2026-08-15", 1_000_000, 0, 0),
      row(2, "is1-r2", "2026-09-15", 1_010_000, 10_100, 400_000),
      row(3, "is1-r3", "2026-10-15", 620_100, 6_201, 400_000),
      row(4, "is1-r4", "2026-11-15", 226_301, 2_263, 228_564),
    ],
    payments: [{ id: "pay-is1", amount: 400_000, paymentMethod: "EFT", receivedAt: new Date("2026-09-16T10:00:00+02:00"), allocationStatus: "ALLOCATED", reconciledAt: null, reversed: false, reversedAt: null, parentPaymentId: null, defaultInterestAllocated: 0, chargeFeesAllocated: 0 }],
    receivableRole: "AF_INSTALMENT_DEBTORS",
    assetFinance: {
      contractType: "INSTALMENT_SALE", financedFeesCents: 50_000, payout: { amountCents: 950_000, releasedAt: new Date("2026-07-15T09:00:00+02:00") },
      inceptionInvoice: invoice("inv-is1", "2026-07-15", 1_000_000, 150_000), asset: { exclVatCents: 0, vatCents: 0 },
      rentals: [], sundryInvoices: [], fund: null, recoveries: [],
    },
  }),
  expected: {
    "af:jrn-is-1:inception": { AF_INSTALMENT_DEBTORS: 1_000_000, INPUT_VAT: 150_000, OUTPUT_VAT: -150_000, BANK: -950_000, FEE_INCOME: -50_000 },
    "af:jrn-is-1:row:is1-r1": { AF_INSTALMENT_DEBTORS: 10_000, INTEREST_INCOME: -10_000 },
    "af:jrn-is-1:row:is1-r2": { AF_INSTALMENT_DEBTORS: 10_100, INTEREST_INCOME: -10_100 },
    "af:jrn-is-1:row:is1-r3": {},
    "af:jrn-is-1:row:is1-r4": {},
    "payment:pay-is1": { BANK: 400_000, AF_INSTALMENT_DEBTORS: -400_000 },
  },
  receivableCents: 620_100,
}

/*
 * JRN-FL-1 — finance lease, trade-in, no balloon, no fees.
 *   cash price R23 000.00 incl. VAT (excl 2 000 000, VAT 300 000), deposit 0, trade-in 300 000
 *   payout = 2 300 000 - 300 000 = 2 000 000;  F = 2 000 000;  booked 2026-07-31
 *   row 1 (08-31): B 2 000 000, accrues 20 000, pays 700 000 -> B 1 320 000
 *   row 2 (09-30): B 1 320 000, accrues 13 200, pays 700 000 -> B   633 200
 *   row 3 (10-31): B   633 200, accrues  6 332, pays 639 532 (clears)  -> B 0
 *   checks: sum totalDue 2 039 532 = F + I (I = 39 532)
 *   asOf 2026-10-01: rows 1 and 2 are due, no receipts: receivable = 2 000 000 + 20 000 + 13 200 = 2 033 200
 */
const FL_1: JournalDeal = {
  id: "JRN-FL-1",
  description: "Finance lease: trade-in, no balloon",
  asOf: "2026-10-01",
  loan: afLoan({
    id: "jrn-fl-1", reference: "AF-FL-0001", principal: 2_000_000, startDate: day("2026-07-31"),
    schedule: [
      row(1, "fl1-r1", "2026-08-31", 2_000_000, 20_000, 700_000),
      row(2, "fl1-r2", "2026-09-30", 1_320_000, 13_200, 700_000),
      row(3, "fl1-r3", "2026-10-31", 633_200, 6_332, 639_532),
    ],
    receivableRole: "AF_INSTALMENT_DEBTORS",
    assetFinance: {
      contractType: "FINANCE_LEASE", financedFeesCents: 0, payout: { amountCents: 2_000_000, releasedAt: new Date("2026-07-31T09:00:00+02:00") },
      inceptionInvoice: invoice("inv-fl1", "2026-07-31", 2_000_000, 300_000), asset: { exclVatCents: 0, vatCents: 0 },
      rentals: [], sundryInvoices: [], fund: null, recoveries: [],
    },
  }),
  expected: {
    "af:jrn-fl-1:inception": { AF_INSTALMENT_DEBTORS: 2_000_000, INPUT_VAT: 300_000, OUTPUT_VAT: -300_000, BANK: -2_000_000 },
    "af:jrn-fl-1:row:fl1-r1": { AF_INSTALMENT_DEBTORS: 20_000, INTEREST_INCOME: -20_000 },
    "af:jrn-fl-1:row:fl1-r2": { AF_INSTALMENT_DEBTORS: 13_200, INTEREST_INCOME: -13_200 },
    "af:jrn-fl-1:row:fl1-r3": {},
  },
  receivableCents: 2_033_200,
}

export const INSTALMENT_JOURNAL_DEALS: JournalDeal[] = [IS_1, FL_1]
