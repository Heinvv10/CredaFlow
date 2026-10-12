/**
 * Turns a disbursed loan's repayment schedule and its persona's servicing
 * spec (plan.ts) into dated events: instalments collected by debit order,
 * paid by EFT (bank statement) or captured by hand; a bounced debit order;
 * early settlement from the certificate of balance; reminder stages, a
 * Section 129 notice, an attorney referral, a payment arrangement with its
 * payments, and a dual-control write-off. Instalments after the first missed
 * one are simply not paid — dpd-update and escalations do the rest.
 */
import { approveWriteOff, createArrangement, createPaymentPlan, issueSection129, moveStage, referToAttorney, requestWriteOff } from "../servicing/collections"
import { readLoan, type LoanView } from "../servicing/loan-read"
import { recordReceipt, reversePayment, settlementAmount } from "../servicing/payments"
import { ensureActorSessions } from "../servicing/setup"
import { log } from "../sim/env"
import { schedule, type Sim } from "./context"
import { addDays, addMonths, nextBusinessDay, shiftBusinessDays } from "./dates"
import { addCredit, addDebitOrder, addReceipt } from "./money"
import type { PersonaPlan, ServicingSpec } from "./plan"

type Act = () => Promise<void>

function staffEvent(sim: Sim, plan: PersonaPlan, name: string, day: string, at: string, run: Act): void {
  if (day > sim.window.until) return
  schedule(sim, {
    id: `${plan.persona.id}:${name}`,
    day,
    at,
    personaId: plan.persona.id,
    run: async () => {
      await ensureActorSessions(sim.actors)
      await run()
    },
  })
}

function payInstalment(sim: Sim, plan: PersonaPlan, spec: ServicingSpec, loan: LoanView, row: LoanView["rows"][number]): void {
  const pid = plan.persona.id
  const payDay = nextBusinessDay(row.dueDay)
  if (payDay > sim.window.until) return
  const key = `${pid}:instalment-${row.installmentNo}`
  if (spec.channel === "DEBIT_ORDER") {
    addDebitOrder(sim, payDay, { key, personaId: pid, loanId: loan.id, loanRef: loan.reference, amountCents: row.totalDue })
    return
  }
  if (spec.channel === "EFT_MANUAL") {
    addReceipt(sim, key, pid, payDay, { loanId: loan.id, amountCents: row.totalDue, method: "EFT", reference: loan.reference, notes: `Instalment ${row.installmentNo}` })
    return
  }
  addCredit(sim, {
    day: payDay, persona: plan.persona, loanId: loan.id, loanRef: loan.reference, amountCents: row.totalDue,
    withReference: spec.channel === "EFT_STATEMENT", eventId: key,
  })
}

function settleEvent(sim: Sim, plan: PersonaPlan, loanId: string, day: string): void {
  staffEvent(sim, plan, "settlement", day, "11:00", async () => {
    const amount = await settlementAmount(sim.actors.officer, loanId)
    await recordReceipt(sim.actors.officer, {
      loanId, amountCents: amount, method: "EFT", reference: "Settlement per certificate of balance",
      notes: "Client settled the account in full", idempotencyKey: `sim-${plan.persona.id}-settlement`,
    })
    const after = await readLoan(loanId)
    if (after.status !== "COMPLETED") throw new Error(`settlement of R${amount / 100} left ${after.reference} ${after.status}`)
    log(`${plan.persona.id}: settled ${after.reference} with R${amount / 100}`)
  })
}

/** Payments under an arrangement, once its terms are known (on creation, or read back on resume). */
export function scheduleArrangementPayments(sim: Sim, plan: PersonaPlan, loan: LoanView, agreedCents: number, startDay: string, periods: number): void {
  for (let k = 0; k < periods; k++) {
    const day = nextBusinessDay(addMonths(startDay, k))
    if (day > sim.window.until) break
    addReceipt(sim, `${plan.persona.id}:arrangement-payment-${k + 1}`, plan.persona.id, day, {
      loanId: loan.id, amountCents: agreedCents, method: "EFT", reference: loan.reference, notes: `Payment arrangement instalment ${k + 1} of ${periods}`,
    })
  }
}

/**
 * The client calls, agrees instalment-plus-a-share-of-arrears per month, and
 * pays the first one the same day: the arrangement starts on the call's date.
 * (arrangement-check judges a period MISSED from 06:00 on its due date, so an
 * arrangement whose first payment lands later that day is marked BROKEN with
 * a 0% compliance rate before the money arrives — the product's rule.)
 */
