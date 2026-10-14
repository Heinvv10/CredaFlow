/**
 * The second person's decision on a PENDING reference rate (DESIGN.md D4,
 * four-eyes). Runs inside the caller's transaction.
 *
 * The row is locked (FOR UPDATE) and re-read, so two deciders cannot both
 * decide it. The decider must not be the requester: refused here so the route
 * can answer 403 and audit it, and also CHECK ReferenceRate_four_eyes. Once
 * decided the row is immutable (trigger guardReferenceRateLifecycle).
 *
 * An APPROVED value reprices the linked loans through the cron
 * (./reprice-batch.ts). An approval that reprices nothing because it is
 * superseded (a later value of the basis is already approved) or backdated
 * (effective before today) puts a bell item in front of the loan admins
 * (./reprice-notice.ts alertLoanAdmins): loans whose contract rate already
 * runs from that date or later are skipped by the repricing as "superseded",
 * and a person must decide whether any needs a manual adjustment.
 */
import { Prisma, type ReferenceRate, type ReferenceRateBasis } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { dbDate, isoOfDbDate } from "./dates"
import { alertLoanAdmins } from "./reprice-notice"

export type DecisionDb = Pick<typeof prisma, "$queryRaw" | "referenceRate" | "loan" | "user" | "notification" | "auditLog">

export type ReferenceRateDecision = "APPROVE" | "REJECT"

export interface ApprovalReach {
  wouldReprice: number // ACTIVE linked loans the cron will reprice on it
  alreadyLater: number // loans on the basis already carrying a contract rate from its date or later
  superseded: boolean
  backdated: boolean
  alerted: boolean
}

export type DecisionOutcome =
  | { kind: "not_found" }
  | { kind: "not_pending"; status: string }
  | { kind: "self_decision" }
  | { kind: "decided"; rate: ReferenceRate; reach: ApprovalReach | null }

const percent = (rate: Prisma.Decimal): string => `${rate.mul(100).toString()}%`

/** Who an approval of `rate` reaches, and the loan-admin bell when it reaches nobody. */
export async function checkApprovalReach(db: DecisionDb, rate: ReferenceRate, today: string): Promise<ApprovalReach> {
  const { tenantId, basis, effectiveDate } = rate
  const asset = { tenantId, status: "ACTIVE" as const, contractType: { not: "LOAN" as const } }
  const wouldReprice = await db.loan.count({
    where: {
      ...asset,
      ncaRegime: "NON_NCA",
      contractRates: { some: { basis, effectiveDate: { lt: effectiveDate } }, none: { effectiveDate: { gte: effectiveDate } } },
    },
  })
  const alreadyLater = await db.loan.count({
    where: { ...asset, AND: [{ contractRates: { some: { basis } } }, { contractRates: { some: { effectiveDate: { gte: effectiveDate } } } }] },
  })
  const later = await db.referenceRate.findFirst({
    where: { tenantId, basis, status: "APPROVED", effectiveDate: { gt: effectiveDate }, id: { not: rate.id } },
    select: { id: true },
  })
  const superseded = later !== null
  const backdated = effectiveDate.getTime() < dbDate(today).getTime()
  const reach = { wouldReprice, alreadyLater, superseded, backdated, alerted: false }
  if (wouldReprice > 0 || !(superseded || backdated)) return reach

  const day = isoOfDbDate(effectiveDate)
  const why = superseded ? `a later ${basis} value is already approved` : `it took effect on ${day}, before today`
  await alertLoanAdmins(db, tenantId, {
    type: "REFERENCE_RATE_NO_EFFECT",
    title: `Approved ${basis} ${percent(rate.rate)} from ${day} reprices no loan`,
    body: `No loan will be repriced on it: ${why}. ${alreadyLater} loan(s) on ${basis} already carry a contract rate from ${day} or later and are skipped. Check whether any of them needs a manual adjustment.`,
    entityType: "ReferenceRate",
    entityId: rate.id,
  })
  return { ...reach, alerted: true }
}

export async function decideReferenceRate(
  tx: DecisionDb,
  input: { tenantId: string; rateId: string; decision: ReferenceRateDecision; deciderId: string; deciderEmail?: string; today: string },
): Promise<DecisionOutcome> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "ReferenceRate" WHERE "id" = ${input.rateId} AND "tenantId" = ${input.tenantId} FOR UPDATE
  `)
  if (!locked[0]) return { kind: "not_found" }
  const pending = await tx.referenceRate.findFirst({ where: { id: input.rateId, tenantId: input.tenantId } })
  if (!pending) return { kind: "not_found" }
  if (pending.status !== "PENDING") return { kind: "not_pending", status: pending.status }
  if (pending.requestedById === input.deciderId) return { kind: "self_decision" }

  const status = input.decision === "APPROVE" ? "APPROVED" : "REJECTED"
  const rate = await tx.referenceRate.update({
    where: { id: pending.id, tenantId: input.tenantId },
    data: { status, decidedById: input.deciderId, decidedAt: new Date() },
  })
  const reach = status === "APPROVED" ? await checkApprovalReach(tx, rate, input.today) : null
  await logAuditStrict({
    tenantId: input.tenantId,
    userId: input.deciderId,
    userEmail: input.deciderEmail,
    action: AuditAction.REFERENCE_RATE_DECIDED,
    entity: "ReferenceRate",
    entityId: rate.id,
    oldValue: { status: "PENDING" },
    newValue: {
      status, basis: rate.basis satisfies ReferenceRateBasis, effectiveDate: isoOfDbDate(rate.effectiveDate),
      rate: rate.rate.toString(), requestedById: rate.requestedById, ...(reach ? { reach } : {}),
    },
  }, tx)
  return { kind: "decided", rate, reach }
}
