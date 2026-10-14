import type { ReferenceRate } from "@prisma/client"
import { isoOfDbDate } from "@/lib/asset-finance/dates"

/** Most rows one GET of the reference-rate history returns. */
export const REFERENCE_RATES_PAGE_LIMIT = 200

/** The API shape of a reference rate: calendar date and rate as strings. */
export const referenceRateView = (row: ReferenceRate) => ({
  id: row.id,
  basis: row.basis,
  effectiveDate: isoOfDbDate(row.effectiveDate),
  rate: row.rate.toString(),
  status: row.status,
  requestedById: row.requestedById,
  decidedById: row.decidedById,
  decidedAt: row.decidedAt,
  createdAt: row.createdAt,
})
