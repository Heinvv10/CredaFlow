import type { prisma } from "@/lib/prisma"
import type { ScreeningCheckFacts } from "./state"

type Db = Pick<typeof prisma, "screeningCheck">

export type LatestRun = {
  runId: string
  runAt: Date
  checks: Array<ScreeningCheckFacts & { createdAt: Date }>
}

/**
 * The client's latest screening run: every check sharing the runId of the
 * newest row. Same ordering as the SQL trigger guardLoanApplicationScreening.
 */
export async function loadLatestRun(db: Db, tenantId: string, clientId: string): Promise<LatestRun | null> {
  const newest = await db.screeningCheck.findFirst({
    where: { tenantId, clientId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { runId: true, createdAt: true },
  })
  if (!newest) return null
  const checks = await db.screeningCheck.findMany({
    where: { tenantId, runId: newest.runId },
    select: { id: true, type: true, result: true, decision: true, simulated: true, createdAt: true },
    orderBy: { type: "asc" },
  })
  return { runId: newest.runId, runAt: newest.createdAt, checks }
}

/**
 * Serialises everything that writes or relies on one client's screening: a
 * run, a review, and the approval transaction's re-check. Without it an
 * approval could commit against a run that a concurrent re-screen is
 * replacing with a new match.
 */
export async function lockClientScreening(
  tx: Pick<typeof prisma, "$executeRaw">,
  tenantId: string,
  clientId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`screening:${tenantId}:${clientId}`}))`
}
