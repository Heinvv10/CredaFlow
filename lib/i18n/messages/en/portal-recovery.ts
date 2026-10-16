/**
 * The recovery card on a borrower's contract page (/portal/loans/[id]): its
 * heading, description and notices label only. The English values are exactly
 * what the card printed before extraction.
 *
 * Stays English, by the rule that statutory and collections text is never
 * translated (lib/i18n/.claude.md). Each of these is the legal state of the
 * s127/s131 process, mirrors a line of its valuation and final notices, names a
 * notice, or states what is owed:
 *  - every recovery status (Recovered, Valued, Valuation notice issued,
 *    Listed for sale, Sold, Proceeds applied, Final notice issued, Shortfall
 *    open, Surplus held, Closed, Withdrawn): together they are the legal state
 *    of the s127/s131 process;
 *  - the notice names "Valuation notice" and "Final notice";
 *  - the figures "Valuation", "Sale proceeds", "Costs deducted from the
 *    proceeds", "Net proceeds", "Costs charged to the account", "Charged costs
 *    not recoverable on the account", and the "Recovery costs" list with its
 *    cost names and "Deducted from the proceeds" / "Charged to the account";
 *  - what is owed: "Shortfall you owe", "Surplus due to you", "Balance",
 *    "Nothing owed either way";
 *  - the notice deadline "No further charges accrue on the account until
 *    {date}.", its date in English format;
 *  - every amount (formatMoney).
 */
export const portalRecovery = {
  title: "Recovery of your asset",
  description: "{asset}, recovered on {date}",
  noticesIssued: "Notices issued",
  noneYet: "None yet",
} as const
