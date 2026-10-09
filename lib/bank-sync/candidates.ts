import { prisma } from "@/lib/prisma"
import type { CandidateLoan } from "./types"

export async function buildCandidateLoans(tenantId: string): Promise<CandidateLoan[]> {
  const loans = await prisma.loan.findMany({
    where: { tenantId, status: { in: ["ACTIVE", "DEFAULTED"] } },
    include: {
      client: { select: { firstName: true, lastName: true, phone: true } },
      repaymentSchedule: { orderBy: { dueDate: "asc" } },
    },
  })
  return loans.map((loan) => {
    const nextUnpaid = loan.repaymentSchedule.find((r) => r.totalPaid < r.totalDue)
    return {
      loanId: loan.id,
      loanReference: loan.reference,
      expectedInstalmentCents: nextUnpaid?.totalDue ?? loan.repaymentSchedule[0]?.totalDue ?? 0,
      clientNameTokens: `${loan.client.firstName} ${loan.client.lastName}`
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean),
      clientPhoneDigits: loan.client.phone?.replace(/\D/g, "") || null,
      nextDueDate: nextUnpaid?.dueDate ?? null,
    }
  })
}
