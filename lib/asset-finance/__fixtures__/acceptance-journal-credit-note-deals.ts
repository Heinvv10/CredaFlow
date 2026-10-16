/**
 * Journal acceptance deals for credit notes on an instalment sale's inception
 * invoice and on a repossession sale's buyer invoice (slice 4b, F3); see
 * ./acceptance-journal-deals.ts for the rules and the status of these figures
 * (worked by hand, synthetic cents). VAT is 15%. Dr is +, Cr is -.
 *
 * Rules the credit notes follow (DESIGN.md, slice 4b):
 *   inception credit = Dr AF_PRICE_CREDITS excl, Dr output VAT; Cr debtors incl, on its issue date,
 *                      or on the payout's release when that is later (the inception has not posted before)
 *   sale credit      = Dr output VAT, Dr recovery clearing excl; Cr bank incl, on its issue date;
 *                      the result then clears it with everything else in clearing
 *
 * Shared facts of the instalment sales below:
 *   cash price R11 500.00 incl. VAT (excl 1 000 000, VAT 150 000), deposit 150 000, trade-in 0, no financed fees
 *   payout = 1 150 000 - 150 000 = 1 000 000;  F = 1 000 000
 */
import type { SourceAssetFinance, SourceLoan } from "@/lib/accounting/source-types"
import { afLoan, day, invoice, type JournalDeal } from "./acceptance-journal-deals"

const INCEPTION = { AF_INSTALMENT_DEBTORS: 1_000_000, INPUT_VAT: 150_000, OUTPUT_VAT: -150_000, BANK: -1_000_000 }

const row = (n: number, id: string, due: string, open: number, interestDue: number, totalDue: number) =>
  ({ id, installmentNo: n, dueDate: day(due), interestDue, feesDue: 0, creditLifePremiumDue: 0, totalDue, totalPaid: 0, openingBalanceCents: open })

const receipt = (id: string, amount: number, iso: string, recoveryProceeds = false) => ({
  id, amount, paymentMethod: "EFT", receivedAt: new Date(`${iso}T10:00:00+02:00`), allocationStatus: "ALLOCATED" as const,
  reconciledAt: null, reversed: false, reversedAt: null, parentPaymentId: null, defaultInterestAllocated: 0, chargeFeesAllocated: 0, recoveryProceeds,
})

function instalmentSale(id: string, reference: string, releasedAt: string, schedule: SourceLoan["schedule"], extra: Partial<SourceAssetFinance> = {}): SourceLoan {
  return afLoan({
    id, reference, principal: 1_000_000, startDate: day("2026-07-15"), schedule, receivableRole: "AF_INSTALMENT_DEBTORS",
    assetFinance: {
      contractType: "INSTALMENT_SALE", financedFeesCents: 0, payout: { amountCents: 1_000_000, releasedAt: new Date(releasedAt) },
      inceptionInvoice: invoice(`inv-${id}`, "2026-07-15", 1_000_000, 150_000), asset: { exclVatCents: 0, vatCents: 0 },
      rentals: [], sundryInvoices: [], creditNotes: [], fund: null, recoveries: [], ...extra,
    },
  })
}

/*
 * JRN-IS-CN — instalment sale, a credit note on its inception invoice after the first instalment.
 *   booked and paid out 2026-07-15
 *   row 1 (08-15): B 1 000 000, accrues 10 000 (1%), pays 340 000 -> B 670 000
 *   row 2 (09-15): B   670 000, accrues  6 700,      pays 340 000 -> B 336 700
 *   row 3 (10-15): B   336 700, accrues  3 367,      pays 340 067 -> B 0      (sum totalDue 1 020 067 = F + I 20 067)
 *   receipt 340 000 on 2026-08-16
 *   credit note 2026-08-20 (an accessory not delivered): excl 20 000, VAT 20 000 x 15% = 3 000, incl 23 000
 *   asOf 2026-10-01: rows 1 and 2 are due
 *   receivable = 1 000 000 + 10 000 + 6 700 - 340 000 - 23 000 = 653 700
 *     (independent: B of row 3 336 700 + totalDue raised 680 000 - credit 23 000 - receipt 340 000 = 653 700)
 *   output VAT = -150 000 + 3 000 = -147 000; price credits (expense) 20 000
 */
