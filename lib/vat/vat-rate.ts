// The VAT rate in force on a date, from the national VatRate table. A rate
// applies from its effectiveDate (inclusive) until the next row's.
import { Prisma } from "@prisma/client"
import { toDayNumber } from "@/lib/asset-finance/dates"
import { RATE_SCALE } from "./amounts"
import type { VatTransaction } from "./db"

export interface VatRateRow {
  effectiveDate: Date
  rate: Prisma.Decimal | string | number
}

export interface VatRateInForce {
  /** ISO date the rate took effect. */
  effectiveDate: string
  /** The rate as stored, e.g. "0.1500". */
  rate: string
  /** The rate in ten-thousandths, e.g. 1500 (see ./amounts). */
  rateTenThousandths: number
}

export class NoVatRateError extends Error {
  constructor(readonly date: string) {
    super(`No VAT rate is in force on ${date}`)
    this.name = "NoVatRateError"
  }
}

/** A @db.Date column comes back as UTC midnight; its calendar date. */
function isoOfDbDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** A stored four-place rate (e.g. "0.1500") in ten-thousandths (1500), exactly. */
export function rateTenThousandthsOf(stored: Prisma.Decimal | string | number): number {
  const rate = new Prisma.Decimal(stored)
  const scaled = rate.mul(RATE_SCALE)
  if (!scaled.isInteger() || scaled.isNegative() || scaled.gte(RATE_SCALE)) {
    throw new RangeError(`VAT rate ${rate.toString()} is not a four-place rate in [0, 1)`)
  }
  return scaled.toNumber()
}

function toRateInForce(row: VatRateRow): VatRateInForce {
  const rateTenThousandths = rateTenThousandthsOf(row.rate)
  return {
    effectiveDate: isoOfDbDate(row.effectiveDate),
    rate: new Prisma.Decimal(row.rate).toFixed(4),
    rateTenThousandths,
  }
}

/**
 * Pure selector: the rate whose effectiveDate is the latest on or before
 * `date` (ISO YYYY-MM-DD). Throws NoVatRateError when none is.
 */
export function rateOn(rows: readonly VatRateRow[], date: string): VatRateInForce {
  const day = toDayNumber(date, "date")
  let best: VatRateRow | undefined
  for (const row of rows) {
    const from = toDayNumber(isoOfDbDate(row.effectiveDate), "VatRate.effectiveDate")
    if (from <= day && (!best || from > toDayNumber(isoOfDbDate(best.effectiveDate)))) best = row
  }
  if (!best) throw new NoVatRateError(date)
  return toRateInForce(best)
}

type VatRateDb = Pick<VatTransaction, "vatRate">

/** Loads the rate in force on `date` from the database. */
export async function loadRateOn(db: VatRateDb, date: string): Promise<VatRateInForce> {
  toDayNumber(date, "date")
  const row = await db.vatRate.findFirst({
    where: { effectiveDate: { lte: new Date(`${date}T00:00:00.000Z`) } },
    orderBy: { effectiveDate: "desc" },
  })
  return rateOn(row ? [row] : [], date)
}
