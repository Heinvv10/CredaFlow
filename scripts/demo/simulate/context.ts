/**
 * Shared simulator context: actors, the event queue, saved state, the window,
 * and the two books that batch money movements across personas — the day's
 * debit-order run and the lender's weekly bank statement.
 */
import type { Persona } from "../personas"
import type { OriginationContext } from "../scenarios/context"
import type { PersonaPlan, Window } from "./plan"
import type { Actors } from "../servicing/setup"
import type { EftCredit } from "../servicing/bank-statement"
import { PortalSession } from "../scenarios/origination"
import { log } from "../sim/env"
import { saveState, type SimState } from "./state"
import type { EventQueue, SimEvent } from "./engine"

export interface DebitOrderLine {
  /** Event id of the instalment this collection pays; keys the booked payment id. */
  key: string
  personaId: string
  loanId: string
  loanRef: string
  amountCents: number
}

export interface Sim {
  actors: Actors
  queue: EventQueue
  state: SimState
  window: Window
  plans: Map<string, PersonaPlan>
  portals: Map<string, PortalSession>
  debitOrders: Map<string, DebitOrderLine[]>
  credits: EftCredit[]
  /** Who runs a persona's origination; unset = `actors` (breadth/index.ts gives some to a second officer). */
  originationActors?: (p: Persona) => OriginationContext
}

/** Schedules an event; one dated before the current day can only be a resume gap and is reported. */
export function schedule(sim: Sim, e: SimEvent): void {
  if (sim.queue.has(e.id)) return
  if (sim.queue.current && e.day < sim.queue.current) {
    if (!sim.state.done.includes(e.id)) log(`resume gap: ${e.id} (${e.day}) was not played and cannot be now`)
    return
  }
  sim.queue.add(e)
}

export function portalFor(sim: Sim, plan: PersonaPlan): PortalSession {
  let portal = sim.portals.get(plan.persona.id)
  if (!portal) {
    portal = new PortalSession(plan.persona, sim.actors.creds.portalPassword)
    sim.portals.set(plan.persona.id, portal)
  }
  return portal
}

export function recordPayment(sim: Sim, key: string, paymentId: string): void {
  sim.state.payments[key] = paymentId
  saveState(sim.state)
}
