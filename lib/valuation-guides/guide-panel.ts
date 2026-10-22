/**
 * The "Guide value" panel's data (deal and asset pages): the current guides'
 * rows for the asset, its latest GUIDE valuation and, on a deal, the goods
 * advance against that valuation's trade and retail values.
 */
import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { guideCandidates, latestGuideValuation, type GuideCandidate, type GuideValuationView } from "./lookup"
import { ltvBps } from "./ltv"

export interface GuidePanelData {
  candidates: GuideCandidate[]
  latest: GuideValuationView | null
  /** On a deal: the goods advance and its LTV against the latest guide valuation's values. */
  advance: { cents: number; tradeLtvBps: number | null; retailLtvBps: number | null } | null
}

/** Null when the asset is not the tenant's. */
export async function loadGuidePanel(tenantId: string, assetId: string, advanceCents: number | null): Promise<GuidePanelData | null> {
  const asset = await prisma.financedAsset.findFirst({ where: { id: assetId, tenantId }, select: { id: true, make: true, model: true, year: true } })
  if (!asset) return null
  const [candidates, latest] = await Promise.all([
    guideCandidates(prisma, tenantId, asset, sastCalendarDate(new Date())),
    latestGuideValuation(prisma, tenantId, asset.id),
  ])
  const advance = advanceCents === null ? null : {
    cents: advanceCents,
    tradeLtvBps: latest ? ltvBps(advanceCents, latest.snapshot.tradeCents) : null,
    retailLtvBps: latest ? ltvBps(advanceCents, latest.snapshot.retailCents) : null,
  }
  return { candidates, latest, advance }
}
