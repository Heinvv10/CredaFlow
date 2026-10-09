// Resolving the ONE rate card in force for a product at a point in time.
//
// This is the only file in the rating module that touches the database. It
// exists so that `rate-quote.ts` can stay pure: this loads, that prices.
//
// An ACTIVE table is never mutated — a rate change creates a new version and
// retires the old one — so "which table applies" is a question about dates and
// status, and it must have exactly one answer. Two ACTIVE tables overlapping
// the same instant is a configuration fault, and picking one arbitrarily would
// quote a price nobody chose. It returns an error instead.

import type { InsuranceRateTable, Prisma, PrismaClient } from "@prisma/client"
import type { RateBandInput } from "./rate-quote"

export interface ResolveRateTableParams {
  tenantId: string
  productId: string
  /** The instant the rate card must be in force at. Caller-supplied, never `new Date()` here. */
  at: Date
}

export interface ResolvedRateTable {
  id: string
  version: number
  name: string
  basis: InsuranceRateTable["basis"]
  effectiveFrom: Date
  effectiveTo: Date | null
  insurerId: string | null
  bands: RateBandInput[]
}

export type ResolveRateTableResult =
  | { ok: true; table: ResolvedRateTable }
  | { ok: false; reason: "NOT_CONFIGURED" | "NO_BANDS" | "AMBIGUOUS_ACTIVE_TABLES"; detail: string; tableIds: string[] }

/** Minimal shape this module needs, so a caller may pass a client or a transaction. */
type RateTableReader = Pick<PrismaClient, "insuranceRateTable">

/**
 * The query, separated from the call so it is assertable without a database —
 * the same pattern as `creditLifeOfferFindFirstArgs`. Note `effectiveTo` is
 * exclusive (`gt`) and `effectiveFrom` inclusive (`lte`), so a table retired at
 * the exact instant its successor starts leaves no gap and no overlap.
 */
export function activeRateTableFindManyArgs({ tenantId, productId, at }: ResolveRateTableParams) {
  return {
    where: {
      tenantId,
      productId,
      status: "ACTIVE",
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: [{ version: "desc" }, { id: "asc" }],
    select: {
      id: true,
      version: true,
      name: true,
      basis: true,
      effectiveFrom: true,
      effectiveTo: true,
      insurerId: true,
      bands: {
        orderBy: [{ lifeType: "asc" }, { minAge: "asc" }, { sumAssured: "asc" }],
        select: {
          id: true,
          lifeType: true,
          minAge: true,
          maxAge: true,
          sumAssured: true,
          premiumAmount: true,
        },
      },
    },
  } satisfies Prisma.InsuranceRateTableFindManyArgs
}

export async function resolveActiveRateTable(
  prisma: RateTableReader,
  params: ResolveRateTableParams,
): Promise<ResolveRateTableResult> {
  const tables = await prisma.insuranceRateTable.findMany(activeRateTableFindManyArgs(params))

  if (tables.length === 0) {
    return {
      ok: false,
      reason: "NOT_CONFIGURED",
      detail: `No ACTIVE rate table is in force for product ${params.productId} at ${params.at.toISOString()}`,
      tableIds: [],
    }
  }
  if (tables.length > 1) {
    return {
      ok: false,
      reason: "AMBIGUOUS_ACTIVE_TABLES",
      detail: `${tables.length} ACTIVE rate tables are in force for product ${params.productId} at ${params.at.toISOString()}`,
      tableIds: tables.map((table) => table.id),
    }
  }

  const table = tables[0]
  if (table.bands.length === 0) {
    return {
      ok: false,
      reason: "NO_BANDS",
      detail: `ACTIVE rate table ${table.id} has no bands, so nothing can be priced against it`,
      tableIds: [table.id],
    }
  }

  return { ok: true, table }
}
