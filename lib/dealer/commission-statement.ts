/**
 * The dealer's own commission statement, read-only: every line (earned at
 * booking, reversed on clawback) and every payable run, of this lender and
 * this dealer only. A run shows its period, status, totals and when it was
 * approved and released, with the lender's release reference; never the
 * staff who acted, and never the bank account's details (they are captured
 * and approved by staff only, spec deviation 7). A line shows its amounts,
 * not its base (the goods advance, which the deal projection ./deal-view.ts
 * does not show either), and a reversal shows no reason: why the borrower's
 * loan ended (settled early, written off, cancelled) is not the dealer's.
 */
import { prisma } from "@/lib/prisma"
import type { DealerActor } from "./actor"

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

export async function loadDealerCommissionStatement(actor: Pick<DealerActor, "tenantId" | "dealerId">) {
  const where = { tenantId: actor.tenantId, dealerId: actor.dealerId }
  const [lines, runs] = await Promise.all([
    prisma.dealerCommissionLine.findMany({
      where,
      select: {
        id: true, kind: true, effectiveOn: true,
        netCents: true, vatCents: true, grossCents: true, dealId: true,
        deal: { select: { application: { select: { reference: true } } } },
        loan: { select: { reference: true } },
        runLinks: { where: { voided: false }, select: { runId: true } },
      },
      orderBy: [{ effectiveOn: "desc" }, { createdAt: "desc" }],
      take: 1000,
    }),
    prisma.dealerPayableRun.findMany({
      where,
      select: {
        id: true, periodEnd: true, status: true, totalNetCents: true, totalVatCents: true, totalGrossCents: true,
        createdAt: true, approvedAt: true, releasedAt: true, releaseReference: true, cancelledAt: true,
      },
      orderBy: [{ periodEnd: "desc" }, { createdAt: "desc" }],
      take: 200,
    }),
  ])
  const totals = { earnedNetCents: 0, reversedNetCents: 0, netCents: 0, grossCents: 0 }
  for (const l of lines) {
    if (l.kind === "EARNED") totals.earnedNetCents += l.netCents
    else totals.reversedNetCents += l.netCents
    totals.netCents += l.netCents
    totals.grossCents += l.grossCents
  }
  return {
    totals,
    lines: lines.map((l) => ({
      id: l.id, kind: l.kind, effectiveOn: isoDay(l.effectiveOn), dealId: l.dealId,
      dealReference: l.deal.application.reference, loanReference: l.loan.reference,
      netCents: l.netCents, vatCents: l.vatCents, grossCents: l.grossCents,
      runId: l.runLinks[0]?.runId ?? null,
    })),
    runs: runs.map((r) => ({
      id: r.id, periodEnd: isoDay(r.periodEnd), status: r.status,
      totalNetCents: r.totalNetCents, totalVatCents: r.totalVatCents, totalGrossCents: r.totalGrossCents,
      createdAt: r.createdAt.toISOString(), approvedAt: r.approvedAt?.toISOString() ?? null,
      releasedAt: r.releasedAt?.toISOString() ?? null, releaseReference: r.releaseReference, cancelledAt: r.cancelledAt?.toISOString() ?? null,
    })),
  }
}

export type DealerCommissionStatement = Awaited<ReturnType<typeof loadDealerCommissionStatement>>
