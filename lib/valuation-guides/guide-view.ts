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
