import type { ValuationGuide } from "@prisma/client"
import { isoOfDbDate } from "@/lib/asset-finance/dates"

/** The API shape of a valuation guide: its effective date as a calendar date. */
export const guideView = (row: ValuationGuide) => ({
  id: row.id,
  name: row.name,
  effectiveOn: isoOfDbDate(row.effectiveOn),
  provider: row.provider,
  simulated: row.simulated,
  status: row.status,
  rowCount: row.rowCount,
  fileSha256: row.fileSha256,
  uploadedById: row.uploadedById,
  uploadedAt: row.uploadedAt,
  publishedById: row.publishedById,
  publishedAt: row.publishedAt,
  supersededById: row.supersededById,
  supersededAt: row.supersededAt,
  discardedById: row.discardedById,
  discardedAt: row.discardedAt,
})

/** A rows page's ?offset: a whole number from 0 to the guide's row count, else 0 (or the count when past it). */
export function clampOffset(raw: string | string[] | undefined, rowCount: number): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw ?? 0)
  if (!Number.isInteger(n) || n < 0) return 0
  return Math.min(n, rowCount)
}
