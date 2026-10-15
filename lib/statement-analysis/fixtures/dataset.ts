/**
 * The invented account the fixtures describe: T TESTER, three months of a
 * salary from SYNTHCO, groceries, airtime, and — depending on the scenario — an
 * undisclosed loan, betting, a payday lender and a returned debit order.
 */
import type { SynthStatement, SynthTx } from "./synthetic"

export type SynthBank = "CAPITEC" | "FNB" | "NEDBANK" | "ABSA" | "ABSA_ESTATEMENT" | "STANDARD_BANK" | "DISCOVERY"

export interface Scenario {
  /** First day of the first month (YYYY-MM-01); the statement runs three months. */
  start: string
  netPayCents?: number
  payDay?: number
  /** A monthly DebiCheck to "SYNTHLEND FINANCE" that the client does not declare. */
  undisclosedLoan?: boolean
  gambling?: boolean
  paydayLender?: boolean
  returnedDebit?: boolean
  /** FNB: a creditor's failed early debit order, printed but not posted. */
  collectionAttempt?: boolean
  /** Capitec rows carry a Fee column; the other banks print fees as their own rows. */
  bank: SynthBank
}

const day = (month: string, d: number) => `${month}-${String(d).padStart(2, "0")}`

function monthsFrom(start: string): string[] {
  const y = Number(start.slice(0, 4))
  const m = Number(start.slice(5, 7))
  return [0, 1, 2].map((i) => {
    const mm = ((m - 1 + i) % 12) + 1
    const yy = y + Math.floor((m - 1 + i) / 12)
    return `${yy}-${String(mm).padStart(2, "0")}`
  })
}

function lastDay(month: string): string {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
  return d.toISOString().slice(0, 10)
}

export function syntheticStatement(s: Scenario): SynthStatement {
  const net = s.netPayCents ?? 1_845_000
  const payDay = s.payDay ?? 25
  const months = monthsFrom(s.start)
  const fee = (cents: number): Partial<SynthTx> => (s.bank === "CAPITEC" ? { feeCents: -cents } : {})
  const tx: SynthTx[] = []
  for (const m of months) {
    tx.push({ date: day(m, 2), description: "Card Purchase: SYNTH MART GROCER", category: "Groceries", amountCents: -84_550 })
    tx.push({ date: day(m, 4), description: "Prepaid Airtime: SYNTHTEL", category: "Cellphone", amountCents: -9_900, ...fee(150) })
    if (s.undisclosedLoan) tx.push({ date: day(m, 5), description: "DebiCheck Debit: SYNTHLEND FINANCE", category: "Loan Payments", amountCents: -125_000 })
    if (s.gambling) tx.push({ date: day(m, 12), description: "Card Purchase: HOLLYWOODBETS", category: "Entertainment", amountCents: -150_000 })
    tx.push({ date: day(m, 15), description: "Card Purchase: SYNTH FUEL", category: "Transport", amountCents: -60_000 })
    tx.push({ date: day(m, payDay), description: "Payment Received: SALARY SYNTHCO", category: "Other Income", amountCents: net })
    tx.push({ date: day(m, 27), description: "Payment To: SYNTH RENTALS", category: "Transfer", amountCents: -650_000, ...fee(350) })
  }
  if (s.paydayLender) tx.push({ date: day(months[1], 9), description: "Payment Received: LENDPLUS", category: "Other Income", amountCents: 150_000 })
  if (s.collectionAttempt) tx.push({ date: day(months[2], 7), description: "EDO Collection Attempt SYNTHLEND", amountCents: 125_000, nonPosting: true })
  if (s.returnedDebit) tx.push({ date: day(months[2], 6), description: "DebiCheck Insufficient Funds Fee", category: "Fees", amountCents: -1_000 })
  tx.sort((a, b) => a.date.localeCompare(b.date))
  return {
    holder: "T TESTER",
    accountNumber: s.bank === "FNB" ? "62000000001" : "0000000001",
    periodStart: day(months[0], 1),
    periodEnd: lastDay(months[2]),
    openingCents: 234_567,
    transactions: tx,
  }
}
