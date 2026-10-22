/**
 * Real-Postgres helpers for the valuation-guide suites (docs/asset-finance/
 * SLICE5.md part C): a guide loaded as a DRAFT with its rows, published by a
 * second user, a GUIDE valuation of an asset, and the cleanup that removes
 * guides before the deal fixture's own. Every value is synthetic. Not a test file.
 */
import { createHash, randomUUID } from "node:crypto"
import type { Prisma, PrismaClient } from "@prisma/client"
import { sastCalendarDate } from "@/lib/date/sast"
import { dbDate, fromDayNumber, toDayNumber } from "@/lib/asset-finance/dates"

type Db = PrismaClient | Prisma.TransactionClient

export interface GuideRowSeed { make: string; model: string; year: number; variant?: string; tradeCents: number; retailCents: number }

export const today = () => sastCalendarDate(new Date())
export const day = (offset: number) => fromDayNumber(toDayNumber(today()) + offset)

/** The deal fixture's first asset (TEST EX-1 2025) in two variants. */
export const EX1_ROWS: GuideRowSeed[] = [
  { make: "TEST", model: "EX-1", year: 2025, variant: "", tradeCents: 120_000_000, retailCents: 140_000_000 },
  { make: "TEST", model: "EX-1", year: 2025, variant: "Long reach", tradeCents: 125_000_000, retailCents: 146_000_000 },
  { make: "TEST", model: "EX-2", year: 2025, variant: "", tradeCents: 110_000_000, retailCents: 130_000_000 },
]

/** A unique sha256 for a guide that never shares a file with another. */
export const freshSha = () => createHash("sha256").update(randomUUID()).digest("hex")

/** A DRAFT guide uploaded by `uploadedById` with `rows` (rowCount defaults to their number). */
export async function draftGuide(
  db: Db, tenantId: string, uploadedById: string,
  o: { name?: string; effectiveOn?: string; rows?: GuideRowSeed[]; rowCount?: number; sha?: string; simulated?: boolean } = {},
): Promise<{ id: string; rowIds: string[] }> {
  const rows = o.rows ?? EX1_ROWS
  const guide = await db.valuationGuide.create({
    data: {
      tenantId, name: o.name ?? "TEST Plant Guide", effectiveOn: dbDate(o.effectiveOn ?? today()), provider: "csv", simulated: o.simulated ?? false,
      fileSha256: o.sha ?? freshSha(), rowCount: o.rowCount ?? rows.length, uploadedById,
    },
    select: { id: true },
  })
  const rowIds: string[] = []
  for (const [i, row] of rows.entries()) {
    rowIds.push((await db.valuationGuideRow.create({
      data: { tenantId, guideId: guide.id, lineNumber: i + 2, variant: "", ...row },
      select: { id: true },
    })).id)
  }
  return { id: guide.id, rowIds }
}

/** Publishes a DRAFT guide as `publishedById` (a second user). */
export const publishGuideRow = (db: Db, id: string, publishedById: string) =>
  db.valuationGuide.update({ where: { id }, data: { status: "PUBLISHED", publishedById, publishedAt: new Date() } })

/** Supersedes `id` by `successorId` (publish the successor in the same transaction). */
export const supersedeGuideRow = (db: Db, id: string, successorId: string) =>
  db.valuationGuide.update({ where: { id }, data: { status: "SUPERSEDED", supersededById: successorId, supersededAt: new Date() } })

/** A DRAFT guide, published by the second user. */
export async function publishedGuide(
  db: Db, tenantId: string, uploadedById: string, publishedById: string, o: Parameters<typeof draftGuide>[3] = {},
): Promise<{ id: string; rowIds: string[] }> {
  const guide = await draftGuide(db, tenantId, uploadedById, o)
  await publishGuideRow(db, guide.id, publishedById)
  return guide
}

/** A GUIDE valuation as the lookup writes it: today, the row's trade value, no snapshot (the database writes it). */
export function guideValuationData(
  tenantId: string, assetId: string, guideId: string, guideRowId: string, amountCents: number, createdById: string,
  over: Record<string, unknown> = {},
) {
  return {
    tenantId, assetId, valuedOn: dbDate(today()), source: "GUIDE" as const, valuerName: "TEST Plant Guide",
    amountCents, guideId, guideRowId, createdById, ...over,
  }
}

/** Removes the tenant's guides and GUIDE valuations (triggers off), before the deal fixture's cleanup. */
export async function cleanupGuides(db: PrismaClient, tenantId: string): Promise<void> {
  await db.$transaction([
    db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
    db.assetValuation.deleteMany({ where: { tenantId, guideId: { not: null } } }),
    db.valuationGuideRow.deleteMany({ where: { tenantId } }),
    db.valuationGuide.deleteMany({ where: { tenantId } }),
  ])
}
