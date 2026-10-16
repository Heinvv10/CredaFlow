/**
 * Shapes shared by the source derivation (lib/accounting/sources.ts,
 * lib/accounting/sources-receipts.ts) and the ledger delta
 * (lib/accounting/derive.ts).
 */
import type { AccountRole } from "./accounts"

/** Signed cents per role: + debit, - credit. A source's vector always sums to zero. */
export type Vector = Partial<Record<AccountRole, number>>

export type EventType =
  | "OPENING"
  | "DISBURSEMENT"
  | "PAYOUT_PAID"
  | "PAYOUT_RETURNED"
  | "PAYOUT_RECOVERED"
  | "DISBURSEMENT_REVERSED"
  | "INSTALMENT_DUE"
  | "DEFAULT_CHARGE"
  | "RECEIPT"
  | "WAIVER"
  | "REVERSAL"
  | "REFUND"
  | "ALLOCATION"
  | "RECLASS"
  | "WRITE_OFF"
  | "ADJUSTMENT"
  | "ASSET_INCEPTION"
  | "LEASE_RENTAL"
  | "LEASE_INVOICE"
  | "MAINTENANCE_FUND"
  | "RECOVERY_COST"
  | "RECOVERY_VAT"
  | "RECOVERY_SALE"
  | "RECOVERY_SURPLUS"
  | "RECOVERY_REFUND"
  | "RECOVERY_RESULT"
  | "CREDIT_NOTE"

export interface SourcePayment {
  id: string
  amount: number
  paymentMethod: string
  receivedAt: Date
  allocationStatus: "ALLOCATED" | "UNAPPLIED" | "REFUNDED"
  reconciledAt: Date | null
  reversed: boolean
  reversedAt: Date | null
  /** Set on the refund-due half of a split over-payment. */
  parentPaymentId: string | null
  /** The parts of `amount` that paid default charges (not the schedule). */
  defaultInterestAllocated: number
  chargeFeesAllocated: number
  /** The receipt of a recovery's sale proceeds: the cash came in with the sale, so it debits RECOVERY_CLEARING, not BANK. */
  recoveryProceeds?: boolean
}

export interface SourceLoan {
  id: string
  reference: string
  principal: number
  initiationFee: number
  /** The initiation fee was deducted from the cash advanced (InitiationFeePayment.UPFRONT). */
  upfrontFee: boolean
  startDate: Date
  status: string
  writeOffAt: Date | null
  closedAt: Date | null
  /** When an approved disbursement reversal cancelled the loan (lib/payouts/reversal.ts). */
  reversedAt: Date | null
  schedule: Array<{
    id: string
    installmentNo: number
    dueDate: Date
    interestDue: number
    feesDue: number
    creditLifePremiumDue: number
    totalDue: number
    totalPaid: number
    /** Asset finance (instalment sale, finance lease): the capital balance the row's interest accrued on. */
    openingBalanceCents?: number | null
  }>
  /** `day` is the SAST calendar day as SAST midnight. */
  charges: Array<{ type: string; day: Date; amount: number; sourceId: string | null }>
  payments: SourcePayment[]
  /** Payout attempts (payout channel). None = paid outside the system: the disbursement credits BANK. */
  payouts: Array<{ id: string; attempt: number; amountCents: number; paidAt: Date | null; returnedAt: Date | null }>
  /** Money paid out after the disbursement was reversed (lib/payouts/recovery.ts), by attempt. */
  recoveries: Array<{ id: string; attempt: number; amountCents: number; paidAt: Date; recoveredAt: Date | null; unrecoverableAt: Date | null }>
  /** Where the borrower's debt is booked; LOAN_BOOK when absent (consumer loans). */
  receivableRole?: AccountRole
  /** Set for asset-finance contracts (lib/accounting/sources-asset-finance.ts). */
  assetFinance?: SourceAssetFinance
}

export interface SourceInvoice {
  id: string
  /** SAST midnight of the supply date. */
  supplyDate: Date
  /** SAST midnight of the issue date. */
  issueDate: Date
  exclVatCents: number
  vatCents: number
  inclVatCents: number
  /** Part of exclVatCents that is the sale of the leased asset to the lessee (end of term, purchase). */
  assetSaleExclVatCents: number
  /** Part of exclVatCents that bills a maintenance fund's deficit to the lessee: it settles the fund, it is not income. */
  fundBilledExclVatCents?: number
}

