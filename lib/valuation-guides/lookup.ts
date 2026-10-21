/**
 * Reading a value from the current guides (docs/asset-finance/SLICE5.md part
 * C). The candidates for an asset are the rows of its make, model and year
 * (case and outer spaces ignored) in every PUBLISHED guide in force; staff
 * choose the variant, and the choice is recorded as a GUIDE AssetValuation
 * dated today at the row's trade value. The database repeats every rule and
 * writes the snapshot (guardAssetValuationGuide).
 */
import type { AssetValuation } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { isSimulationPermitted } from "@/lib/integrations/simulation-guard"
import { dbDate, isoOfDbDate } from "@/lib/asset-finance/dates"
import type { GuideActor } from "./guide-store"

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
type Db = Pick<Tx, "$queryRaw" | "assetValuation">

export interface GuideCandidate {
  guideRowId: string
  guideId: string
  guideName: string
  effectiveOn: string
  simulated: boolean
  make: string
  model: string
  year: number
  variant: string
  tradeCents: number
  retailCents: number
}

/** What the database snapshots on a GUIDE valuation (guardAssetValuationGuide). */
export interface GuideSnapshot {
  guideId: string
  guideName: string
  effectiveOn: string
  provider: string
  simulated: boolean
  rowId: string
  lineNumber: number
  make: string
  model: string
  year: number
  variant: string
  tradeCents: number
  retailCents: number
}

export interface GuideValuationView {
  id: string
  valuedOn: string
  amountCents: number
  snapshot: GuideSnapshot
}

type CandidateRow = Omit<GuideCandidate, "effectiveOn"> & { effectiveOn: Date }

/** The current guides' rows for an asset's make, model and year, by guide name then variant. */
export async function guideCandidates(db: Db, tenantId: string, asset: { make: string; model: string; year: number }, today: string): Promise<GuideCandidate[]> {
  const rows = await db.$queryRaw<CandidateRow[]>`
    SELECT r."id" AS "guideRowId", g."id" AS "guideId", g."name" AS "guideName", g."effectiveOn", g."simulated",
      r."make", r."model", r."year", r."variant", r."tradeCents", r."retailCents"
    FROM "ValuationGuideRow" r JOIN "ValuationGuide" g ON g."id" = r."guideId" AND g."tenantId" = r."tenantId"
    WHERE r."tenantId" = ${tenantId} AND g."status" = 'PUBLISHED' AND g."effectiveOn" <= ${today}::date
      AND lower(r."make") = lower(btrim(${asset.make})) AND lower(r."model") = lower(btrim(${asset.model})) AND r."year" = ${asset.year}
    ORDER BY g."name", r."variant", r."id"`
  return rows.map((r) => ({ ...r, effectiveOn: isoOfDbDate(r.effectiveOn) }))
}

/** The asset's latest GUIDE valuation, or null. */
export async function latestGuideValuation(db: Db, tenantId: string, assetId: string): Promise<GuideValuationView | null> {
  const row = await db.assetValuation.findFirst({
    where: { tenantId, assetId, source: "GUIDE" }, orderBy: [{ valuedOn: "desc" }, { createdAt: "desc" }],
    select: { id: true, valuedOn: true, amountCents: true, guideSnapshot: true },
  })
  return row && { id: row.id, valuedOn: isoOfDbDate(row.valuedOn), amountCents: row.amountCents, snapshot: row.guideSnapshot as unknown as GuideSnapshot }
}

export type RecordGuideValuationResult =
  | { kind: "not_found"; what: "asset" | "row" }
  | { kind: "simulation_refused" }
  | { kind: "recorded"; valuation: AssetValuation }

/** Records the chosen current guide row as the asset's GUIDE valuation, today, at its trade value. */
export async function recordGuideValuation(actor: GuideActor, assetId: string, guideRowId: string): Promise<RecordGuideValuationResult> {
  const today = sastCalendarDate(new Date())
  return prisma.$transaction(async (tx): Promise<RecordGuideValuationResult> => {
    const asset = await tx.financedAsset.findFirst({ where: { id: assetId, tenantId: actor.tenantId }, select: { make: true, model: true, year: true } })
    if (!asset) return { kind: "not_found", what: "asset" }
    const row = (await guideCandidates(tx, actor.tenantId, asset, today)).find((c) => c.guideRowId === guideRowId)
    if (!row) return { kind: "not_found", what: "row" }
    if (row.simulated && !isSimulationPermitted("simulated-valuation-guide")) return { kind: "simulation_refused" }
    const valuation = await tx.assetValuation.create({
      data: {
        tenantId: actor.tenantId, assetId, valuedOn: dbDate(today), source: "GUIDE",
        valuerName: `${row.guideName} (guide effective ${row.effectiveOn})`, amountCents: row.tradeCents,
        guideId: row.guideId, guideRowId: row.guideRowId, createdById: actor.userId,
      },
    })
    await logAuditStrict({
      tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail, action: AuditAction.ASSET_GUIDE_VALUATION_RECORDED,
      entity: "AssetValuation", entityId: valuation.id,
      newValue: { assetId, guideId: row.guideId, guideRowId, guideName: row.guideName, effectiveOn: row.effectiveOn, variant: row.variant, tradeCents: row.tradeCents, retailCents: row.retailCents },
    }, tx)
    return { kind: "recorded", valuation }
  })
}
