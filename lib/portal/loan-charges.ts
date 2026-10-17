import { prisma } from "@/lib/prisma"
import { loanSettlementFigures } from "@/lib/loan/charges-summary"

// Default charges owed on a client's loans, for the portal. ALL money is
// CENTS. Empty while charges are off for the tenant.

export interface PortalCharges {
  outstanding: number
  lines: Array<{ label: string; amount: number }>
  /**
   * What settles the loan today, charges included — the same figure as the
   * staff loan page and the NCA documents. null while charges are off.
   */
  settlementAmount: number | null
  /**
   * What settles the loan today (s125, charges included), whether or not
   * charges are live: the figure the staff loan page and the certificate of
   * balance state (lib/loan/charges-summary.ts loanSettlementFigures).
   */
  totalToSettle: number
}

const NONE: PortalCharges = { outstanding: 0, lines: [], settlementAmount: null, totalToSettle: 0 }

export async function portalLoanCharges(tenantId: string, loanId: string, asOf: Date): Promise<PortalCharges> {
  const loan = await prisma.loan.findUnique({
    where: { id: loanId, tenantId },
    include: { repaymentSchedule: { orderBy: [{ dueDate: "asc" }, { installmentNo: "asc" }] } },
  })
  if (!loan) return NONE
  const figures = await loanSettlementFigures(prisma, loan, asOf)
  if (!figures.live) return { ...NONE, totalToSettle: figures.totalToSettle }
  return { outstanding: figures.chargesOutstanding, lines: figures.chargeLines, settlementAmount: figures.totalToSettle, totalToSettle: figures.totalToSettle }
}

/** The outstanding balance to show: the settlement amount while charges are live. */
export function portalOutstanding(outstandingPrincipal: number, charges: PortalCharges): number {
  return charges.settlementAmount ?? outstandingPrincipal
}

/** Several loans' charges added together, one line per charge type. */
export function sumPortalCharges(all: PortalCharges[]): PortalCharges {
  const byLabel = new Map<string, number>()
  for (const charges of all) {
    for (const line of charges.lines) byLabel.set(line.label, (byLabel.get(line.label) ?? 0) + line.amount)
  }
  const live = all.filter((charges) => charges.settlementAmount !== null)
  return {
    outstanding: all.reduce((sum, charges) => sum + charges.outstanding, 0),
    lines: [...byLabel].map(([label, amount]) => ({ label, amount })),
    settlementAmount: live.length > 0 ? live.reduce((sum, charges) => sum + (charges.settlementAmount ?? 0), 0) : null,
    totalToSettle: all.reduce((sum, charges) => sum + charges.totalToSettle, 0),
  }
}
