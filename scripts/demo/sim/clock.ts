/**
 * The simulator's fake clock.
 *
 * The clock file holds a libfaketime RELATIVE offset in whole seconds
 * ("-16557329" / "+42"): every faked process computes real-now + offset. An
 * absolute "@YYYY-MM-DD HH:MM:SS" start time was rejected because libfaketime
 * re-bases it per process at the moment that process first notices the
 * change, so an idle Postgres backend would lag the app by however long it
 * sat idle. With an offset, the app, every DB backend and this script agree.
 *
 * CLI:
 *   npx tsx scripts/demo/sim/clock.ts set 2026-04-01T09:00:00Z [--no-wait]
 *   npx tsx scripts/demo/sim/clock.ts advance 30
 *   npx tsx scripts/demo/sim/clock.ts now
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

import { SIM_CLOCK_DIR, log, simBaseUrl } from "./env"

export const CLOCK_FILE = path.join(SIM_CLOCK_DIR, "faketime.rc")

const DAY_MS = 24 * 60 * 60 * 1000
/** How far the app's clock may sit from ours and still count as "applied". */
const APPLIED_TOLERANCE_MS = 5_000
const WAIT_TIMEOUT_MS = 30_000

function readOffsetSeconds(): number {
  const raw = readFileSync(CLOCK_FILE, "utf8").trim()
  if (!/^[+-]\d+$/.test(raw)) {
    throw new Error(`${CLOCK_FILE} holds "${raw}", not a +/-seconds offset; rewrite it with setClock()`)
  }
  return Number(raw)
}

function writeOffsetSeconds(offset: number): void {
  mkdirSync(SIM_CLOCK_DIR, { recursive: true, mode: 0o755 })
  const tmp = `${CLOCK_FILE}.tmp`
  // Readable by the containers' non-root users; renamed into place so a
  // reader never sees a half-written file.
  writeFileSync(tmp, `${offset >= 0 ? "+" : "-"}${Math.abs(offset)}\n`, { mode: 0o644 })
  chmodSync(tmp, 0o644)
  renameSync(tmp, CLOCK_FILE)
}

/** The simulated current time, as every faked process sees it. */
export function now(): Date {
  return new Date(Date.now() + readOffsetSeconds() * 1000)
}

/** Reads the app's own clock from /api/health. */
export async function appNow(baseUrl = simBaseUrl()): Promise<Date> {
  const res = await fetch(`${baseUrl}/api/health`, { cache: "no-store" })
  const body = (await res.json()) as { status?: string; checkedAt?: string }
  if (res.status !== 200 || body.status !== "ok" || !body.checkedAt) {
    throw new Error(`/api/health returned ${res.status} ${JSON.stringify(body)}`)
  }
  return new Date(body.checkedAt)
}

/** Polls /api/health until the app's checkedAt agrees with now(). */
export async function waitForApp(baseUrl = simBaseUrl()): Promise<Date> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  let last = "no response"
  while (Date.now() < deadline) {
    try {
      const seen = await appNow(baseUrl)
      const drift = Math.abs(seen.getTime() - now().getTime())
      if (drift <= APPLIED_TOLERANCE_MS) return seen
      last = `app reports ${seen.toISOString()}, expected ~${now().toISOString()}`
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`app at ${baseUrl} did not pick up the clock within ${WAIT_TIMEOUT_MS} ms: ${last}`)
}

export interface SetClockOptions {
  /** Skip the /api/health confirmation (e.g. before the stack is up). */
  wait?: boolean
}

/**
 * Moves the simulated clock to `date`. The offset is whole seconds, rounded
 * up, so the clock lands within a second AFTER `date` and never before it (a
 * job slotted at 00:00 must not run on the previous day).
 */
export async function setClock(date: Date, opts: SetClockOptions = {}): Promise<Date> {
  if (Number.isNaN(date.getTime())) throw new Error("setClock: invalid date")
  writeOffsetSeconds(Math.ceil((date.getTime() - Date.now()) / 1000))
  if (opts.wait === false) return now()
  return waitForApp()
}

/** Moves the clock forward `days` from the current simulated time. */
export async function advanceDays(days: number, opts: SetClockOptions = {}): Promise<Date> {
  return setClock(new Date(now().getTime() + days * DAY_MS), opts)
}

async function cli(argv: string[]): Promise<void> {
  const [cmd, arg, ...flags] = argv
  const wait = !flags.includes("--no-wait")
  if (cmd === "set" && arg) {
    const at = await setClock(new Date(arg), { wait })
    log(`clock set: ${at.toISOString()}${wait ? " (app confirmed)" : ""}`)
  } else if (cmd === "advance" && arg) {
    const at = await advanceDays(Number(arg), { wait })
    log(`clock advanced: ${at.toISOString()}`)
  } else if (cmd === "now") {
    process.stdout.write(`${now().toISOString()}\n`)
  } else {
    throw new Error("usage: clock.ts set <ISO date> [--no-wait] | advance <days> [--no-wait] | now")
  }
}

if (require.main === module) {
  cli(process.argv.slice(2)).catch((err: unknown) => {
    log(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}

const TOTP_STEP_MS = 30_000

/** Milliseconds from `nowMs` until the next 30 s TOTP step begins, plus a margin. */
export function msToNextTotpStep(nowMs: number): number {
  return TOTP_STEP_MS - (nowMs % TOTP_STEP_MS) + 500
}

/**
 * Enrolling TOTP spends the code that proved the secret (lastTotpCounter), so
 * signing in with the same step's code is refused as a replay: wait for the
 * next step before the first sign-in with a code.
 */
export async function waitForNextTotpStep(baseUrl = simBaseUrl()): Promise<void> {
  const wait = msToNextTotpStep((await appNow(baseUrl)).getTime())
  await new Promise((resolve) => setTimeout(resolve, wait))
}
