/**
 * recomputeApplicationFlags: run every check over an application's current
 * evidence and reconcile the stored flags, idempotently.
 *
 *   - a finding with no row yet          → new OPEN flag
 *   - an OPEN flag still raised          → stays OPEN (summary/evidence refreshed if changed)
 *   - a CLEARED flag                     → never changes (the officer's decision holds;
 *                                          the database refuses it too)
 *   - a SUPERSEDED flag raised again     → OPEN again
 *   - an OPEN flag no longer raised      → SUPERSEDED only when the evidence it
 *     complained of being absent arrived, or the statement it could not read
 *     has been read (maySupersede). Otherwise it stays OPEN: a deleted
 *     statement, an edited client record or a parser change must not make a
 *     finding disappear without an officer clearing it.
 *
 * Runs only before a decision: once an application is approved or declined
 * its flags are the record of what the officer saw, and stay as they were.
 * The application row is locked for the write, so a recompute and the approve
 * transaction (which takes the same row lock) cannot interleave.
 */
import type { AppStatus, ApplicationCheckFlag, Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { canonicalJson } from "@/lib/canonical-json"
import { loadApplicationFacts } from "./load-facts"
import { runChecks } from "./run-checks"
import type { ApplicationFacts } from "./types"

export const RECOMPUTE_STATUSES: readonly AppStatus[] = ["DRAFT", "SUBMITTED", "UNDER_REVIEW"]

export interface RecomputeActor {
  userId: string
  email?: string
}

export interface RecomputeResult {
  recomputed: boolean
  flags: ApplicationCheckFlag[]
  /** When the evidence the flags rest on was read, under the lock: anything newer was not checked. */
  evidenceAsOf?: Date
  /** Every payslip in the window as the evidence saw it (payslipStateKey), and the window's start. */
  payslipSnapshot?: string[]
  evidenceSince?: Date
}

function listFlags(tenantId: string, applicationId: string, db: Pick<typeof prisma, "applicationCheckFlag"> = prisma) {
  return db.applicationCheckFlag.findMany({
    where: { tenantId, applicationId },
    orderBy: [{ check: "asc" }, { raisedAt: "asc" }],
  })
}

/** Codes about evidence absent from the application: once it exists, the flag has nothing left to say. */
const SUPERSEDES_ON_ARRIVAL = new Set(["NO_STATEMENT", "NO_PAYSLIP"])
/** Codes about a statement not yet read: they go once that statement is read, not if it is deleted. */
const SUPERSEDES_ON_READ = new Set(["NOT_READ", "NOT_READ_NO_CONSENT"])

export function maySupersede(flag: ApplicationCheckFlag, facts: ApplicationFacts): boolean {
  if (SUPERSEDES_ON_ARRIVAL.has(flag.code)) return true
  const e = (flag.evidence ?? {}) as { documentId?: unknown; payslipDocumentId?: unknown }
  // A payslip that could not be read goes once it has been extracted.
  if (flag.code === "PAYSLIP_NOT_READ") return typeof e.payslipDocumentId === "string" && facts.extractedPayslipIds.includes(e.payslipDocumentId)
  const current = facts.statements.find((s) => s.documentId === e.documentId)
  // Every other finding stays until an officer clears it — even after a newer
  // parser re-reads its statement, since the finding may have gone for reasons
  // that have nothing to do with the re-read.
  return SUPERSEDES_ON_READ.has(flag.code) && !!current && current.state !== "PENDING"
}

export async function recomputeApplicationFlags(
  tenantId: string,
  applicationId: string,
  actor: RecomputeActor | null,
): Promise<RecomputeResult | null> {
  // Read any unread statement first, outside the lock: that is the slow part.
  const warm = await loadApplicationFacts(tenantId, applicationId)
  if (!warm) return null
  if (!RECOMPUTE_STATUSES.includes(warm.status)) {
    return { recomputed: false, flags: await listFlags(tenantId, applicationId) }
  }

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ status: AppStatus }>>`
      SELECT status FROM "LoanApplication" WHERE id = ${applicationId} AND "tenantId" = ${tenantId} FOR NO KEY UPDATE`
    if (!locked[0] || !RECOMPUTE_STATUSES.includes(locked[0].status)) {
      return { recomputed: false, flags: await listFlags(tenantId, applicationId, tx) }
    }
    // Facts again under the lock, so a slower recompute cannot act on older
    // evidence. Persisted reads only: no reader runs while the lock is held.
    const evidenceAsOf = new Date()
    const pendingReasons = new Map(warm.facts.statements.flatMap((s) => (s.pendingReason ? [[s.documentId, s.pendingReason] as const] : [])))
    const loaded = await loadApplicationFacts(tenantId, applicationId, { persistedOnly: true, pendingReasons })
    if (!loaded) return { recomputed: false, flags: [] }
    const candidates = runChecks(loaded.facts)
    const existing = new Map((await listFlags(tenantId, applicationId, tx)).map((f) => [f.fingerprint, f]))
    const raisedNow = new Set<string>()
    const changed = { raised: [] as string[], reopened: [] as string[], superseded: [] as string[] }
    const label = (f: { id: string; code: string }) => `${f.code}:${f.id}`

    for (const c of candidates) {
      raisedNow.add(c.fingerprint)
      const evidence = c.evidence as Prisma.InputJsonValue
      const prior = existing.get(c.fingerprint)
      if (!prior) {
        const created = await tx.applicationCheckFlag.create({
          data: { tenantId, applicationId, check: c.check, code: c.code, fingerprint: c.fingerprint, summary: c.summary, evidence },
        })
        changed.raised.push(label(created))
      } else if (prior.status === "SUPERSEDED") {
        const { count } = await tx.applicationCheckFlag.updateMany({
          where: { id: prior.id, tenantId, status: "SUPERSEDED" },
          data: { status: "OPEN", summary: c.summary, evidence, raisedAt: new Date() },
        })
        if (count) changed.reopened.push(label(prior))
      } else if (prior.status === "OPEN" && (prior.summary !== c.summary || canonicalJson(prior.evidence) !== canonicalJson(c.evidence))) {
        await tx.applicationCheckFlag.updateMany({ where: { id: prior.id, tenantId, status: "OPEN" }, data: { summary: c.summary, evidence } })
      }
    }
    for (const prior of existing.values()) {
      if (prior.status !== "OPEN" || raisedNow.has(prior.fingerprint) || !maySupersede(prior, loaded.facts)) continue
      const { count } = await tx.applicationCheckFlag.updateMany({
        where: { id: prior.id, tenantId, status: "OPEN" },
        data: { status: "SUPERSEDED" },
      })
      if (count) changed.superseded.push(label(prior))
    }

    const flags = await listFlags(tenantId, applicationId, tx)
    if (changed.raised.length + changed.reopened.length + changed.superseded.length > 0) {
      await logAuditStrict({
        tenantId,
        userId: actor?.userId,
        userEmail: actor?.email,
        action: AuditAction.CREDIT_CHECKS_RECOMPUTED,
        entity: "LoanApplication",
        entityId: applicationId,
        newValue: { ...changed, open: flags.filter((f) => f.status === "OPEN").length },
      }, tx)
    }
    return { recomputed: true, flags, evidenceAsOf, payslipSnapshot: loaded.payslipSnapshot, evidenceSince: loaded.since }
  }, { timeout: 30_000 })
}

/**
 * After a statement is read: raise its findings on every undecided application
 * of the client now, rather than when someone next opens one of them.
 */
export async function recomputeClientApplications(tenantId: string, clientId: string): Promise<void> {
  const apps = await prisma.loanApplication.findMany({
    where: { tenantId, clientId, status: { in: [...RECOMPUTE_STATUSES] } },
    select: { id: true },
  })
  for (const app of apps) {
    // One application failing must not leave the client's others unchecked.
    await recomputeApplicationFlags(tenantId, app.id, null).catch((err) => {
      console.error("[credit-checks] recompute failed:", { applicationId: app.id, error: err instanceof Error ? err.name : "unknown" })
    })
  }
}
