/**
 * The recovery card on a borrower's contract page (/portal/loans/[id]): its
 * heading and the neutral recovery statuses. The English values are exactly
 * what the card printed before extraction (the status labels are
 * components/asset-finance/recovery/recovery-model.ts STATUS_LABELS).
 *
 * Stays English, by the rule that statutory and collections text is never
 * translated (lib/i18n/.claude.md). Each of these mirrors a line of the s127 or
 * s131 valuation and final notices, names a notice, or states what is owed:
 *  - the notice names "Valuation notice" and "Final notice", and the statuses
 *    "Valuation notice issued" and "Final notice issued";
 *  - the figures "Valuation", "Sale proceeds", "Costs deducted from the
 *    proceeds", "Net proceeds", "Costs charged to the account", "Charged costs
 *    not recoverable on the account", and the "Recovery costs" list with its
 *    cost names and "Deducted from the proceeds" / "Charged to the account";
 *  - what is owed: "Shortfall you owe", "Surplus due to you", "Balance",
 *    "Nothing owed either way", and the statuses "Shortfall open" and "Surplus
 *    held";
 *  - the notice deadline "No further charges accrue on the account until
 *    {date}.", its date in English format;
 *  - every amount (formatMoney).
 */
export const portalRecovery = {
  title: "Recovery of your asset",
  description: "{asset}, recovered on {date}",
  noticesIssued: "Notices issued",
  noneYet: "None yet",
  status_RECOVERED: "Recovered",
  status_VALUED: "Valued",
  status_LISTED: "Listed for sale",
  status_SOLD: "Sold",
  status_PROCEEDS_APPLIED: "Proceeds applied",
  status_CLOSED: "Closed",
  status_WITHDRAWN: "Withdrawn",
} as const
