/**
 * Plain-language text for why a month cannot close and what an asset-finance
 * check measures (lib/accounting/plan.ts CloseRefusal codes,
 * lib/accounting/reconcile-controls.ts control names). The server's own
 * sentence stays underneath as the detail.
 */
export interface RefusalCopy {
  title: string
  advice: string
}

const REFUSALS: Record<string, RefusalCopy> = {
  PERIOD_NOT_ENDED: { title: "This month is not over yet", advice: "A month closes once it has ended, so nothing can arrive late." },
  MAPPING_NOT_CONFIRMED: { title: "The chart of accounts needs confirming", advice: "An administrator reviews the mapping below and confirms it. Asset-finance accounts were added after many lenders confirmed theirs, so confirm again before the first month that posts them." },
  GO_LIVE_NOT_SET: { title: "Set the go-live month first", advice: "History before it is posted as one opening entry." },
  OUT_OF_ORDER: { title: "Months close in order", advice: "Close the earlier month first." },
  RECONCILIATION_FAILED: { title: "A receivable does not tie to what borrowers owe", advice: "The journal and the loan records disagree for the contracts below, so nothing is posted." },
  AF_SOURCE_UNSUPPORTED: { title: "Some asset-finance contracts cannot be exported yet", advice: "They are left out of this preview and the month stays open until they can be posted (for example a lease with a deposit or trade-in, or a credit note on an instalment sale's invoice)." },
  IFRS9_RUN_MISSING: { title: "The IFRS 9 monthly run is missing", advice: "IFRS 9 is on for this lender, so each month closes against its month-end staging run. It is made on the last day of the month; if that was missed, run it from the IFRS 9 report during the first five days of the next month." },
  IFRS9_RUN_STALE: { title: "The IFRS 9 monthly run is out of date", advice: "An earlier month's run was made or replaced after this month's (each month's stages start from the month before), or the Stage 3 interest basis changed after it was made. An administrator replaces this month's run (supersede) before it closes." },
  IFRS9_EXIT_UNDATED: { title: "A loan left the book without a recorded date", advice: "IFRS 9 needs the date a settled, cancelled or written-off loan left the book to release its allowance in the right month. An operator records it with the lender:set-exit-date command (see docs/ifrs9/DESIGN.md), then close again." },
  AF_CONTROL_FAILED: { title: "An asset-finance check does not agree with the contract records", advice: "The journals for this month differ from the invoices, recoveries or maintenance funds they come from. Nothing is posted until the differences are resolved." },
}

export function refusalCopy(code: string): RefusalCopy {
  return REFUSALS[code] ?? { title: "This month cannot close yet", advice: "" }
}

const CONTROLS: Record<string, string> = {
  AF_OUTPUT_VAT: "Output VAT on tax invoices, less credit notes",
  AF_INPUT_VAT: "Input VAT claimed on purchases and recoveries",
  RECOVERY_CLEARING: "Recovery clearing (should be nil once the sale is settled)",
  RECOVERY_RESULT: "Gain or loss left from a recovery",
  RECOVERY_REFUND_PAYABLE: "Surplus still owed back to the debtor",
  MAINTENANCE_FUND_LIABILITY: "Maintenance fund owed to the lessee",
  DEALER_COMMISSION_PAYABLE: "Dealer commission owed, less payable runs released",
}

export function controlLabel(control: string): string {
  return CONTROLS[control] ?? control.replaceAll("_", " ").toLowerCase()
}
