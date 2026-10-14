// VAT arithmetic in integer cents. A rate is carried as basis points of a
// basis point: ten-thousandths (VatRate.rate is DECIMAL(6,4), so 0.1500 is
// 1500), which keeps every computation in exact integer arithmetic.
//
// Rounding rule: half-up to the cent (0.5 cent rounds away from zero; every
// amount here is non-negative, so that is "up"). VAT is computed per line on
// the line's exclusive value, and an invoice's VAT is the sum of its lines.

/** Denominator of a rate in ten-thousandths: 15% is 1500 / RATE_SCALE. */
export const RATE_SCALE = 10_000

function requireCents(cents: number, label: string): void {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new RangeError(`${label}: expected a non-negative integer number of cents, got ${cents}`)
  }
}

function requireRate(rateTenThousandths: number): void {
  if (!Number.isInteger(rateTenThousandths) || rateTenThousandths < 0 || rateTenThousandths >= RATE_SCALE) {
    throw new RangeError(`rate: expected integer ten-thousandths in [0, ${RATE_SCALE}), got ${rateTenThousandths}`)
  }
}

/** numerator / denominator rounded half-up, both non-negative integers. */
function divideHalfUp(numerator: number, denominator: number): number {
  const product = 2 * numerator + denominator
  if (!Number.isSafeInteger(product)) throw new RangeError("amount too large for exact VAT arithmetic")
  return Math.floor(product / (2 * denominator))
}

/** VAT on a VAT-exclusive amount: exclusive × rate, half-up to the cent. */
export function vatOnExclusive(exclVatCents: number, rateTenThousandths: number): number {
  requireCents(exclVatCents, "exclVatCents")
  requireRate(rateTenThousandths)
  return divideHalfUp(exclVatCents * rateTenThousandths, RATE_SCALE)
}

export interface VatSplit {
  exclVatCents: number
  vatCents: number
  inclVatCents: number
}

/** Adds VAT to an exclusive amount. */
export function addVat(exclVatCents: number, rateTenThousandths: number): VatSplit {
  const vatCents = vatOnExclusive(exclVatCents, rateTenThousandths)
  return { exclVatCents, vatCents, inclVatCents: exclVatCents + vatCents }
}

/**
 * Splits a VAT-inclusive amount. The exclusive part is
 * inclusive × 1 / (1 + rate), half-up to the cent; VAT is the remainder, so
 * the two always add back to the inclusive amount exactly. (VAT so derived is
 * the inclusive amount times the tax fraction rate / (1 + rate), to within
 * the cent the exclusive part was rounded by.)
 */
export function splitInclusive(inclVatCents: number, rateTenThousandths: number): VatSplit {
  requireCents(inclVatCents, "inclVatCents")
  requireRate(rateTenThousandths)
  const exclVatCents = divideHalfUp(inclVatCents * RATE_SCALE, RATE_SCALE + rateTenThousandths)
  return { exclVatCents, vatCents: inclVatCents - exclVatCents, inclVatCents }
}
