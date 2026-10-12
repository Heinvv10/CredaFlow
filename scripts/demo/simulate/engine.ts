/**
 * The day loop's machinery: a queue of dated scenario events and a runner that
 * plays one simulated day — every due cron at its SAST slot and every event at
 * its time, in time order (crons first on a tie), moving the shared clock
 * forward only.
 *
 * Events may schedule further events (a payout schedules the loan's
 * servicing). An event that throws is recorded as a failure, its persona's
 * later events are dropped, and the day carries on: one broken storyline
 * should not hide what the other forty do.
 */
import { now, setClock } from "../sim/clock"
import { dueCronJobs, runCronJob, type CronJob } from "../sim/cron"
import { log } from "../sim/env"
import { sastInstant } from "./dates"
import { saveState, type SimState } from "./state"

export interface SimEvent {
  /** Stable across runs: the resume key and the idempotency-key seed. */
  id: string
  day: string
  /** SAST HH:MM. */
  at: string
  personaId: string | null
  run: () => Promise<void>
}

/**
 * Real time allowed after a scenario action before the clock jumps, so work a
 * route left running after it answered (notifications, audit tails) is
 * stamped at the action's time rather than at the next slot.
 */
const SETTLE_MS = 600

export class EventQueue {
  private readonly byDay = new Map<string, SimEvent[]>()
  private readonly ids = new Set<string>()
  current: string | null = null

  add(e: SimEvent): void {
    if (this.ids.has(e.id)) throw new Error(`event ${e.id} scheduled twice`)
    if (this.current && e.day < this.current) throw new Error(`event ${e.id} scheduled for ${e.day}, before the current day ${this.current}`)
    this.ids.add(e.id)
    const list = this.byDay.get(e.day) ?? []
    list.push(e)
    this.byDay.set(e.day, list)
  }

  has(id: string): boolean {
    return this.ids.has(id)
  }

  /** Removes and returns the earliest event of `day` (insertion order on a tie). */
  next(day: string): SimEvent | null {
    const list = this.byDay.get(day)
    if (!list || list.length === 0) return null
    let best = 0
    for (let i = 1; i < list.length; i++) if (list[i].at < list[best].at) best = i
    return list.splice(best, 1)[0]
  }

  peekAt(day: string): string | null {
    const list = this.byDay.get(day) ?? []
    return list.reduce<string | null>((min, e) => (min === null || e.at < min ? e.at : min), null)
  }

  remaining(): number {
    let n = 0
    for (const list of this.byDay.values()) n += list.length
    return n
  }
}

export interface DayOptions {
  /** Slots after this instant are not played (the last day stops at real "now"). */
  cutoff: Date
  /** Also play the crons production leaves unscheduled (the bureau files, sim/cron.ts). */
  includeUnscheduledInProd?: boolean
}

async function moveTo(slot: Date, dirty: boolean): Promise<void> {
  if (now().getTime() >= slot.getTime()) return
  if (dirty) await new Promise((r) => setTimeout(r, SETTLE_MS))
  await setClock(slot)
}

export async function playDay(day: string, queue: EventQueue, state: SimState, opts: DayOptions): Promise<void> {
  queue.current = day
  const crons: CronJob[] = dueCronJobs(day, { includeUnscheduledInProd: opts.includeUnscheduledInProd })
  let dirty = false

  for (;;) {
    const eventAt = queue.peekAt(day)
    const cron = crons[0]
    if (!cron && eventAt === null) break
    const useCron = cron !== undefined && (eventAt === null || cron.at <= eventAt)
    const slot = sastInstant(day, useCron ? cron.at : (eventAt as string))
    if (slot.getTime() > opts.cutoff.getTime()) {
      log(`${day}: stopping at the cutoff ${opts.cutoff.toISOString()}; ${queue.remaining()} event(s) left unplayed`)
      break
    }

    if (useCron) {
      crons.shift()
      if (now().getTime() > slot.getTime() + 60_000) {
        log(`cron ${cron.name} ${day} ${cron.at} skipped: the clock is already past its slot (first day or resume)`)
        continue
      }
      await moveTo(slot, dirty)
      dirty = false
      const run = await runCronJob(cron)
      if (run.status < 200 || run.status >= 300) {
        state.cronFailures.push({ day, name: cron.name, status: run.status, body: JSON.stringify(run.body).slice(0, 500) })
      }
      continue
    }

    const event = queue.next(day)
    if (!event) continue
    if (state.done.includes(event.id)) continue
    if (event.personaId && state.failedPersonas.includes(event.personaId)) {
      log(`${event.id}: skipped (persona ${event.personaId} failed earlier)`)
      continue
    }
    await moveTo(slot, dirty)
    try {
      await event.run()
      state.done.push(event.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`FAILED ${event.id}: ${message}`)
      state.failures.push({ eventId: event.id, personaId: event.personaId, day, error: message.slice(0, 2000) })
      if (event.personaId) state.failedPersonas.push(event.personaId)
    }
    dirty = true
    saveState(state)
  }

  state.lastCompletedDay = day
  saveState(state)
}