function arrangementEvent(sim: Sim, plan: PersonaPlan, loan: LoanView, a: NonNullable<ServicingSpec["arrangement"]>, day: string): void {
  staffEvent(sim, plan, "arrangement", day, "10:45", async () => {
    const current = await readLoan(loan.id)
    const next = current.rows.find((r) => r.dueDay > day)
    if (!next) throw new Error(`${current.reference}: no instalment left to arrange against`)
    const agreed = Math.ceil((next.totalDue + current.arrearsAmount / a.periods) / 1000) * 1000
    const endDay = addMonths(day, a.periods - 1)
    await createArrangement(sim.actors.officer, loan.id, {
      agreedAmountCents: agreed, startDay: day, endDay,
      notes: `Client called after missed instalments; agreed R${agreed / 100}/month (instalment plus arrears) until ${endDay}, first payment today.`,
    })
    if (a.withPlan) {
      await createPaymentPlan(sim.actors.admin, loan.id, current.arrearsAmount, a.periods, day, "Arrears spread over the arrangement period")
    }
    scheduleArrangementPayments(sim, plan, current, agreed, day, a.periods)
  })
}

export async function planServicing(sim: Sim, plan: PersonaPlan, loanId: string): Promise<void> {
  const spec = plan.servicing
  if (!spec) return
  const pid = plan.persona.id
  const loan = await readLoan(loanId)
  const paid = spec.paidRows ?? loan.rows.length
  const firstMissed = loan.rows[paid]?.dueDay ?? null

  for (const row of loan.rows) {
    if (spec.settleAtMaturity) {
      settleEvent(sim, plan, loan.id, nextBusinessDay(row.dueDay))
      break
    }
    if (spec.settle && row.installmentNo > spec.settle.afterRow) break
    if (row.installmentNo === spec.bounceRow) {
      const day = nextBusinessDay(row.dueDay)
      const key = `${pid}:instalment-${row.installmentNo}`
      addDebitOrder(sim, day, { key, personaId: pid, loanId: loan.id, loanRef: loan.reference, amountCents: row.totalDue })
      staffEvent(sim, plan, "bounce-reversal", shiftBusinessDays(day, 2), "10:00", async () => {
        const paymentId = sim.state.payments[key]
        if (!paymentId) throw new Error(`no booked debit order ${key} to reverse`)
        await reversePayment(sim.actors.loanAdmin, paymentId, "Debit order returned unpaid by the client's bank (R/D — insufficient funds)")
      })
      continue
    }
    if (row.installmentNo > paid) continue
    payInstalment(sim, plan, spec, loan, row)
  }

  if (spec.settle) {
    const anchorRow = loan.rows[spec.settle.afterRow - 1]
    settleEvent(sim, plan, loan.id, nextBusinessDay(addDays(anchorRow.dueDay, spec.settle.daysAfter)))
  }
  if (!firstMissed) return
  const at = (dpd: number) => nextBusinessDay(addDays(firstMissed, dpd))

  if (spec.reminders) {
    staffEvent(sim, plan, "stage-soft", at(7), "10:15", () =>
      moveStage(sim.actors.officer, loan.id, "SOFT_REMINDER", "Instalment missed; client reminded by phone."))
    if (!spec.arrangement || spec.arrangement.atDpd > 21) {
      staffEvent(sim, plan, "stage-formal", at(21), "10:15", () =>
        moveStage(sim.actors.officer, loan.id, "FORMAL_REMINDER", "Still unpaid after the soft reminder; formal demand letter stage."))
    }
  }
  if (spec.arrangement) arrangementEvent(sim, plan, loan, spec.arrangement, at(spec.arrangement.atDpd))
  if (spec.s129AtDpd !== undefined) {
    const s129Day = at(spec.s129AtDpd)
    staffEvent(sim, plan, "section129", s129Day, "10:30", () => issueSection129(sim.actors.officer, loan.id))
    if (spec.attorneyAfterBusinessDays !== undefined) {
      staffEvent(sim, plan, "attorney", shiftBusinessDays(s129Day, spec.attorneyAfterBusinessDays), "11:30", () =>
        referToAttorney(sim.actors.officer, loan.id, `KVM/COL/${loan.reference.slice(-6).toUpperCase()}`))
    }
  }
  if (spec.writeOffAtDpd !== undefined) {
    const requestDay = at(spec.writeOffAtDpd)
    staffEvent(sim, plan, "write-off-request", requestDay, "10:00", () =>
      requestWriteOff(sim.actors.loanAdmin, loan.id, "No payment since default; tracing and collection attempts exhausted; uneconomic to pursue further."))
    staffEvent(sim, plan, "write-off-approve", shiftBusinessDays(requestDay, 1), "09:30", () =>
      approveWriteOff(sim.actors.admin, loan.id))
  }
}
