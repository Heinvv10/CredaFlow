import { prisma } from "@/lib/prisma"
import { borrowerDisplayName } from "@/lib/borrower"
import type { CandidateLoan } from "./types"

export async function buildCandidateLoans(tenantId: string): Promise<CandidateLoan[]> {
  const loans = await prisma.loan.findMany({
    where: { tenantId, status: { in: ["ACTIVE", "DEFAULTED"] } },
    include: {
      client: { select: { firstName: true, lastName: true, phone: true } },
      entity: { select: { legalName: true } },
      repaymentSchedule: { orderBy: { dueDate: "asc" } },
    },
  })
  return loans.map((loan) => {
    const nextUnpaid = loan.repaymentSchedule.find((r) => r.totalPaid < r.totalDue)
    return {
      loanId: loan.id,
      loanReference: loan.reference,
      expectedInstalmentCents: nextUnpaid?.totalDue ?? loan.repaymentSchedule[0]?.totalDue ?? 0,
      clientNameTokens: borrowerDisplayName(loan)
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean),
      clientPhoneDigits: loan.client?.phone?.replace(/\D/g, "") || null,
      nextDueDate: nextUnpaid?.dueDate ?? null,
    }
  })
}
