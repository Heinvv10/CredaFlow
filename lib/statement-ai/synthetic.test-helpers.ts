import type { StatementTransaction } from "@/lib/statement-analysis/types"

/** Three months of a salaried synthetic client: a test may pass its own rows. */
export function syntheticTransactions(): StatementTransaction[] {
  const rows: StatementTransaction[] = []
  let balance = 500_000
  for (const m of ["2026-07", "2026-08", "2026-09"]) {
    for (const [day, description, amountCents] of [
      ["02", "Card Purchase: SYNTH MART GROCER", -84_550],
      ["05", "DebiCheck Debit: SYNTHLEND FINANCE", -125_000],
      ["12", "Card Purchase: HOLLYWOODBETS", -150_000],
      ["15", "Card Purchase: SYNTH FUEL", -60_000],
      ["25", "Payment Received: SALARY SYNTHCO", 1_845_000],
      ["27", "Payment To: SYNTH RENTALS", -650_000],
    ] as const) {
      balance += amountCents
      rows.push({ date: `${m}-${day}`, description, amountCents, balanceCents: balance, page: 1 })
    }
  }
  return rows
}
