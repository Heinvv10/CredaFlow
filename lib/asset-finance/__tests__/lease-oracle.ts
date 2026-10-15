// TEST-ONLY independent oracle for lease pricing (lib/asset-finance/lease-pricing.ts).
//
// Structured differently from the code under test: it walks every calendar
// day with JS Date objects, keeps an unrounded finance-charge accumulator,
// finds the base rental by bisection, escalates by repeated exact-fraction
// multiplication (numerator/denominator BigInt pairs), and computes VAT as
// floor((2 × amount × rate + 10000) / 20000) over BigInt. It imports no
// production code.

const MS_PER_DAY = 86_400_000

export interface OracleLease {
  capitalCents: number
  residualCents: number
  periods: number
  timing: "ADVANCE" | "ARREARS"
  escalation: string
  startDate: string
  firstDueDate?: string
  annualRate: number // a single rate for the whole term
  maintenanceCents: number | null
  maintenanceEscalation: string
  vatTenThousandths: number
}

export interface OracleLeasePeriod {
  dueDate: string
  rental: number
  maintenance: number
  vat: number
  total: number
}

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

function addMonths(anchor: string, months: number): string {
  const d = new Date(`${anchor}T00:00:00Z`)
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months + 1, 0)).getUTCDate()
  return iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, Math.min(d.getUTCDate(), lastDay)))
}

export function oracleDueDates(lease: OracleLease): string[] {
  const out: string[] = []
  for (let i = 0; i < lease.periods; i++) {
    if (lease.timing === "ADVANCE") out.push(addMonths(lease.startDate, i))
    else if (lease.firstDueDate) out.push(addMonths(lease.firstDueDate, i))
    else out.push(addMonths(lease.startDate, i + 1))
  }
  return out
}

/** (1 + rate)^years as an exact fraction, then half-up to millionths. */
function factor(rate: string, years: number): number {
  const [w, f = ""] = rate.split(".")
  let num = BigInt(w + f) + BigInt(10) ** BigInt(f.length)
  const den1 = BigInt(10) ** BigInt(f.length)
  let n = BigInt(1)
  let d = BigInt(1)
  for (let y = 0; y < years; y++) {
    n *= num
    d *= den1
  }
  num = n * BigInt(1_000_000)
  return Number((num + d / BigInt(2)) / d) / 1_000_000
}

export const oracleWeights = (lease: OracleLease): number[] =>
  Array.from({ length: lease.periods }, (_, i) => factor(lease.escalation, Math.floor(i / 12)))

function vat(cents: number, rate: number): number {
  return Number((BigInt(2) * BigInt(cents) * BigInt(rate) + BigInt(10_000)) / BigInt(20_000))
}

/** Walk the days; pay(i, balance, accrued) gives period i's rental. Returns the balance after the last rental. */
function walk(lease: OracleLease, round: boolean, pay: (i: number, balance: number, charge: number) => number): { rentals: number[]; balance: number } {
  const dates = oracleDueDates(lease)
  let balance = lease.capitalCents
  let accrued = 0
  const rentals: number[] = []
  let ms = Date.parse(`${lease.startDate}T00:00:00Z`)
  let next = 0
  // An ADVANCE first rental falls on the start date itself: no days accrue.
  if (dates[0] === lease.startDate) {
    const rental = pay(0, balance, 0)
    rentals.push(rental)
    balance -= rental
    next = 1
  }
  while (next < dates.length) {
    ms += MS_PER_DAY
    accrued += (balance * lease.annualRate) / 365
    if (iso(ms) !== dates[next]) continue
    const charge = round ? Math.round(accrued) : accrued
    const rental = pay(next, balance, charge)
    rentals.push(rental)
    balance = balance + charge - rental
    accrued = 0
    next++
  }
  return { rentals, balance }
}

export function oracleRealBase(lease: OracleLease): number {
  const w = oracleWeights(lease)
  const after = (b: number) => walk(lease, false, (i) => b * w[i]).balance
  let lo = 0
  let hi = lease.capitalCents
  for (let k = 0; k < 90; k++) {
    const mid = (lo + hi) / 2
    if (after(mid) > lease.residualCents) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

export function oraclePeriods(lease: OracleLease, baseCents: number): OracleLeasePeriod[] {
  const w = oracleWeights(lease)
  const last = lease.periods - 1
  const { rentals } = walk(lease, true, (i, balance, charge) =>
    i === last ? balance + charge - lease.residualCents : Math.round(baseCents * w[i]))
  const dates = oracleDueDates(lease)
  return rentals.map((rental, i) => {
    const maintenance = lease.maintenanceCents === null
      ? 0
      : halfUpMillionths(lease.maintenanceCents, factor(lease.maintenanceEscalation, Math.floor(i / 12)))
    const v = vat(rental, lease.vatTenThousandths) + vat(maintenance, lease.vatTenThousandths)
    return { dueDate: dates[i], rental, maintenance, vat: v, total: rental + maintenance + v }
  })
}

/** cents × f (f a 6-decimal factor) rounded half-up, exactly. */
function halfUpMillionths(cents: number, f: number): number {
  const micro = BigInt(Math.round(f * 1_000_000))
  return Number((BigInt(2) * BigInt(cents) * micro + BigInt(1_000_000)) / BigInt(2_000_000))
}
