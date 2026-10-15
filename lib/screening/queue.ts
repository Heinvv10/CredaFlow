import { Prisma, type ScreeningBlockReason, type ScreeningResult, type ScreeningType } from "@prisma/client"
import { prisma } from "@/lib/prisma"

export const REVIEW_QUEUE_PAGE_SIZE = 50

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
}

export type ReviewQueuePage = { items: ReviewQueueItem[]; total: number; page: number; pageSize: number }

/**
 * The review queue (N5): undecided matches of each subject's LATEST run only —
 * a superseded run's matches are not shown — oldest first, a page at a time,
 * with the true total. A confirmed sanctions match is never decidable, so it
 * is not here: its sticky block is in the blocks list.
 */
export async function listReviewQueue(tenantId: string, page = 1): Promise<ReviewQueuePage> {
  const pageSize = REVIEW_QUEUE_PAGE_SIZE
  const current = Math.max(1, Math.floor(page))
  const where = Prisma.sql`
    WITH latest AS (
      SELECT DISTINCT ON ("clientId", "entityId") "runId" FROM "ScreeningCheck"
       WHERE "tenantId" = ${tenantId}
       ORDER BY "clientId", "entityId", "createdAt" DESC, id DESC
    )
    SELECT s.id, s."createdAt" FROM "ScreeningCheck" s JOIN latest l ON l."runId" = s."runId"
     WHERE s."tenantId" = ${tenantId} AND s.decision IS NULL
       AND s.result IN ('POSSIBLE_MATCH', 'CONFIRMED_MATCH')
       AND NOT (s.type = 'SANCTIONS' AND s.result = 'CONFIRMED_MATCH')`
  const [rows, counted] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`${where} ORDER BY s."createdAt" ASC, s.id ASC LIMIT ${pageSize} OFFSET ${(current - 1) * pageSize}`),
    prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`SELECT count(*) AS total FROM (${where}) q`),
  ])
  const checks = await prisma.screeningCheck.findMany({
    where: { tenantId, id: { in: rows.map((r) => r.id) } },
    select: {
      id: true, clientId: true, entityId: true, type: true, result: true, matches: true,
      simulated: true, createdAt: true, triggeredById: true, ...partySelect,
    },
  })
  const byId = new Map(checks.map((c) => [c.id, c]))
  const items = rows.flatMap(({ id }) => {
    const c = byId.get(id)
    return c ? [{
      checkId: c.id, clientId: c.clientId, entityId: c.entityId,
      partyName: partyName(c), partyReference: partyReference(c),
      type: c.type, result: c.result, matches: c.matches, simulated: c.simulated, createdAt: c.createdAt,
      triggeredById: c.triggeredById,
    }] : []
  })
  return { items, total: Number(counted[0]?.total ?? 0), page: current, pageSize }
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
