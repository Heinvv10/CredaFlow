/**
 * Journal acceptance deals for repossessions (slice 4b); see
 * ./acceptance-journal-deals.ts for the rules and the status of these figures
 * (worked by hand, synthetic cents). VAT is 15%. Dr is +, Cr is -.
 *
 * The loan under each recovery is an instalment sale whose own inception and
 * instalments are not under test here (no inception invoice, no schedule), so
 * only the recovery's sources and its proceeds receipt appear.
 *
 * Shared facts of REC-SHORT and REC-SURPLUS:
 *   buyer's tax invoice 2026-10-05: 800 000 excl + 120 000 VAT = 920 000 incl (price 920 000)
 *   repossession 2026-09-20: unpaid cash price 575 000 incl -> deemed-supply input tax 575 000 x 15/115 = 75 000
 *   deducted cost 2026-09-22 (towing): net 10 000, VAT 1 500, gross 11 500
 *   sale price less deducted costs: net proceeds 920 000 - 11 500 = 908 500
 * Clearing, by hand:  +10 000 (deducted cost net) - 75 000 (VAT claim) - 800 000 (sale excl)
 *                     + payment + surplus. The result is what remains: output VAT 120 000 - input VAT 75 000 - cost VAT 1 500 = 43 500.
 */
import type { SourceLoan, SourceRecovery } from "@/lib/accounting/source-types"
import { afLoan, day, invoice, type JournalDeal } from "./acceptance-journal-deals"

const SALE = { id: "sale-1", priceInclVatCents: 920_000, invoice: invoice("inv-sale", "2026-10-05", 800_000, 120_000) }
const VAT_EVENT = { id: "vat-1", eventDate: day("2026-09-20"), inputTaxClaimCents: 75_000 }
const TOWING = { id: "cost-1", netCents: 10_000, vatCents: 1_500, grossCents: 11_500, treatment: "DEDUCT_FROM_PROCEEDS" as const, incurredOn: day("2026-09-22") }

const payment = (id: string, amount: number, iso: string) => ({
  id, amount, paymentMethod: "EFT", receivedAt: new Date(`${iso}T11:00:00+02:00`), allocationStatus: "ALLOCATED" as const,
  reconciledAt: null, reversed: false, reversedAt: null, parentPaymentId: null, defaultInterestAllocated: 0, chargeFeesAllocated: 0, recoveryProceeds: true,
})

function recoveryLoan(id: string, recovery: SourceRecovery, extra: Partial<SourceLoan> = {}): SourceLoan {
  return afLoan({
    id, reference: `AF-${id.toUpperCase()}`, startDate: day("2026-07-15"), receivableRole: "AF_INSTALMENT_DEBTORS",
    assetFinance: {
      contractType: "INSTALMENT_SALE", financedFeesCents: 0, payout: null, inceptionInvoice: null, asset: { exclVatCents: 0, vatCents: 0 },
      rentals: [], sundryInvoices: [], creditNotes: [], fund: null, recoveries: [recovery],
    },
    ...extra,
  })
}

/*
 * REC-SHORT — a shortfall, with a cost charged to the account.
 *   second cost 2026-09-25 (legal, contractual), CHARGE_TO_ACCOUNT: net 20 000, VAT 3 000, gross 23 000
 *   proceeds applied 2026-10-12: settlement due 1 000 000; payment = min(908 500, 1 000 000) = 908 500
 *   owed = 1 000 000 + 23 000 charged; shortfall = 1 023 000 - 908 500 = 114 500; surplus 0
 *   the charged cost lands on the account as a LoanCharge RECOVERY_COST of 23 000 dated 2026-10-12
 *   clearing = +10 000 - 75 000 - 800 000 + 908 500 = 43 500 -> result 43 500
 *   asOf 2026-11-01. Receivable = 23 000 charge - 908 500 receipt = -885 500 (the inception is not in this fixture)
 */
const SHORT: JournalDeal = {
  id: "REC-SHORT",
  description: "Recovery with a shortfall and a cost charged to the account",
  asOf: "2026-11-01",
  loan: recoveryLoan("rec-short", {
    id: "r-short", proceedsDate: day("2026-10-12"), proceedsPaymentId: "pay-short", surplusCents: 0, withdrawnAt: null,
    costs: [TOWING, { id: "cost-2", netCents: 20_000, vatCents: 3_000, grossCents: 23_000, treatment: "CHARGE_TO_ACCOUNT", incurredOn: day("2026-09-25") }],
    vatEvents: [VAT_EVENT], sale: SALE, refund: null,
  }, {
    payments: [payment("pay-short", 908_500, "2026-10-12")],
    charges: [{ type: "RECOVERY_COST", day: day("2026-10-12"), amount: 23_000, sourceId: "cost-2" }],
  }),
  expected: {
    "recovery:r-short:cost:cost-1": { RECOVERY_CLEARING: 10_000, INPUT_VAT: 1_500, RECOVERY_COSTS_PAYABLE: -11_500 },
    "recovery:r-short:cost:cost-2": { RECOVERY_COST_EXPENSE: 20_000, INPUT_VAT: 3_000, RECOVERY_COSTS_PAYABLE: -23_000 },
    "recovery:r-short:vat:vat-1": { INPUT_VAT: 75_000, RECOVERY_CLEARING: -75_000 },
    "recovery:r-short:sale:sale-1": { BANK: 920_000, OUTPUT_VAT: -120_000, RECOVERY_CLEARING: -800_000 },
    "payment:pay-short": { RECOVERY_CLEARING: 908_500, AF_INSTALMENT_DEBTORS: -908_500 },
    "recovery:r-short:surplus": {},
    "recovery:r-short:result": { RECOVERY_CLEARING: -43_500, RECOVERY_RESULT: 43_500 },
    "loan:rec-short:charge:RECOVERY_COST:2026-10-11T22:00:00.000Z:cost-2": { AF_INSTALMENT_DEBTORS: 23_000, RECOVERY_COSTS_RECHARGED: -23_000 },
  },
  receivableCents: -885_500,
}

