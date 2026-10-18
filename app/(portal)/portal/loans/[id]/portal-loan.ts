import { prisma } from "@/lib/prisma"
import { getPortalTenantId } from "@/lib/session-tenant"

/** The signed-in client's own loan with what the detail page shows, or null. */
export async function getPortalLoan(loanId: string, email: string) {
  const tenantId = await getPortalTenantId()

  const client = await prisma.client.findFirst({ where: { email, tenantId } })
  if (!client) return null

  const loan = await prisma.loan.findFirst({
    where: { id: loanId, tenantId },
    include: {
      product: { select: { name: true } },
      repaymentSchedule: { orderBy: { installmentNo: "asc" } },
      payments: { orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }] },
      surrenderRequests: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, ncaSurplusRemittance: { select: { amountCents: true, executedOn: true } } } },
      recoveries: { where: { route: "NCA_S131_ATTACHMENT" }, select: { ncaSurplusRemittance: { select: { amountCents: true, executedOn: true } } } },
    },
  })

  if (!loan || loan.clientId !== client.id) return null
  return loan
}
