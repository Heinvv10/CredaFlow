import type { ApplicationSubmissionTransaction } from "@/lib/applications/submission-lock"

/** Statuses in which a change of the figures can still reach a decision or a disbursement. */
const OPEN_STATUSES = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED"] as const

/** The recorded staff plus this one, once (LoanApplication.inputStaffIds only grows). */
export function withInputStaff(current: readonly string[] | null | undefined, userId: string): string[] {
  const staff = current ?? []
  return staff.includes(userId) ? [...staff] : [...staff, userId]
}

/**
 * A staff member changed the income, expenses or debts of a client: record them as input staff on
 * every application of that client that is still open, because those figures are what the decision
 * engine decides on. Run in the transaction of the change. Where the engine approves one of those
 * applications, the person cannot be the one who disburses it (lib/security/segregation-of-duties.ts).
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
