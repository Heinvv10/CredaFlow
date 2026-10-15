import type { AssetLessorStatus, RecoveryStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"

// Whether a borrower can still ask to surrender the asset (NCA s127). Not once
// the lender has it: a live recovery (anything but WITHDRAWN) or an asset the
// database marks RECOVERED or SOLD_IN_REMARKETING. Presentation gate for the
// portal's "Request voluntary surrender" action; an existing request's status
// is shown regardless.

const HELD: readonly AssetLessorStatus[] = ["RECOVERED", "SOLD_IN_REMARKETING"]

export function surrenderRequestOpen(loan: { recoveryStatuses: readonly RecoveryStatus[]; lessorStatus: AssetLessorStatus | null }): boolean {
  if (loan.lessorStatus !== null && HELD.includes(loan.lessorStatus)) return false
  return loan.recoveryStatuses.every((status) => status === "WITHDRAWN")
}

export async function loadSurrenderRequestOpen(tenantId: string, loanId: string): Promise<boolean> {
  const loan = await prisma.loan.findFirst({
    where: { id: loanId, tenantId },
    select: { asset: { select: { lessorStatus: true } }, recoveries: { select: { status: true } } },
  })
  if (!loan) return false
  return surrenderRequestOpen({ recoveryStatuses: loan.recoveries.map((r) => r.status), lessorStatus: loan.asset?.lessorStatus ?? null })
}
