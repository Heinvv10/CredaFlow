/**
 * The money channels as scheduled events:
 *
 *   - one debit-order run per business day at 14:00, booking every collection
 *     due that day in a single results upload (LOAN_ADMIN);
 *   - the lender's bank statement, imported every Monday at 09:30 (next
 *     business day after a holiday) and once more at 16:00 on the last
 *     business day, carrying the EFT repayments that landed since the last one;
 *   - single receipts captured by an officer (cash/EFT at 14:30).
 */
import { ensureActorSessions } from "../servicing/setup"
import { importStatement, statementCsv, type EftCredit } from "../servicing/bank-statement"
import { recordReceipt, uploadDebitOrderResults, type ReceiptMethod } from "../servicing/payments"
import { log } from "../sim/env"
import { schedule, recordPayment, type DebitOrderLine, type Sim } from "./context"
import { addDays, isBusinessDay, nextBusinessDay } from "./dates"

/** Adds a collection to `day`'s debit-order run, scheduling the run on first use. */
export function addDebitOrder(sim: Sim, day: string, line: DebitOrderLine): void {
  const lines = sim.debitOrders.get(day) ?? []
  if (lines.some((l) => l.key === line.key)) return
  lines.push(line)
  sim.debitOrders.set(day, lines)
  schedule(sim, {
    id: `do-run:${day}`,
    day,
    at: "14:00",
    personaId: null,
    run: async () => {
      const live = (sim.debitOrders.get(day) ?? []).filter((l) => !sim.state.failedPersonas.includes(l.personaId))
      if (live.length === 0) return
      await ensureActorSessions(sim.actors)
      const ids = await uploadDebitOrderResults(sim.actors.loanAdmin, day, live.map((l) => ({
        loanRef: l.loanRef,
        amountCents: l.amountCents,
        paymentRef: `DO${day.replace(/-/g, "")}${l.loanRef.slice(-6).toUpperCase()}`,
      })))
      for (const l of live) {
        const id = ids.get(l.loanRef)
        if (!id) throw new Error(`debit-order run ${day}: no payment booked for ${l.loanRef}`)
        recordPayment(sim, l.key, id)
      }
    },
  })
}

/** Schedules an officer-captured receipt (cash or EFT) for the day. */
export function addReceipt(
  sim: Sim,
  id: string,
  personaId: string,
  day: string,
  r: { loanId: string; amountCents: number; method: ReceiptMethod; reference: string; notes: string },
): void {
  schedule(sim, {
    id,
    day,
    at: "14:30",
    personaId,
    run: async () => {
      await ensureActorSessions(sim.actors)
      const receipt = await recordReceipt(sim.actors.officer, { ...r, idempotencyKey: `sim-${id}`.replace(/[^A-Za-z0-9._:-]/g, "-") })
      recordPayment(sim, id, receipt.id)
    },
  })
}

export function addCredit(sim: Sim, credit: EftCredit): void {
  if (!sim.credits.some((c) => c.eventId === credit.eventId)) sim.credits.push(credit)
}

/** Statement import days across the window: Mondays (or the next business day), plus the last business day. */
function importDays(sim: Sim): Array<{ day: string; at: string }> {
  const days: Array<{ day: string; at: string }> = []
  for (let d = sim.window.start; d <= sim.window.lastBusinessDay; d = addDays(d, 1)) {
    if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) continue
    const day = nextBusinessDay(d)
    if (day <= sim.window.lastBusinessDay && !days.some((x) => x.day === day)) days.push({ day, at: "09:30" })
  }
  const last = sim.window.lastBusinessDay
  if (isBusinessDay(last)) days.push({ day: last, at: "16:00" })
  return days
}

export function scheduleStatementImports(sim: Sim): void {
  const days = importDays(sim)
  days.forEach(({ day, at }, i) => {
    const from = i === 0 ? sim.window.start : days[i - 1].day
    const final = i === days.length - 1
    schedule(sim, {
      id: `statement:${day}:${at}`,
      day,
      at,
      personaId: null,
      run: async () => {
        const credits = sim.credits.filter((c) =>
          c.day >= from && (final ? c.day <= day : c.day < day) && !sim.state.failedPersonas.includes(c.persona.id))
        await ensureActorSessions(sim.actors)
        const { csv, closingCents } = statementCsv(credits, day, sim.state.statementBalanceCents)
        const outcome = await importStatement(sim.actors.officer, credits, day, csv)
        sim.state.statementBalanceCents = closingCents
        log(`statement ${day}: ${credits.length} EFT credit(s); ${JSON.stringify(outcome)}`)
      },
    })
  })
}
