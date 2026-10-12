/**
 * The bake's progress, saved after every event so an interrupted run resumes
 * where it stopped (the clock only moves forward, so nothing is ever re-run
 * from the start). Kept in scripts/demo/.sim-state.json (untracked).
 *
 * A resumed run rebuilds the same event plan (it is deterministic), skips
 * events already done, and continues from the saved day. An event that
 * crashed half-way is retried; receipts carry idempotency keys, other actions
 * are reported if the product refuses the repeat.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

import type { OriginationState } from "../scenarios/origination"
import { SIM_CREDENTIALS_FILE } from "../sim/env"

export const STATE_FILE = path.join(path.dirname(SIM_CREDENTIALS_FILE), ".sim-state.json")

export interface Failure {
  eventId: string
  personaId: string | null
  day: string
  error: string
}

export interface SimState {
  start: string
  until: string
  /** Real time the bake began, for the runtime report. */
  startedAt: string
  /** Days fully simulated (events + crons). */
  lastCompletedDay: string | null
  done: string[]
  origination: Record<string, OriginationState>
  /** Payment ids by the event that booked them (a later reversal needs them). */
  payments: Record<string, string>
  statementBalanceCents: number
  failures: Failure[]
  /** Cron runs that answered non-2xx. */
  cronFailures: Array<{ day: string; name: string; status: number; body: string }>
  /** Personas whose storyline stopped on a failure; their later events are skipped. */
  failedPersonas: string[]
  /** Ids the breadth storylines created (lead, quote, agent …), by key (breadth/context.ts). */
  breadth: Record<string, string>
}

export function newState(start: string, until: string): SimState {
  return {
    start, until, startedAt: new Date().toISOString(), lastCompletedDay: null, done: [], origination: {},
    payments: {}, statementBalanceCents: 4_850_000_00, failures: [], cronFailures: [], failedPersonas: [], breadth: {},
  }
}

export function loadState(): SimState | null {
  if (!existsSync(STATE_FILE)) return null
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as SimState
  state.breadth ??= {}
  return state
}

export function saveState(state: SimState): void {
  const tmp = `${STATE_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 1))
  renameSync(tmp, STATE_FILE)
}
