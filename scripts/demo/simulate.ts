/**
 * The demo bake: six months of a lender's book, produced by driving the real
 * HTTP API day by day under the sim stack's fake clock.
 *
 *   scripts/demo/sim/fresh-stack.sh 2026-04-01T07:30:00+02:00
 *   npx tsx scripts/demo/simulate.ts [--start 2026-04-01] [--until YYYY-MM-DD] [--resume]
 *
 * --until defaults to today (real clock), so the bake ends "now"; on that last
 * day only the slots already past in real time are played. Each background
 * persona (plus the returning client's first loan) is scheduled by
 * simulate/plan.ts so that on --until it sits in its storyline's state. Every
 * simulated day: the day's crons at their SAST slots interleaved with the
 * day's scenario events (origination steps, debit-order runs, receipts,
 * statement imports, collections actions), plus the breadth storylines —
 * CRM, insurance, compliance, referral agents, inbox (breadth/index.ts). The
 * bureau crons production leaves unscheduled run too, in TEST mode.
 *
 * Progress goes to stderr; the verification report to stdout. Exit 1 when any
 * storyline missed its target or any check failed. State is saved after every
 * event (scripts/demo/.sim-state.json); --resume continues an interrupted run.
 */
import { execFileSync } from "node:child_process"
import path from "node:path"

import { scheduleBreadth } from "./breadth"
import { closeInbox } from "./scenarios/inbox"
import { createOriginationContext } from "./scenarios/context"
import { deactivateEmailConfig, ensureServicingSetup } from "./servicing/setup"
import { readLoan } from "./servicing/loan-read"
import { checkDates, describeViolations } from "./sim/check-dates"
import { now, setClock } from "./sim/clock"
import { log } from "./sim/env"
import { closeReadDb } from "./sim/readonly-db"
import type { Sim } from "./simulate/context"
import { addDays, realToday, sastInstant } from "./simulate/dates"
import { EventQueue, playDay } from "./simulate/engine"
import { scheduleStatementImports } from "./simulate/money"
import { scheduleOrigination } from "./simulate/origination-events"
import { buildPlans } from "./simulate/plan"
import { report } from "./simulate/report"
import { planServicing, scheduleArrangementPayments } from "./simulate/servicing"
import { loadState, newState, saveState } from "./simulate/state"
import { simWindow } from "./simulate/window"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return undefined
  const value = process.argv[i + 1]
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`)
  return value
}

/** On resume: loans already paid out get their servicing events back, arrangement payments included. */
async function replanDisbursed(sim: Sim): Promise<void> {
  for (const plan of sim.plans.values()) {
    const s = sim.state.origination[plan.persona.id]
    if (!s?.loanId || sim.state.failedPersonas.includes(plan.persona.id)) continue
    await planServicing(sim, plan, s.loanId)
    const arrangement = plan.servicing?.arrangement
    if (arrangement && sim.state.done.includes(`${plan.persona.id}:arrangement`)) {
      const a = (await sim.actors.officer.get<{ agreedAmount: number; startDate: string } | null>(`/api/loans/${s.loanId}/payment-arrangement`)).json
      if (a) scheduleArrangementPayments(sim, plan, await readLoan(s.loanId), a.agreedAmount, a.startDate.slice(0, 10), arrangement.periods)
    }
  }
}

async function main(): Promise<void> {
  const started = Date.now()
  const resume = process.argv.includes("--resume")
  const saved = resume ? loadState() : null
  if (resume && !saved) throw new Error("--resume: no saved state")
  const start = saved?.start ?? arg("start") ?? "2026-04-01"
  const window = simWindow(start, saved?.until ?? arg("until") ?? realToday())
  const state = saved ?? newState(window.start, window.until)
  const firstDay = state.lastCompletedDay ? addDays(state.lastCompletedDay, 1) : window.start

  if (!saved) {
    const opening = sastInstant(window.start, "08:00")
    if (now().getTime() > opening.getTime()) {
      throw new Error(`the sim clock is at ${now().toISOString()}, past ${window.start} 08:00 SAST; start from a fresh stack (sim/fresh-stack.sh)`)
    }
    await setClock(opening)
    saveState(state)
  }
  execFileSync("bash", [path.join(__dirname, "sim", "smtp-sink.sh"), "up"], { stdio: ["ignore", "ignore", "inherit"] })

  const actors = await ensureServicingSetup(createOriginationContext())
  const plans = buildPlans(window)
  for (const p of plans) log(`plan ${p.persona.id} ${p.persona.storyline}: origination ${p.originationStart}${p.note ? ` (${p.note})` : ""}`)

  const sim: Sim = {
    actors, queue: new EventQueue(), state, window,
    plans: new Map(plans.map((p) => [p.persona.id, p])),
    portals: new Map(), debitOrders: new Map(), credits: [],
  }
  sim.queue.current = firstDay
  for (const plan of plans) scheduleOrigination(sim, plan)
  scheduleStatementImports(sim)
  scheduleBreadth(sim)
  if (saved) await replanDisbursed(sim)

  const realCutoff = () => new Date(Date.now() - 2 * 60_000)
  const simStart = new Date(`${window.start}T00:00:00+02:00`)
  for (let day = firstDay; day <= window.until; day = addDays(day, 1)) {
    const t0 = Date.now()
    await playDay(day, sim.queue, state, {
      cutoff: day === window.until ? realCutoff() : new Date(8.64e15),
      includeUnscheduledInProd: true,
    })
    log(`== ${day} done in ${((Date.now() - t0) / 1000).toFixed(1)}s (${sim.queue.remaining()} events queued, ${state.failures.length} failure(s))`)
    if (addDays(day, 1).slice(8) === "01" || day === window.until) {
      const leaks = await checkDates(simStart, now())
      if (leaks.length > 0) {
        log(`date check at ${day}: timestamps outside the simulated past:\n${describeViolations(leaks)}`)
        state.failures.push({ eventId: `check-dates:${day}`, personaId: null, day, error: describeViolations(leaks) })
        saveState(state)
      }
    }
  }

  await deactivateEmailConfig(actors)
  const passed = await report(state, window)
  const minutes = ((Date.now() - started) / 60_000).toFixed(1)
  process.stdout.write(`\n## Runtime: ${minutes} min this invocation (bake began ${state.startedAt})\n`)
  if (!passed) process.exitCode = 1
}

main()
  .catch((err: unknown) => {
    log(err instanceof Error ? err.stack ?? err.message : String(err))
    process.exitCode = 1
  })
  .finally(async () => {
    await closeInbox()
    await closeReadDb()
  })
