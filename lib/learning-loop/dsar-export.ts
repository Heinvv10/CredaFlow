/**
 * A data subject's decision records (POPIA s23, DESIGN.md §2.3): every
 * CreditDecisionRecord of one lender whose subject is the client, by the
 * client id itself or by an application or loan the client holds, oldest
 * first. The tenantId is named in every read, so the tenant-scope extension
 * and RLS (where on) are not the only fence between lenders. A leadId is not
 * followed: a lead is no client until one is confirmed, and a refusal that
 * confirmed one carries its clientId. A record that names a different client
 * is another person's, even on this client's application or loan (a joint
 * borrower, a guarantor, a mis-stamped id): only a record with no client id
 * is matched through the application or loan.
 *
 * Only the fields below leave: the subject's own data and what explains the
 * decision. Not the lender's tenantId, nor actorUserId (the staff member's
 * identity, not the subject's data; actorType and actorRole say what kind of
 * decider it was).
 */
import type { prisma } from "@/lib/prisma"

const EXPORT_FIELDS = {
  id: true, kind: true, decision: true, recommendation: true, overridden: true, overrideReason: true,
  actorType: true, actorRole: true, applicationId: true, loanId: true, clientId: true, leadId: true,
  sourceEntityType: true, sourceEntityId: true, ruleVersion: true, policyHash: true, modelVersion: true,
  predictedProbability: true, inputsSnapshot: true, evidenceRefs: true, inputsHash: true,
  s71ReviewRequired: true, decidedAt: true, createdAt: true,
} as const

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
        { clientId: null, applicationId: { in: applications.map((a) => a.id) } },
        { clientId: null, loanId: { in: loans.map((l) => l.id) } },
      ],
    },
    select: EXPORT_FIELDS,
    orderBy: [{ decidedAt: "asc" }, { id: "asc" }],
  })
}