/**
 * A credit note against a lease tax invoice or an instalment sale's or finance lease's inception invoice, with what the
 * invoice credited (the credit is spread over it). An inception invoice's whole value is the asset's price: AF_PRICE_CREDITS.
 */
export interface SourceCreditNote {
  id: string
  invoiceId: string
  /** SAST midnight of the issue date. */
  issueDate: Date
  exclVatCents: number
  vatCents: number
  inclVatCents: number
  /** What the original invoice credited to each income role, excluding VAT. */
  invoiceIncome: Array<{ role: "RENTAL_INCOME" | "MAINTENANCE_INCOME" | "ASSET_DISPOSAL_PROCEEDS" | "MAINTENANCE_FUND_LIABILITY" | "AF_PRICE_CREDITS"; exclVatCents: number }>
}

/** A credit note against a remarketing sale's buyer invoice. */
export interface SourceSaleCreditNote {
  id: string
  /** SAST midnight of the issue date. */
  issueDate: Date
  exclVatCents: number
  vatCents: number
  inclVatCents: number
}

export interface SourceRecovery {
  id: string
  /** Proceeds applied (the Recovery's figures are set) on this day, or null. */
  proceedsDate: Date | null
  proceedsPaymentId: string | null
  surplusCents: number
  /** A withdrawn recovery's closure, or null. */
  withdrawnAt: Date | null
  costs: Array<{ id: string; netCents: number; vatCents: number; grossCents: number; treatment: "DEDUCT_FROM_PROCEEDS" | "CHARGE_TO_ACCOUNT"; incurredOn: Date }>
  /** Repossession VAT events that carry an input-tax claim. */
  vatEvents: Array<{ id: string; eventDate: Date; inputTaxClaimCents: number }>
  /** The completed sale, its buyer invoice and the credit notes against that invoice (none when absent). */
  sale: { id: string; priceInclVatCents: number; invoice: SourceInvoice; creditNotes?: SourceSaleCreditNote[] } | null
  refund: { id: string; amountCents: number; releasedAt: Date } | null
}

export interface SourceAssetFinance {
  contractType: "INSTALMENT_SALE" | "FINANCE_LEASE" | "OPERATING_LEASE" | "FULL_MAINTENANCE_LEASE"
  financedFeesCents: number
  /** What the supplier is paid (cash price incl. VAT, less deposit and trade-in), once released. */
  payout: { amountCents: number; releasedAt: Date } | null
  /** Instalment sale and finance lease: the earliest tax invoice of the loan. */
  inceptionInvoice: SourceInvoice | null
  /** Lease: the asset's cost. */
  asset: { exclVatCents: number; vatCents: number }
  rentals: Array<{ id: string; invoice: SourceInvoice; rentalExclVatCents: number; maintenanceExclVatCents: number; vatCents: number; totalCents: number }>
  /** Lease tax invoices that are not a rental's: end of term, purchase, early termination. */
  sundryInvoices: SourceInvoice[]
  /** Credit notes against the rental and other lease invoices, or against an instalment sale's or finance lease's inception invoice. */
  creditNotes: SourceCreditNote[]
  fund: { riskModel: "LENDER_RISK" | "LESSEE_SETTLED"; movements: Array<{ id: string; kind: "CONTRIBUTION" | "CLAIM" | "SETTLEMENT_REFUND" | "SETTLEMENT_BILLED"; amountCents: number; occurredOn: Date }> } | null
  recoveries: SourceRecovery[]
}

export interface DesiredSource {
  baseKey: string
  loanId: string
  reference: string
  vector: Vector
  /** Label and date of the source's first posting. */
  origin: { type: EventType; date: Date; description: string }
  /** Label and date of a later correction (a delta after the first posting). */
  change: { type: EventType; date: Date | null; description: string }
  /** Label for a later correction that moves no cash (no BANK line), e.g. an over-payment split. */
  reclass?: { type: EventType; date: Date | null; description: string }
}

export function addTo(vector: Vector, role: AccountRole, cents: number): Vector {
  if (cents !== 0) vector[role] = (vector[role] ?? 0) + cents
  return vector
}

export const before = (date: Date | null, asOf: Date) => date !== null && date.getTime() < asOf.getTime()
