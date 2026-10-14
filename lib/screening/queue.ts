import type { ScreeningBlockReason, ScreeningResult, ScreeningType } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { loadLatestRun } from "./store"
import { isConfirmedSanctionsMatch } from "./state"
import { refOf, subjectKey } from "./subject"

export const REVIEW_QUEUE_CAP = 100

type Party = { client: { firstName: string; lastName: string; reference: string } | null; entity: { legalName: string; registrationNumber: string } | null }

const partyName = (p: Party) => (p.client ? `${p.client.firstName} ${p.client.lastName}` : p.entity?.legalName ?? "—")
const partyReference = (p: Party) => p.client?.reference ?? p.entity?.registrationNumber ?? ""
const partySelect = {
  client: { select: { firstName: true, lastName: true, reference: true } },
  entity: { select: { legalName: true, registrationNumber: true } },
} as const

export type ReviewQueueItem = {
  checkId: string
  clientId: string | null
  entityId: string | null
  partyName: string
  partyReference: string
  type: ScreeningType
  result: ScreeningResult
  matches: unknown
  simulated: boolean
  createdAt: Date
  triggeredById: string | null
  /** A confirmed sanctions match: shown, never decidable. */
  hardBlock: boolean
}

/**
 * Undecided matches in each subject's LATEST run, oldest first: the review
 * queue. Matches in a superseded run are not shown — a newer run replaced them.
 */
export async function listReviewQueue(tenantId: string): Promise<ReviewQueueItem[]> {
  const open = await prisma.screeningCheck.findMany({
    where: { tenantId, decision: null, result: { in: ["POSSIBLE_MATCH", "CONFIRMED_MATCH"] } },
    orderBy: { createdAt: "asc" },
    take: REVIEW_QUEUE_CAP * 3,
    select: {
      id: true, clientId: true, entityId: true, runId: true, type: true, result: true, matches: true,
      simulated: true, createdAt: true, triggeredById: true, ...partySelect,
    },
  })
  const latestRunBySubject = new Map<string, string | null>()
  const items: ReviewQueueItem[] = []
  for (const c of open) {
    const ref = refOf(c)
    const key = subjectKey(ref)
    if (!latestRunBySubject.has(key)) {
      latestRunBySubject.set(key, (await loadLatestRun(prisma, tenantId, ref))?.runId ?? null)
    }
    if (latestRunBySubject.get(key) !== c.runId) continue
    items.push({
      checkId: c.id, clientId: c.clientId, entityId: c.entityId,
      partyName: partyName(c), partyReference: partyReference(c),
      type: c.type, result: c.result, matches: c.matches, simulated: c.simulated, createdAt: c.createdAt,
      triggeredById: c.triggeredById, hardBlock: isConfirmedSanctionsMatch(c),
    })
    if (items.length >= REVIEW_QUEUE_CAP) break
  }
  return items
}

export type ActiveBlock = {
  id: string
  clientId: string | null
  entityId: string | null
  partyName: string
  partyReference: string
  reason: ScreeningBlockReason
  createdAt: Date
}

/** Unlifted sticky blocks, oldest first. */
export async function listActiveBlocks(tenantId: string): Promise<ActiveBlock[]> {
  const blocks = await prisma.screeningBlock.findMany({
    where: { tenantId, liftedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, clientId: true, entityId: true, reason: true, createdAt: true, ...partySelect },
  })
  return blocks.map((b) => ({
    id: b.id, clientId: b.clientId, entityId: b.entityId, reason: b.reason, createdAt: b.createdAt,
    partyName: partyName(b), partyReference: partyReference(b),
  }))
}