/*
 * REC-SURPLUS — a surplus, refunded to the debtor.
 *   proceeds applied 2026-10-12: settlement due 600 000; payment = min(908 500, 600 000) = 600 000
 *   owed = 600 000; surplus = 908 500 - 600 000 = 308 500; shortfall 0
 *   refund of 308 500 released 2026-10-20
 *   clearing = +10 000 - 75 000 - 800 000 + 600 000 + 308 500 = 43 500 -> result 43 500
 *   asOf 2026-11-01. Receivable = -600 000 (the inception is not in this fixture)
 */
const SURPLUS: JournalDeal = {
  id: "REC-SURPLUS",
  description: "Recovery with a surplus refunded to the debtor",
  asOf: "2026-11-01",
  loan: recoveryLoan("rec-surplus", {
    id: "r-surplus", proceedsDate: day("2026-10-12"), proceedsPaymentId: "pay-surplus", surplusCents: 308_500, withdrawnAt: null,
    costs: [TOWING], vatEvents: [VAT_EVENT], sale: SALE,
    refund: { id: "refund-1", amountCents: 308_500, releasedAt: new Date("2026-10-20T14:00:00+02:00") },
  }, { payments: [payment("pay-surplus", 600_000, "2026-10-12")] }),
  expected: {
    "recovery:r-surplus:cost:cost-1": { RECOVERY_CLEARING: 10_000, INPUT_VAT: 1_500, RECOVERY_COSTS_PAYABLE: -11_500 },
    "recovery:r-surplus:vat:vat-1": { INPUT_VAT: 75_000, RECOVERY_CLEARING: -75_000 },
    "recovery:r-surplus:sale:sale-1": { BANK: 920_000, OUTPUT_VAT: -120_000, RECOVERY_CLEARING: -800_000 },
    "payment:pay-surplus": { RECOVERY_CLEARING: 600_000, AF_INSTALMENT_DEBTORS: -600_000 },
    "recovery:r-surplus:surplus": { RECOVERY_CLEARING: 308_500, RECOVERY_REFUND_PAYABLE: -308_500 },
    "recovery:r-surplus:refund": { RECOVERY_REFUND_PAYABLE: 308_500, BANK: -308_500 },
    "recovery:r-surplus:result": { RECOVERY_CLEARING: -43_500, RECOVERY_RESULT: 43_500 },
  },
  receivableCents: -600_000,
}

/*
 * REC-WITHDRAWN — withdrawn before any sale (the debtor paid the arrears).
 *   the repossession VAT claim 75 000 (2026-09-20) and the deducted cost (10 000 net, 1 500 VAT, 2026-09-22) are posted
 *   clearing = +10 000 - 75 000 = -65 000; the withdrawal on 2026-10-03 moves it to the result: -65 000 (a gain)
 */
const WITHDRAWN: JournalDeal = {
  id: "REC-WITHDRAWN",
  description: "Recovery withdrawn before a sale",
  asOf: "2026-11-01",
  loan: recoveryLoan("rec-wd", {
    id: "r-wd", proceedsDate: null, proceedsPaymentId: null, surplusCents: 0, withdrawnAt: new Date("2026-10-03T09:00:00+02:00"),
    costs: [TOWING], vatEvents: [VAT_EVENT], sale: null, refund: null,
  }),
  expected: {
    "recovery:r-wd:cost:cost-1": { RECOVERY_CLEARING: 10_000, INPUT_VAT: 1_500, RECOVERY_COSTS_PAYABLE: -11_500 },
    "recovery:r-wd:vat:vat-1": { INPUT_VAT: 75_000, RECOVERY_CLEARING: -75_000 },
    "recovery:r-wd:surplus": {},
    "recovery:r-wd:result": { RECOVERY_CLEARING: 65_000, RECOVERY_RESULT: -65_000 },
  },
  receivableCents: 0,
}

export const RECOVERY_JOURNAL_DEALS: JournalDeal[] = [SHORT, SURPLUS, WITHDRAWN]
