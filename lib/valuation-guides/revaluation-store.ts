/**
 * Loads the book revaluation (./revaluation.ts): every live asset-finance
 * loan of the tenant with its asset and the asset's latest GUIDE valuation,
 * and the current guides' rows for those assets' makes, models and years.
 */
import type { LoanStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { isoOfDbDate } from "@/lib/asset-finance/dates"
import type { GuideSnapshot } from "./lookup"
import { revalue, type CurrentGuideRow, type RevaluationRow } from "./revaluation"

/** Live on the book: not settled, written off or cancelled. */
export const LIVE_LOAN_STATUSES: LoanStatus[] = ["ACTIVE", "DEFAULTED", "PENDING_WRITE_OFF", "RESTRUCTURED"]

type GuideRowSql = Omit<CurrentGuideRow, "effectiveOn"> & { effectiveOn: Date }

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
  const guideValuations = await prisma.assetValuation.findMany({
    where: { tenantId, assetId: { in: assetIds }, source: "GUIDE" },
    orderBy: [{ valuedOn: "desc" }, { createdAt: "desc" }],
    select: { assetId: true, guideSnapshot: true },
  })
  const lastGuide = new Map<string, GuideSnapshot>()
  for (const v of guideValuations) if (!lastGuide.has(v.assetId)) lastGuide.set(v.assetId, v.guideSnapshot as unknown as GuideSnapshot)

  const rows = await prisma.$queryRaw<GuideRowSql[]>`
    SELECT g."id" AS "guideId", g."name" AS "guideName", g."effectiveOn", g."simulated", r."id" AS "rowId",
      r."make", r."model", r."year", r."variant", r."tradeCents", r."retailCents"
    FROM "ValuationGuideRow" r JOIN "ValuationGuide" g ON g."id" = r."guideId" AND g."tenantId" = r."tenantId"
    JOIN "FinancedAsset" a ON a."tenantId" = r."tenantId" AND lower(btrim(a."make")) = lower(r."make")
      AND lower(btrim(a."model")) = lower(r."model") AND a."year" = r."year"
    WHERE r."tenantId" = ${tenantId} AND g."status" = 'PUBLISHED' AND g."effectiveOn" <= ${sastCalendarDate(new Date())}::date
      AND a."id" = ANY(${assetIds})
    GROUP BY g."id", r."id"
    ORDER BY g."name", r."variant"`

  const book = loans.flatMap((l) => {
    if (!l.asset) return []
    const last = lastGuide.get(l.asset.id)
    return [{
      loanId: l.id, reference: l.reference, contractType: l.contractType, outstandingCents: l.outstandingPrincipal, asset: l.asset,
      lastGuide: last ? { guideName: last.guideName, variant: last.variant, tradeCents: last.tradeCents } : null,
    }]
  })
  return revalue(book, rows.map((r) => ({ ...r, effectiveOn: isoOfDbDate(r.effectiveOn) })))
}
