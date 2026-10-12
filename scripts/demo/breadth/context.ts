/**
 * Shared wiring for the breadth storylines (CRM, insurance, compliance,
 * referral agents, bureau): the extra staff, the ids each storyline created
 * (kept in the saved state so a resumed bake finds them), and dated events.
 *
 * A breadth event belongs to a chain (`breadth:<chain>`), used as the event's
 * persona key: when one step of a chain fails, the engine drops that chain's
 * later steps — and nothing else. A loan storyline never waits on a breadth
 * chain.
 */
import { createHash } from "node:crypto"

import { ensureActorSessions } from "../servicing/setup"
import type { SimClient } from "../sim/api"
import { schedule, type Sim } from "../simulate/context"
import { nextBusinessDay, shiftBusinessDays } from "../simulate/dates"
import type { PersonaPlan } from "../simulate/plan"
import { signedIn, type BreadthStaff, type StaffKey } from "./staff"

export interface Breadth {
  sim: Sim
  /** Set by the setup event (or from the credentials file on resume). */
  staff: BreadthStaff | null
}

export function staffOf(b: Breadth): BreadthStaff {
  if (!b.staff) throw new Error("breadth staff are not set up yet (breadth/setup.ts runs first)")
  return b.staff
}

/** A signed-in client for one of the breadth staff. */
export const as = (b: Breadth, key: StaffKey): Promise<SimClient> => signedIn(staffOf(b)[key])

export function remember(b: Breadth, key: string, id: string): void {
  b.sim.state.breadth[key] = id
}

export function recall(b: Breadth, key: string): string {
  const id = b.sim.state.breadth[key]
  if (!id) throw new Error(`breadth: no ${key} recorded; the step that creates it did not run`)
  return id
}

export const recallOptional = (b: Breadth, key: string): string | null => b.sim.state.breadth[key] ?? null

/** The persona's client id, once its origination captured it. */
export function clientOf(b: Breadth, personaId: string): string {
  const id = b.sim.state.origination[personaId]?.clientId
  if (!id) throw new Error(`breadth: persona ${personaId} has no client (origination did not capture it)`)
  return id
}

export function planOf(b: Breadth, personaId: string): PersonaPlan {
  const plan = b.sim.plans.get(personaId)
  if (!plan) throw new Error(`breadth: no plan for persona ${personaId}`)
  return plan
}

/** `n` business days after the first business day of the window. */
export const fromStart = (b: Breadth, n: number): string => shiftBusinessDays(nextBusinessDay(b.sim.window.start), n)

/** `n` business days before the last fully simulated business day. */
export const beforeEnd = (b: Breadth, n: number): string => shiftBusinessDays(b.sim.window.lastBusinessDay, -n)

/** `n` business days after a persona's origination day 0 (payout is day 3). */
export const afterOrigination = (b: Breadth, personaId: string, n: number): string =>
  shiftBusinessDays(planOf(b, personaId).originationStart, n)

/**
 * Schedules one step of a chain. Steps past the window's last full business
 * day are not scheduled (the bake ends "now").
 */
export function step(b: Breadth, chain: string, name: string, day: string, at: string, run: () => Promise<void>): void {
  if (day > b.sim.window.lastBusinessDay) return
  schedule(b.sim, {
    id: `breadth:${chain}:${name}`,
    day,
    at,
    personaId: `breadth:${chain}`,
    run: async () => {
      await ensureActorSessions(b.sim.actors)
      await run()
    },
  })
}

/** A stable UUID (v5 layout) for a messaging operation id, so a retried step is idempotent. */
export function operationId(key: string): string {
  const h = createHash("sha256").update(key).digest("hex")
  const variant = ((parseInt(h[16], 16) & 3) | 8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** HH:MM, `minutes` after `hhmm`. */
export function later(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number)
  const t = h * 60 + m + minutes
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`
}
