/**
 * recomputeApplicationFlags: run every check over an application's current
 * evidence and reconcile the stored flags, idempotently.
 *
 *   - a finding with no row yet          → new OPEN flag
 *   - an OPEN flag still raised          → stays OPEN (summary/evidence refreshed)
 *   - a CLEARED flag still raised        → stays CLEARED (the officer's decision holds)
 *   - a SUPERSEDED flag raised again     → OPEN again, cleared of nothing
 *   - an OPEN flag no longer raised      → SUPERSEDED
 *
 * Runs only before a decision: once an application is approved or declined
 * its flags are the record of what the officer saw, and stay as they were.
 * The application row is locked for the write, so a recompute and the approve
 * transaction (which takes the same row lock) cannot interleave.
 */
import type { AppStatus, ApplicationCheckFlag, Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { loadApplicationFacts } from "./load-facts"
import { runChecks } from "./run-checks"

export const RECOMPUTE_STATUSES: readonly AppStatus[] = ["DRAFT", "SUBMITTED", "UNDER_REVIEW"]

export interface RecomputeActor {
  userId: string
  email?: string
}

export interface RecomputeResult {
  recomputed: boolean
  flags: ApplicationCheckFlag[]
}

function listFlags(tenantId: string, applicationId: string, db: Pick<typeof prisma, "applicationCheckFlag"> = prisma) {
  return db.applicationCheckFlag.findMany({
    where: { tenantId, applicationId },
    orderBy: [{ check: "asc" }, { raisedAt: "asc" }],
  })
}

export async function recomputeApplicationFlags(
  tenantId: string,
  applicationId: string,
  actor: RecomputeActor | null,
): Promise<RecomputeResult | null> {
  const loaded = await loadApplicationFacts(tenantId, applicationId)
  if (!loaded) return null
  if (!RECOMPUTE_STATUSES.includes(loaded.status)) {
    return { recomputed: false, flags: await listFlags(tenantId, applicationId) }
  }
  const candidates = runChecks(loaded.facts)

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ status: AppStatus }>>`
      SELECT status FROM "LoanApplication" WHERE id = ${applicationId} AND "tenantId" = ${tenantId} FOR UPDATE`
    if (!locked[0] || !RECOMPUTE_STATUSES.includes(locked[0].status)) {
      return { recomputed: false, flags: await listFlags(tenantId, applicationId, tx) }
    }
    const existing = new Map((await listFlags(tenantId, applicationId, tx)).map((f) => [f.fingerprint, f]))
    const raisedNow = new Set<string>()
    const counts = { raised: 0, reopened: 0, superseded: 0 }

    for (const c of candidates) {
      raisedNow.add(c.fingerprint)
      const evidence = c.evidence as Prisma.InputJsonValue
      const prior = existing.get(c.fingerprint)
      if (!prior) {
        await tx.applicationCheckFlag.create({
          data: { tenantId, applicationId, check: c.check, code: c.code, fingerprint: c.fingerprint, summary: c.summary, evidence },
        })
        counts.raised++
      } else if (prior.status === "SUPERSEDED") {
        await tx.applicationCheckFlag.update({
          where: { id: prior.id, tenantId },
          data: { status: "OPEN", summary: c.summary, evidence, raisedAt: new Date() },
        })
        counts.reopened++
      } else if (prior.status === "OPEN") {
        await tx.applicationCheckFlag.update({ where: { id: prior.id, tenantId }, data: { summary: c.summary, evidence } })
      }
    }
    for (const prior of existing.values()) {
      if (prior.status === "OPEN" && !raisedNow.has(prior.fingerprint)) {
        await tx.applicationCheckFlag.update({ where: { id: prior.id, tenantId }, data: { status: "SUPERSEDED" } })
        counts.superseded++
      }
    }

    const flags = await listFlags(tenantId, applicationId, tx)
    if (counts.raised + counts.reopened + counts.superseded > 0) {
      await logAuditStrict({
        tenantId,
        userId: actor?.userId,
        userEmail: actor?.email,
        action: AuditAction.CREDIT_CHECKS_RECOMPUTED,
        entity: "LoanApplication",
        entityId: applicationId,
        newValue: { ...counts, open: flags.filter((f) => f.status === "OPEN").length },
      }, tx)
    }
    return { recomputed: true, flags }
  })
}
