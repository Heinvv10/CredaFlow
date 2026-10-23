/**
 * A data subject's decision records (POPIA s23, DESIGN.md §2.3): every
 * CreditDecisionRecord of one lender whose subject is the client, by the
 * client id itself or by an application or loan the client holds, oldest
 * first. The tenantId is named in every read, so the tenant-scope extension
 * and RLS (where on) are not the only fence between lenders. A leadId is not
 * followed: a lead is no client until one is confirmed, and a refusal that
 * confirmed one carries its clientId.
 */
import type { prisma } from "@/lib/prisma"

export type DsarExportDb = Pick<typeof prisma, "creditDecisionRecord" | "loanApplication" | "loan">

export async function decisionRecordsForClient(db: DsarExportDb, tenantId: string, clientId: string | null) {
  if (!clientId) return []
  const [applications, loans] = await Promise.all([
    db.loanApplication.findMany({ where: { tenantId, clientId }, select: { id: true } }),
    db.loan.findMany({ where: { tenantId, clientId }, select: { id: true } }),
  ])
  return db.creditDecisionRecord.findMany({
    where: {
      tenantId,
      OR: [
        { clientId },
        { applicationId: { in: applications.map((a) => a.id) } },
        { loanId: { in: loans.map((l) => l.id) } },
      ],
    },
    orderBy: [{ decidedAt: "asc" }, { id: "asc" }],
  })
}
