/**
 * The recovery card on a borrower's contract page (/portal/loans/[id]). The
 * English values are exactly what the card printed before extraction
 * (components/asset-finance/recovery/recovery-model.ts for the status and
 * treatment labels). Recovery cost names (towing, storage, …) are NOT here:
 * they stay English so they read the same as on the s127 final notice.
 */
export const portalRecovery = {
  title: "Recovery of your asset",
  description: "{asset}, recovered on {date}",
  valuation: "Valuation",
  noticesIssued: "Notices issued",
  noticeValuation: "Valuation notice",
  noticeFinal: "Final notice",
  noneYet: "None yet",
  saleProceeds: "Sale proceeds",
  deductedCosts: "Costs deducted from the proceeds",
  netProceeds: "Net proceeds",
  chargedCosts: "Costs charged to the account",
  unrecoverableCosts: "Charged costs not recoverable on the account",
  shortfall: "Shortfall you owe",
  surplus: "Surplus due to you",
  balance: "Balance",
  nothingOwed: "Nothing owed either way",
  chargesFrozenUntil: "No further charges accrue on the account until {date}.",
  recoveryCosts: "Recovery costs",
  status_RECOVERED: "Recovered",
  status_VALUED: "Valued",
  status_VALUATION_NOTICE_ISSUED: "Valuation notice issued",
  status_LISTED: "Listed for sale",
  status_SOLD: "Sold",
  status_PROCEEDS_APPLIED: "Proceeds applied",
  status_FINAL_NOTICE_ISSUED: "Final notice issued",
  status_SHORTFALL_OPEN: "Shortfall open",
  status_SURPLUS_HELD: "Surplus held",
  status_CLOSED: "Closed",
  status_WITHDRAWN: "Withdrawn",
  treatment_DEDUCT_FROM_PROCEEDS: "Deducted from the proceeds",
  treatment_CHARGE_TO_ACCOUNT: "Charged to the account",
} as const
