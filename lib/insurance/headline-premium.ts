// The per-product headline price shown on catalogue cards and pickers.
//
// InsuranceProduct.premiumAmount is a flat column that QUOTING IGNORES for a
// product with a rate table, so showing it as "the" price quotes a client a
// different number than the one they are then charged. For a rated product the
// honest headline is the cheapest MAIN_MEMBER band: "From R 62.00/mo".

import type { Prisma } from "@prisma/client"

export interface HeadlinePremium {
  /** Rands. */
  amount: number
  /** True when `amount` is the cheapest main-member band, not the flat column. */
  from: boolean
}

type BandLike = { lifeType: string; premiumAmount: { toString(): string } | number | string }

/** Structural, so both the plain and the tenant-scoped extended client fit. */
interface RateTableReader {
  insuranceRateTable: {
    findMany(
      args: ReturnType<typeof headlineRateTablesFindManyArgs>,
    ): PromiseLike<{ productId: string; bands: BandLike[] }[]>
  }
}

/** Pure: flat price unless the product has MAIN_MEMBER bands. */
export function resolveHeadlinePremium(flat: number, bands: BandLike[] | undefined): HeadlinePremium {
  const main = (bands ?? [])
    .filter((b) => b.lifeType === "MAIN_MEMBER")
    .map((b) => Number(b.premiumAmount.toString()))
    .filter((n) => Number.isFinite(n))
  if (main.length === 0) return { amount: flat, from: false }
  return { amount: Math.min(...main), from: true }
}

/** The query, exposed so it is assertable without a database. */
export function headlineRateTablesFindManyArgs(tenantId: string, productIds: string[], at: Date) {
  return {
    where: {
      tenantId,
      productId: { in: productIds },
      status: "ACTIVE",
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: [{ version: "desc" }],
    select: {
      productId: true,
      bands: { where: { lifeType: "MAIN_MEMBER" }, select: { lifeType: true, premiumAmount: true } },
    },
  } satisfies Prisma.InsuranceRateTableFindManyArgs
}

/**
 * Headline premium per product id, from each product's in-force ACTIVE rate
 * table (the one quoting prices against). One query for the whole catalogue.
 */
export async function loadHeadlinePremiums(
  prisma: RateTableReader,
  tenantId: string,
  products: { id: string; premiumAmount: number }[],
  at: Date = new Date(),
): Promise<Map<string, HeadlinePremium>> {
  const out = new Map<string, HeadlinePremium>()
  if (products.length === 0) return out
  const tables = await prisma.insuranceRateTable.findMany(
    headlineRateTablesFindManyArgs(tenantId, products.map((p) => p.id), at),
  )
  // Highest version first: the first table seen per product is the one used.
  const bandsByProduct = new Map<string, BandLike[]>()
  for (const t of tables) if (!bandsByProduct.has(t.productId)) bandsByProduct.set(t.productId, t.bands)
  for (const p of products) out.set(p.id, resolveHeadlinePremium(p.premiumAmount, bandsByProduct.get(p.id)))
  return out
}
