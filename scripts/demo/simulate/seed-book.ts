/**
 * The base seed's own loans (prisma/seed.ts LN-SEED-0001 and the asset-finance
 * book) are booked at the window's start. Left alone they fall six months
 * into arrears by the end date, and their balances are the largest in the
 * book: the audit's 94% PAR30. A demo lender's seed book is a performing one,
 * so each loan that is ACTIVE at the start, and not in a recovery or legal
 * matter (those storylines are the seed's own), is paid on every due date by
 * a staff-captured EFT receipt, as payments.ts captures any other receipt.
 *
 * The seed's open applications would otherwise sit on the board "waiting" for
 * the whole window; their applicants withdraw in the first week, so every
 * open application on the end date is the simulator's own, and fresh.
 */
import { readLoan, type LoanView } from "../servicing/loan-read"
import { ensureActorSessions } from "../servicing/setup"
import { log } from "../sim/env"
import { readDb } from "../sim/readonly-db"
import { schedule, type Sim } from "./context"
import { nextBusinessDay, sastInstant, shiftBusinessDays } from "./dates"
import { addReceipt } from "./money"
import type { Window } from "./plan"

const SEED_BOOK = "seed-book"

export interface SeedBookReceipt {
  id: string
  day: string
  amountCents: number
  installmentNo: number
}

/** One receipt per instalment still owed, on its due date (next business day), inside the window. */
export function seedBookReceipts(loan: Pick<LoanView, "reference" | "rows">, window: Window): SeedBookReceipt[] {
  return loan.rows.flatMap((r) => {
    const day = nextBusinessDay(r.dueDay)
    const owed = r.totalDue - r.totalPaid
    if (owed <= 0 || day <= window.start || day > window.until) return []
    return [{ id: `${SEED_BOOK}:${loan.reference}:instalment-${r.installmentNo}`, day, amountCents: owed, installmentNo: r.installmentNo }]
  })
}

export async function scheduleSeedBook(sim: Sim): Promise<void> {
  const seededBy = sastInstant(sim.window.start, "08:00")
  const apps = await readDb().loanApplication.findMany({
    // Asset-finance deals keep the stage the seed gave them: that is their story.
    where: { status: { in: ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED"] }, createdAt: { lte: seededBy }, assetFinanceDeal: null },
    select: { id: true, reference: true },
  })
  const withdrawDay = shiftBusinessDays(nextBusinessDay(sim.window.start), 5)
  for (const app of apps) {
    schedule(sim, {
      id: `${SEED_BOOK}:${app.reference}:withdrawn`,
      day: withdrawDay,
      at: "11:20",
      personaId: SEED_BOOK,
      run: async () => {
        await ensureActorSessions(sim.actors)
        const res = await sim.actors.officer.request<{ status?: string }>("DELETE", `/api/applications/${app.id}`, undefined, { expect: [200] })
        if (res.json?.status !== "CANCELLED") throw new Error(`cancel returned ${res.text.slice(0, 200)}`)
        log(`seed book: ${app.reference} cancelled at the applicant's request`)
      },
    })
  }

  const loans = await readDb().loan.findMany({
    where: {
      status: "ACTIVE",
      createdAt: { lte: seededBy },
      recoveries: { none: {} },
      legalMatters: { none: {} },
    },
    select: { id: true },
  })
  for (const { id } of loans) {
    const loan = await readLoan(id)
    const receipts = seedBookReceipts(loan, sim.window)
    for (const r of receipts) {
      addReceipt(sim, r.id, SEED_BOOK, r.day, {
        loanId: loan.id, amountCents: r.amountCents, method: "EFT", reference: loan.reference, notes: `Instalment ${r.installmentNo}`,
      })
    }
    log(`seed book: ${loan.reference} paid on ${receipts.length} due date(s)`)
  }
}
