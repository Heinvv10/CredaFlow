/**
 * The Experian dry-run report (NODE_ENV=test or EXPERIAN_DRY_RUN=true): what
 * demo and test stacks get instead of a billable enquiry. The score and risk
 * grade are a pure function of the ID number, so one consumer always gets the
 * same report and a demo book shows a spread of scores rather than one figure.
 *
 * Scores stay in 600–700: inside the Sigma band and above the demo lender's
 * floor (scripts/demo/scenarios/tenant-setup.ts), so no storyline's approval
 * moves. The record stays clean and debt-free: affordability takes the larger
 * of declared and bureau debt, so an invented obligation could decline an
 * applicant the demo means to approve.
 */
import { createHash } from "node:crypto"

export function dryRunScore(identityNumber: string): { score: number; riskGrade: string } {
  const digest = createHash("sha256").update(identityNumber.replace(/\s/g, "")).digest()
  const score = 600 + (digest.readUInt16BE(0) % 101)
  return { score, riskGrade: score >= 660 ? "LOW RISK" : "AVERAGE RISK" }
}
