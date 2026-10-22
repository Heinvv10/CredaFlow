/**
 * A deal's goods advance against a guide value (docs/asset-finance/SLICE5.md
 * part C, deviation 4). Guide values are VAT-inclusive, so the advance is the
 * cash price incl. VAT less the deposit and the trade-in. Display only: no
 * LTV threshold is enforced.
 */

export function goodsAdvanceCents(input: { cashPriceExclVatCents: number; vatCents: number; depositCents: number; tradeInCents: number }): number {
  return Math.max(0, input.cashPriceExclVatCents + input.vatCents - input.depositCents - input.tradeInCents)
}

/** The advance over the value in basis points, half up; null without a value. */
export function ltvBps(advanceCents: number, valueCents: number): number | null {
  if (valueCents <= 0) return null
  return Number((BigInt(advanceCents) * BigInt(20_000) + BigInt(valueCents)) / (BigInt(2) * BigInt(valueCents)))
}

export function formatLtv(bps: number | null): string {
  return bps === null ? "—" : `${(bps / 100).toFixed(2)}%`
}
