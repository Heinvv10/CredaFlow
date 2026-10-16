import { prisma } from "@/lib/prisma"
import { ClientsPageClient } from "@/components/clients/ClientsPageClient"
import { getStaffTenantId } from "@/lib/session-tenant"
import { cashReceivedCents } from "@/lib/payments/waiver"
import { auth } from "@/lib/auth"
import { lacksLoanBook } from "@/lib/security/loan-book-scope"

async function getClients(tenantId: string) {
  return prisma.client.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    include: {
      _count: {
        select: {
          loans: { where: { status: "ACTIVE" } },
          applications: true,
        },
      },
      loans: {
        where: { status: "ACTIVE" },
        select: {
          daysInArrears: true,
          payments: { select: { amount: true, paymentMethod: true, reversed: true, allocationStatus: true } },
        },
      },
    },
  })
}

export default async function ClientsPage() {
  const tenantId = await getStaffTenantId()
  // A role without the loan book (INSURANCE_OFFICER) is sent no loan,
  // application or income figure (lib/security/client-redaction.ts).
  const loanBook = !lacksLoanBook((await auth())?.user?.role)
  const clients = (await getClients(tenantId)).map((c) => loanBook ? c : {
    ...c, monthlyIncome: 0, grossMonthlyIncome: null, monthlyExpenses: 0, creditScore: null,
    _count: { loans: 0, applications: 0 }, loans: [],
  })

  const unread = await prisma.conversation.findMany({
    where: { tenantId, contact: { clientId: { in: clients.map((c) => c.id) } } },
    select: {
      contact: { select: { clientId: true } },
      _count: { select: { messages: { where: { direction: "INBOUND", readAt: null } } } },
    },
  })
  const unreadByClientId = new Map<string, number>()
  for (const conv of unread) {
    if (!conv.contact.clientId) continue
    unreadByClientId.set(conv.contact.clientId, (unreadByClientId.get(conv.contact.clientId) ?? 0) + conv._count.messages)
  }
  const clientsWithUnread = clients.map((c) => ({
    ...c,
    // Cash received per loan; Loan.totalPaid is only the share applied to the instalments.
    loans: c.loans.map((l) => ({ daysInArrears: l.daysInArrears, cashPaid: cashReceivedCents(l.payments) })),
    unreadCount: unreadByClientId.get(c.id) ?? 0,
  }))

  return (
    <div className="p-6 lg:p-8">
      <ClientsPageClient clients={clientsWithUnread} loanBook={loanBook} />
    </div>
  )
}
