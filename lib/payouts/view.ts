import { prisma } from "@/lib/prisma"
import type { PayoutView } from "@/components/payouts/PayoutStatusPanel"
import type { PayoutStatus } from "./state"

/** A loan's payout as the staff page shows it: the account number masked to its last four digits. */
export async function loadPayoutView(tenantId: string, loanId: string): Promise<PayoutView | null> {
  const p = await prisma.disbursementPayout.findFirst({ where: { tenantId, loanId } })
  if (!p) return null
  return {
    id: p.id,
    status: p.status as PayoutStatus,
    provider: p.provider,
    amountCents: p.amountCents,
    bankName: p.bankName,
    accountTail: p.accountNumber.slice(-4),
    simulated: p.simulated,
    providerReference: p.providerReference,
    failureReason: p.failureReason,
    submittedAt: p.submittedAt?.toISOString() ?? null,
    resolvedAt: p.resolvedAt?.toISOString() ?? null,
    resolutionNote: p.resolutionNote,
  }
}
