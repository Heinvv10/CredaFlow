import type { ApplicationSubmissionTransaction } from "@/lib/applications/submission-lock"
import { DECISION_INPUT_CLIENT_FIELDS } from "@/lib/decisioning/facts"

/**
 * Statuses in which a change of a client's figures can still reach the decision. Once an application is approved its inputs are
 * decided (and the evidence guards stop the client record being moved under it), so an edit then is not an input to it.
 */
const OPEN_STATUSES = ["DRAFT", "SUBMITTED", "UNDER_REVIEW"] as const

/** The recorded staff plus this one, once (LoanApplication.inputStaffIds and Client.inputStaffIds only grow). */
export function withInputStaff(current: readonly string[] | null | undefined, userId: string): string[] {
  const staff = current ?? []
  return staff.includes(userId) ? [...staff] : [...staff, userId]
}

/** Whether any of these Client fields is one a decision fact reads (lib/decisioning/facts.ts FACT_CLIENT_SOURCES). */
export function touchesDecisionInputs(fields: Iterable<string>): boolean {
  const inputs = new Set(DECISION_INPUT_CLIENT_FIELDS)
  for (const field of fields) if (inputs.has(field)) return true
  return false
}

/**
 * A staff member changed a figure the decision facts read on a client (the caller also adds them to Client.inputStaffIds in the
 * client's own write): record them as input staff on every application of that client that is not yet approved. Run in the
 * transaction of the change. Where the engine approves one of those applications, the person cannot be the one who disburses it
 * (lib/security/segregation-of-duties.ts). Applications created later inherit the client's list (trigger).
 */
export async function recordInputStaffForClient(
  tx: ApplicationSubmissionTransaction,
  scope: { tenantId: string; clientId: string; userId: string },
): Promise<void> {
  await tx.loanApplication.updateMany({
    where: { tenantId: scope.tenantId, clientId: scope.clientId, status: { in: [...OPEN_STATUSES] }, NOT: { inputStaffIds: { has: scope.userId } } },
    data: { inputStaffIds: { push: scope.userId } },
  })
}
