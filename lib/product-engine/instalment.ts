import { PERIODS_PER_YEAR, type RepaymentTerms } from "./types"

/**
 * The recurring instalment affordability sets against MONTHLY income, as a monthly figure: the regular instalment x periods a
 * year / 12 (weekly 52/12, fortnightly 26/12). "Regular" is defined per structure, never as a maximum over the rows:
 *   - one payment (a bullet) is itself: it is not a recurring amount, so it is not scaled;
 *   - interest-only: the interest (and fee) every period, not the principal that closes the last row;
 *   - amortising: the second row, as the existing monthly loans do (the first carries the one-off initiation fee);
 *     after a principal-only grace, the first row that repays principal, the larger burden the borrower faces;
 *   - a full grace has no rows of its own: its paying rows are equal, so the second row stands for them.
 */
export function monthlyEquivalentInstalment(
  rows: ReadonlyArray<{ totalDue: number }>,
  terms: Pick<RepaymentTerms, "frequency" | "structure" | "graceKind" | "graceInstalments">,
): number {
  if (rows.length === 0) return 0
  // a bullet is one row: its one payment, which is not a recurring amount and so is not scaled to a month
  if (rows.length === 1) return rows[0]!.totalDue
  const recurring = terms.structure === "INTEREST_ONLY" ? rows.slice(0, -1) : rows
  const first = terms.graceKind === "PRINCIPAL_ONLY" && terms.structure === "AMORTISING" ? Math.min(terms.graceInstalments, recurring.length - 1) : Math.min(1, recurring.length - 1)
  const regular = recurring[first]!.totalDue
  return terms.frequency === "MONTHLY" ? regular : Math.round((regular * PERIODS_PER_YEAR[terms.frequency]) / 12)
}
