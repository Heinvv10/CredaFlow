/**
 * Loads the book revaluation (./revaluation.ts): every live asset-finance
 * loan of the tenant with its asset and the asset's latest GUIDE valuation,
 * and the current guides' rows for those assets' makes, models and years.
 * Unbounded by design: the whole live book in two queries, no paging (a
 * known limitation, SLICE5.md Part C).
 */
import type { LoanStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { isoOfDbDate } from "@/lib/asset-finance/dates"
import { revalue, type CurrentGuideRow, type RevaluationRow } from "./revaluation"

/** Live on the book: not settled, written off or cancelled. */
export const LIVE_LOAN_STATUSES: LoanStatus[] = ["ACTIVE", "DEFAULTED", "PENDING_WRITE_OFF", "RESTRUCTURED"]

type GuideRowSql = Omit<CurrentGuideRow, "effectiveOn" | "lastTradeCents"> & { effectiveOn: Date; lastTradeCents: number | null }

export async function loadRevaluation(tenantId: string): Promise<RevaluationRow[]> {
  const loans = await prisma.loan.findMany({
    where: { tenantId, assetId: { not: null }, status: { in: LIVE_LOAN_STATUSES } },
    orderBy: { reference: "asc" },
    select: {
      id: true, reference: true, contractType: true, outstandingPrincipal: true,
      asset: { select: { id: true, make: true, model: true, year: true, serialNumber: true } },
    },
  })
  const assetIds = loans.flatMap((l) => (l.asset ? [l.asset.id] : []))
  // Each asset's current guide rows, matched as the asset page matches them, and whether the
  // asset's newest GUIDE valuation read the same guide name and variant.
  const rows = await prisma.$queryRaw<GuideRowSql[]>`
    WITH last AS (
      SELECT DISTINCT ON (v."assetId") v."assetId", v."guideSnapshot" AS snap
      FROM "AssetValuation" v WHERE v."tenantId" = ${tenantId} AND v."source" = 'GUIDE' AND v."assetId" = ANY(${assetIds})
      ORDER BY v."assetId", v."valuedOn" DESC, v."createdAt" DESC
    )
    SELECT a."id" AS "assetId", g."id" AS "guideId", g."name" AS "guideName", g."effectiveOn", g."simulated", r."id" AS "rowId",
      r."make", r."model", r."year", r."variant", r."tradeCents", r."retailCents",
      COALESCE(lower(g."name") = lower(last.snap->>'guideName') AND lower(r."variant") = lower(last.snap->>'variant'), false) AS "recordedVariant",
      (last.snap->>'tradeCents')::int AS "lastTradeCents"
    FROM "FinancedAsset" a
    JOIN "ValuationGuideRow" r ON r."tenantId" = a."tenantId" AND lower(r."make") = lower(btrim(a."make"))
      AND lower(r."model") = lower(btrim(a."model")) AND r."year" = a."year"
    JOIN "ValuationGuide" g ON g."id" = r."guideId" AND g."tenantId" = r."tenantId"
    LEFT JOIN last ON last."assetId" = a."id"
    WHERE a."tenantId" = ${tenantId} AND a."id" = ANY(${assetIds})
      AND g."status" = 'PUBLISHED' AND g."effectiveOn" <= ${sastCalendarDate(new Date())}::date
    ORDER BY a."id", g."name", r."variant"`

  const book = loans.flatMap((l) => l.asset
    ? [{ loanId: l.id, reference: l.reference, contractType: l.contractType, outstandingCents: l.outstandingPrincipal, asset: l.asset }]
    : [])
  return revalue(book, rows.map((r) => ({ ...r, effectiveOn: isoOfDbDate(r.effectiveOn) })))
}
