import type { prisma } from "@/lib/prisma"
import type { ScreeningCheckFacts } from "./state"
import { subjectKey, subjectWhere } from "./subject"
import type { SubjectRef } from "./types"

type Db = Pick<typeof prisma, "screeningCheck">

export type LatestRun = {
  runId: string
  runAt: Date
  provider: string
  checks: Array<ScreeningCheckFacts & { createdAt: Date }>
}

/**
 * The subject's latest screening run: every check sharing the runId of the
 * newest row. Same ordering as the SQL function screeningSubjectRefusal.
 */
export async function loadLatestRun(db: Db, tenantId: string, ref: SubjectRef): Promise<LatestRun | null> {
  const newest = await db.screeningCheck.findFirst({
    where: { tenantId, ...subjectWhere(ref) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { runId: true, createdAt: true, provider: true },
  })
  if (!newest) return null
  const checks = await db.screeningCheck.findMany({
    where: { tenantId, runId: newest.runId },
    select: { id: true, type: true, result: true, decision: true, simulated: true, subjectFingerprint: true, createdAt: true },
    orderBy: { type: "asc" },
  })
  return { runId: newest.runId, runAt: newest.createdAt, provider: newest.provider, checks }
}

/** Source-check ids of the subject's unlifted sticky blocks. */
export async function loadActiveBlocks(db: Pick<typeof prisma, "screeningBlock">, tenantId: string, ref: SubjectRef): Promise<string[]> {
  const blocks = await db.screeningBlock.findMany({
    where: { tenantId, ...subjectWhere(ref), liftedAt: null },
    select: { sourceCheckId: true },
    orderBy: { createdAt: "asc" },
  })
  return blocks.map((b) => b.sourceCheckId)
}

/**
 * N7: source-check ids of unlifted blocks that bind an entity because of a
 * person — one screened for this entity (contextEntityId), or anyone with any
 * relationship row to it, active or not. Deactivating or deleting the
 * relationship after a hit does not free the entity. Same rule as the SQL
 * function screeningEntityContextBlocked.
 */
export async function loadEntityContextBlocks(
  db: Pick<typeof prisma, "screeningBlock" | "entityRelationship">,
  tenantId: string,
  entityId: string,
): Promise<string[]> {
  const related = await db.entityRelationship.findMany({ where: { tenantId, entityId }, select: { clientId: true } })
  const blocks = await db.screeningBlock.findMany({
    where: {
      tenantId,
      liftedAt: null,
      OR: [{ contextEntityId: entityId }, { clientId: { in: [...new Set(related.map((r) => r.clientId))] } }],
    },
    select: { sourceCheckId: true },
    orderBy: { createdAt: "asc" },
  })
  return blocks.map((b) => b.sourceCheckId)
}

/**
 * Serialises everything that writes or relies on one subject's screening: a
 * run, a review, a block lift and the approval transaction's re-check.
 * Callers locking several subjects lock them in subjectKey order.
 */
export async function lockSubjectScreening(
  tx: Pick<typeof prisma, "$executeRaw">,
  tenantId: string,
  ref: SubjectRef,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`screening:${tenantId}:${subjectKey(ref)}`}))`
}