const IS_CN: JournalDeal = {
  id: "JRN-IS-CN",
  description: "Instalment sale: a credit note on the inception invoice",
  asOf: "2026-10-01",
  loan: {
    ...instalmentSale("jrn-is-cn", "AF-IS-CN01", "2026-07-15T09:00:00+02:00", [
      row(1, "iscn-r1", "2026-08-15", 1_000_000, 10_000, 340_000),
      row(2, "iscn-r2", "2026-09-15", 670_000, 6_700, 340_000),
      row(3, "iscn-r3", "2026-10-15", 336_700, 3_367, 340_067),
    ], {
      creditNotes: [{ id: "cn-is-1", invoiceId: "inv-jrn-is-cn", issueDate: day("2026-08-20"), exclVatCents: 20_000, vatCents: 3_000, inclVatCents: 23_000, invoiceIncome: [{ role: "AF_PRICE_CREDITS", exclVatCents: 1_000_000 }] }],
    }),
    payments: [receipt("pay-iscn", 340_000, "2026-08-16")],
  },
  expected: {
    "af:jrn-is-cn:inception": INCEPTION,
    "af:jrn-is-cn:row:iscn-r1": { AF_INSTALMENT_DEBTORS: 10_000, INTEREST_INCOME: -10_000 },
    "af:jrn-is-cn:row:iscn-r2": { AF_INSTALMENT_DEBTORS: 6_700, INTEREST_INCOME: -6_700 },
    "af:jrn-is-cn:row:iscn-r3": {},
    "payment:pay-iscn": { BANK: 340_000, AF_INSTALMENT_DEBTORS: -340_000 },
    "af-credit:cn-is-1": { AF_PRICE_CREDITS: 20_000, OUTPUT_VAT: 3_000, AF_INSTALMENT_DEBTORS: -23_000 },
  },
  receivableCents: 653_700,
}

/*
 * JRN-IS-CN-EARLY — the credit note is dated before the payout is released (inception posts 2026-08-03).
 *   one row (12-15): B 1 000 000, accrues 10 000, pays 1 010 000
 *   credit note 2026-07-20: excl 10 000, VAT 1 500, incl 11 500; nothing posts in July, both in August
 *   asOf 2026-09-01: receivable = 1 000 000 - 11 500 = 988 500; output VAT = -150 000 + 1 500
 */
const IS_CN_EARLY: JournalDeal = {
  id: "JRN-IS-CN-EARLY",
  description: "Instalment sale: a credit note dated before the inception posts",
  asOf: "2026-09-01",
  loan: instalmentSale("jrn-is-cne", "AF-IS-CN02", "2026-08-03T09:00:00+02:00", [row(1, "iscne-r1", "2026-12-15", 1_000_000, 10_000, 1_010_000)], {
    creditNotes: [{ id: "cn-is-early", invoiceId: "inv-jrn-is-cne", issueDate: day("2026-07-20"), exclVatCents: 10_000, vatCents: 1_500, inclVatCents: 11_500, invoiceIncome: [{ role: "AF_PRICE_CREDITS", exclVatCents: 1_000_000 }] }],
  }),
  expected: {
    "af:jrn-is-cne:inception": INCEPTION,
    "af:jrn-is-cne:row:iscne-r1": {},
    "af-credit:cn-is-early": { AF_PRICE_CREDITS: 10_000, OUTPUT_VAT: 1_500, AF_INSTALMENT_DEBTORS: -11_500 },
  },
  receivableCents: 988_500,
}

