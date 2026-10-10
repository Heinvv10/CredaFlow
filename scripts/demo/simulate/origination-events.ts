/**
 * A persona's origination as scheduled events (scenarios/origination.ts's
 * timetable, dated from the plan's start), followed by what the storyline
 * does next: a payout plans the loan's servicing; a withdrawn application is
 * cancelled by the officer when the applicant calls (DELETE
 * /api/applications/[id], ApplicationCancelButton).
 */
import { originationActions, newOriginationState } from "../scenarios/origination"
import { Timeline } from "../scenarios/timeline"
import { ensureActorSessions } from "../servicing/setup"
import { log } from "../sim/env"
import { portalFor, schedule, type Sim } from "./context"
import { shiftBusinessDays } from "./dates"
import type { PersonaPlan } from "./plan"
import { planServicing } from "./servicing"

export function scheduleOrigination(sim: Sim, plan: PersonaPlan): void {
  const p = plan.persona
  const t = new Timeline(plan.originationStart)
  const actions = originationActions(p, { start: plan.originationStart, stopAfter: plan.stopAfter, draft: plan.draft })

  actions.forEach((a, i) => {
    schedule(sim, {
      id: `${p.id}:origination-${String(i).padStart(2, "0")}-${a.step}`,
      day: t.date(a.day),
      at: a.at,
      personaId: p.id,
      run: async () => {
        const s = sim.state.origination[p.id] ?? newOriginationState(p.id)
        sim.state.origination[p.id] = s
        await a.run(sim.originationActors?.(p) ?? sim.actors, p, s, portalFor(sim, plan))
        if (a.step === "disbursement" && a.endsStep && s.loanId) {
          log(`${p.id}: loan ${s.loanRef} disbursed; planning servicing`)
          await planServicing(sim, plan, s.loanId)
        }
      },
    })
  })

  if (plan.withdrawAfter !== undefined) {
    const lastDay = actions[actions.length - 1].day
    schedule(sim, {
      id: `${p.id}:withdrawn`,
      day: shiftBusinessDays(t.date(lastDay), plan.withdrawAfter),
      at: "11:15",
      personaId: p.id,
      run: async () => {
        const appId = sim.state.origination[p.id]?.applicationId
        if (!appId) throw new Error(`${p.id}: no application to cancel`)
        await ensureActorSessions(sim.actors)
        const res = await sim.actors.officer.request<{ status?: string }>("DELETE", `/api/applications/${appId}`, undefined, { expect: [200] })
        if (res.json?.status !== "CANCELLED") throw new Error(`cancel returned ${res.text.slice(0, 200)}`)
        log(`${p.id}: application cancelled at the applicant's request`)
      },
    })
  }
}
