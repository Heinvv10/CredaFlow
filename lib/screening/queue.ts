import type { ScreeningResult, ScreeningType } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { loadLatestRun } from "./store"
import { isConfirmedSanctionsMatch } from "./state"

export const REVIEW_QUEUE_CAP = 100

export type ReviewQueueItem = {
  checkId: string
  clientId: string
  clientName: string
  clientReference: string
  type: ScreeningType
  result: ScreeningResult
  matches: unknown
  simulated: boolean
  createdAt: Date
  /** A confirmed sanctions match: shown, never decidable. */
  hardBlock: boolean
}

/**
 * Undecided matches in each client's LATEST run, oldest first: the review
 * queue. Matches in a superseded run are not shown — a newer run replaced them.
 */
export async function listReviewQueue(tenantId: string): Promise<ReviewQueueItem[]> {
  const open = await prisma.screeningCheck.findMany({
    where: { tenantId, decision: null, result: { in: ["POSSIBLE_MATCH", "CONFIRMED_MATCH"] } },
    orderBy: { createdAt: "asc" },
    take: REVIEW_QUEUE_CAP * 3,
    select: {
      id: true, clientId: true, runId: true, type: true, result: true, matches: true, simulated: true, createdAt: true,
      client: { select: { firstName: true, lastName: true, reference: true } },
    },
  })
  const latestRunByClient = new Map<string, string | null>()
  const items: ReviewQueueItem[] = []
  for (const c of open) {
    if (!latestRunByClient.has(c.clientId)) {
      latestRunByClient.set(c.clientId, (await loadLatestRun(prisma, tenantId, c.clientId))?.runId ?? null)
    }
    if (latestRunByClient.get(c.clientId) !== c.runId) continue
    items.push({
      checkId: c.id,
      clientId: c.clientId,
      clientName: `${c.client.firstName} ${c.client.lastName}`,
      clientReference: c.client.reference,
      type: c.type,
      result: c.result,
      matches: c.matches,
      simulated: c.simulated,
      createdAt: c.createdAt,
      hardBlock: isConfirmedSanctionsMatch(c),
    })
    if (items.length >= REVIEW_QUEUE_CAP) break
  }
  return items
}