/*
 * REC-SALE-CN — an instalment sale repossessed and sold, with a credit note on the buyer's invoice before the proceeds are applied.
 *   one row (12-15): B 1 000 000, accrues 10 000, pays 1 010 000 (not yet due at asOf)
 *   repossession 2026-09-20: deemed-supply input tax 75 000; deducted towing 2026-09-22: net 10 000, VAT 1 500, gross 11 500
 *   buyer's invoice 2026-10-05: 800 000 excl + 120 000 VAT = 920 000 (price 920 000)
 *   credit note on it 2026-10-08 (a defect found): excl 40 000, VAT 6 000, incl 46 000, refunded to the buyer
 *   proceeds applied 2026-10-12 on the sale price, before the credit (lib/asset-finance/recovery-proceeds.ts):
 *     net proceeds 920 000 - 11 500 = 908 500; settlement due higher: payment 908 500, surplus 0
 *   clearing = +10 000 - 75 000 - 800 000 + 40 000 + 908 500 = 83 500 -> result 83 500
 *     (= output VAT 120 000 - 6 000 - input VAT 75 000 - 1 500 + the refund's excl. VAT part 40 000 the debtor was still credited with)
 *   bank: -1 000 000 payout + 920 000 sale - 46 000 refund = -126 000
 *   asOf 2026-11-01: receivable = 1 000 000 - 908 500 = 91 500; output VAT = -150 000 - 120 000 + 6 000 = -264 000
 */
const REC_SALE_CN: JournalDeal = {
  id: "REC-SALE-CN",
  description: "Recovery: a credit note on the buyer's invoice",
  asOf: "2026-11-01",
  loan: {
    ...instalmentSale("rec-cn", "AF-REC-CN01", "2026-07-15T09:00:00+02:00", [row(1, "reccn-r1", "2026-12-15", 1_000_000, 10_000, 1_010_000)], {
      recoveries: [{
        id: "r-cn", proceedsDate: day("2026-10-12"), proceedsPaymentId: "pay-reccn", surplusCents: 0, withdrawnAt: null,
        costs: [{ id: "cost-cn", netCents: 10_000, vatCents: 1_500, grossCents: 11_500, treatment: "DEDUCT_FROM_PROCEEDS", incurredOn: day("2026-09-22") }],
        vatEvents: [{ id: "vat-cn", eventDate: day("2026-09-20"), inputTaxClaimCents: 75_000 }],
        sale: {
          id: "sale-cn", priceInclVatCents: 920_000, invoice: invoice("inv-sale-cn", "2026-10-05", 800_000, 120_000),
          creditNotes: [{ id: "cn-sale-1", issueDate: day("2026-10-08"), exclVatCents: 40_000, vatCents: 6_000, inclVatCents: 46_000 }],
        },
        refund: null,
      }],
    }),
    payments: [receipt("pay-reccn", 908_500, "2026-10-12", true)],
  },
  expected: {
    "af:rec-cn:inception": INCEPTION,
    "af:rec-cn:row:reccn-r1": {},
    "af-recovery:r-cn:cost:cost-cn": { RECOVERY_CLEARING: 10_000, INPUT_VAT: 1_500, RECOVERY_COSTS_PAYABLE: -11_500 },
    "af-recovery:r-cn:vat:vat-cn": { INPUT_VAT: 75_000, RECOVERY_CLEARING: -75_000 },
    "af-recovery:r-cn:sale:sale-cn": { BANK: 920_000, OUTPUT_VAT: -120_000, RECOVERY_CLEARING: -800_000 },
    "af-recovery:r-cn:sale-credit:cn-sale-1": { OUTPUT_VAT: 6_000, RECOVERY_CLEARING: 40_000, BANK: -46_000 },
    "payment:pay-reccn": { RECOVERY_CLEARING: 908_500, AF_INSTALMENT_DEBTORS: -908_500 },
    "af-recovery:r-cn:surplus": {},
    "af-recovery:r-cn:result": { RECOVERY_CLEARING: -83_500, RECOVERY_RESULT: 83_500 },
  },
  receivableCents: 91_500,
}

export const CREDIT_NOTE_JOURNAL_DEALS: JournalDeal[] = [IS_CN, IS_CN_EARLY, REC_SALE_CN]
