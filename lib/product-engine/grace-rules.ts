import type { GraceKind, RepaymentStructure } from "./types"

/**
 * The rules that bind a grace to a structure, in one place: the configuration parser (terms.ts) reports every problem, the
 * generator (schedule.ts) throws on the first. The database holds the same rules as CHECK constraints on ProductVersion and
 * LoanTerms (migration 20261031120000_product_engine), which an integration test keeps in step.
 */
export function graceRuleProblems(structure: RepaymentStructure, graceKind: GraceKind, graceInstalments: number): Array<{ path: string; message: string }> {
  const problems: Array<{ path: string; message: string }> = []
  if (graceKind === "NONE" && graceInstalments !== 0) problems.push({ path: "repayment.graceInstalments", message: "grace periods need a grace kind" })
  if (graceKind !== "NONE" && graceInstalments < 1) problems.push({ path: "repayment.graceInstalments", message: "a grace kind needs at least 1 grace period" })
  if (graceKind === "PRINCIPAL_ONLY" && structure !== "AMORTISING") problems.push({ path: "repayment", message: "a principal-only grace belongs to an amortising structure: interest-only and bullet already defer the principal" })
  if (graceKind !== "NONE" && structure === "BULLET") problems.push({ path: "repayment", message: "a bullet has a single payment at the end: it has no grace" })
  return problems
}
