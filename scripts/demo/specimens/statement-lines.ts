/**
 * Transactions for a persona's specimen bank statement.
 *
 * Each month shows the salary credit (exactly the payslip's net pay, on the
 * payslip's pay date), one debit order per declared debt (exactly the declared
 * instalment), and day-to-day spending that follows the declared expense
 * breakdown. Spending is scaled down if a persona's commitments would
 * otherwise overdraw the account, so the running balance stays plausible.
 */
import type { Persona } from '../personas/types'
import { EMPLOYERS } from '../personas/catalog'
import { createRng, type Rng } from '../personas/prng'
import { expenseTotalCents, debtTotalCents } from '../personas/build'
import { type CalendarDate, daysInMonth, isoDate } from './pay-schedule'

export interface StatementLine {
  date: CalendarDate
  description: string
  /** Positive = credit, negative = debit. Cents. */
  amountCents: number
  balanceCents: number
}

export interface StatementData {
  openingBalanceCents: number
  closingBalanceCents: number
  totalCreditsCents: number
  totalDebitsCents: number
  lines: StatementLine[]
}

const MONTHLY_FEE_CENTS: Readonly<Record<Persona['bank']['bankCode'], number>> = {
  ABSA: 69_00, FNB: 59_00, NEDBANK: 65_00, STANDARD_BANK: 62_00, CAPITEC: 7_50, TYME_BANK: 0,
}

type Draft = Omit<StatementLine, 'balanceCents'>

function vary(rng: Rng, cents: number): number {
  return Math.round((cents * (0.9 + rng.next() * 0.2)) / 10) * 10
}

/** Split `total` into `parts` uneven pieces that sum exactly. */
function split(rng: Rng, total: number, parts: number): number[] {
  const weights = Array.from({ length: parts }, () => 0.6 + rng.next())
  const sum = weights.reduce((a, b) => a + b, 0)
  const out = weights.map((w) => Math.round((total * w) / sum / 10) * 10)
  out[out.length - 1]! += total - out.reduce((a, b) => a + b, 0)
  return out
}

function monthLines(p: Persona, rng: Rng, pay: CalendarDate, end: CalendarDate): Draft[] {
  const { year, month } = pay
  const lastDay = year === end.year && month === end.month ? end.day : daysInMonth(year, month)
  const at = (day: number): CalendarDate => ({ year, month, day: Math.max(1, Math.min(day, lastDay)) })
  const town = p.address.city.toUpperCase()
  const out: Draft[] = []

  const fee = MONTHLY_FEE_CENTS[p.bank.bankCode]
  if (fee > 0) out.push({ date: at(1), description: 'MONTHLY ACCOUNT FEE', amountCents: -fee })
  for (const d of p.debts) {
    out.push({ date: at(d.debitDay), description: `DEBIT ORDER ${d.creditProvider.toUpperCase()}`, amountCents: -d.monthlyInstalmentCents })
  }
  out.push({ date: at(pay.day), description: `SALARY ${employerShortName(p)}`, amountCents: p.payroll.netCents })

  // Spending budget: declared expenses, capped so the month cannot overdraw.
  const ceiling = p.payroll.netCents - debtTotalCents(p.debts) - fee - 300_00
  const scale = Math.min(1, Math.max(0, ceiling) / Math.max(1, expenseTotalCents(p.expenses)))
  const e = p.expenses
  const s = (cents: number): number => vary(rng, cents * scale)

  if (e.housing > 0) out.push({ date: at(pay.day + 1), description: 'EFT RENT PAYMENT', amountCents: -s(e.housing) })
  if (e.insurance > 0) out.push({ date: at(3), description: 'DEBIT ORDER FUNERAL COVER PREMIUM', amountCents: -s(e.insurance) })
  if (e.education > 0) out.push({ date: at(pay.day + 2), description: 'EFT SCHOOL FEES', amountCents: -s(e.education) })
  const groceryDays = [pay.day + 1, pay.day - 13, pay.day - 6, pay.day + 4]
  split(rng, s(e.food), 4).forEach((amt, i) => out.push({ date: at(groceryDays[i]!), description: `POS PURCHASE GROCER ${town}`, amountCents: -amt }))
  split(rng, s(e.transport), 3).forEach((amt, i) => out.push({ date: at(pay.day - 18 + i * 9), description: i === 1 ? 'TAXI CARD TOP-UP' : `POS PURCHASE FUEL ${town}`, amountCents: -amt }))
  if (e.clothing > 0) out.push({ date: at(pay.day + 3), description: `POS PURCHASE CLOTHING ${town}`, amountCents: -s(e.clothing) })
  if (e.medical > 0) out.push({ date: at(pay.day - 9), description: `POS PURCHASE PHARMACY ${town}`, amountCents: -s(e.medical) })
  if (e.entertainment > 0) out.push({ date: at(pay.day - 2), description: 'PREPAID DATA BUNDLE', amountCents: -s(e.entertainment) })
  if (e.other > 0) out.push({ date: at(pay.day + 2), description: 'ATM CASH WITHDRAWAL', amountCents: -s(e.other) })

  // What is left after commitments and spending is largely moved to savings,
  // as a real account holder would; otherwise the balance climbs by the full
  // surplus every month and the statement stops looking lived-in.
  const outflow = out.reduce((sum, l) => sum + Math.min(0, l.amountCents), 0)
  const surplus = p.payroll.netCents + outflow
  const transfer = Math.floor((surplus * 0.8) / 100_00) * 100_00
  if (transfer >= 200_00) out.push({ date: at(pay.day + 5), description: 'TRANSFER TO SAVINGS POCKET', amountCents: -transfer })

  return out
}

/** The employer as a bank prints it in the salary narrative. */
export function employerShortName(p: Persona): string {
  const employer = EMPLOYERS.find((e) => e.name === p.employment.employerName)
  if (!employer) throw new Error(`persona ${p.id} has an employer outside the catalogue`)
  return employer.shortName
}

export function buildStatement(p: Persona, payDates: readonly CalendarDate[], end: CalendarDate): StatementData {
  const rng = createRng(`credaflow-demo-statement:${p.id}:${isoDate(end)}`)
  const cushion = rng.int(600, 3500) * 100 + rng.int(0, 99)
  const drafts = payDates.flatMap((pay) => monthLines(p, rng, pay, end))
  // Stable sort by date; same-day lines keep generation order (fees, debit
  // orders, then salary, then spending).
  const ordered = drafts
    .map((d, i) => ({ d, i }))
    .sort((a, b) => isoDate(a.d.date).localeCompare(isoDate(b.d.date)) || a.i - b.i)
    .map(({ d }) => d)
  // Debit orders early in the first month are paid from the PREVIOUS month's
  // salary, which the statement does not show — so the opening balance must
  // carry them, or the account reads as overdrawn on day one.
  let running = 0
  let lowest = 0
  for (const d of ordered) {
    running += d.amountCents
    lowest = Math.min(lowest, running)
  }
  const openingBalanceCents = cushion - lowest
  let balance = openingBalanceCents
  let credits = 0
  let debits = 0
  const lines = ordered.map((d) => {
    balance += d.amountCents
    if (d.amountCents > 0) credits += d.amountCents
    else debits -= d.amountCents
    return { ...d, balanceCents: balance }
  })
  return { openingBalanceCents, closingBalanceCents: balance, totalCreditsCents: credits, totalDebitsCents: debits, lines }
}
