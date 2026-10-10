/**
 * Runs one persona through origination on the sim stack.
 *
 *   npx tsx scripts/demo/scenarios/run-origination.ts --persona live-clean-approve --start 2026-04-01 \
 *     [--stop-after <step>] [--decision approve|decline]
 *
 * Needs the sim stack up, migrated and base-seeded (scripts/demo/sim/README.md)
 * and the clock not yet past the start date (time only moves forward). Prints
 * the result as JSON on stdout; progress goes to stderr.
 */
import { getPersona } from "../personas"
import { now } from "../sim/clock"
import { log } from "../sim/env"
import { createOriginationContext } from "./context"
import type { Decision } from "./decision"
import { closeInbox } from "./inbox"
import { ORIGINATION_STEPS, runOrigination, type OriginationStep } from "./origination"
import { firstBusinessDay } from "./timeline"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return undefined
  const value = process.argv[i + 1]
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`)
  return value
}

function parseStep(value: string | undefined): OriginationStep | undefined {
  if (value === undefined) return undefined
  const step = ORIGINATION_STEPS.find((s) => s === value)
  if (!step) throw new Error(`--stop-after must be one of: ${ORIGINATION_STEPS.join(", ")}`)
  return step
}

function parseDecision(value: string | undefined): Decision | undefined {
  if (value === undefined || value === "approve" || value === "decline") return value
  throw new Error("--decision must be approve or decline")
}

async function main(): Promise<void> {
  const personaId = arg("persona")
  const start = arg("start")
  if (!personaId || !start) throw new Error("usage: run-origination.ts --persona <id> --start YYYY-MM-DD [--stop-after <step>] [--decision approve|decline]")
  const persona = getPersona(personaId)
  const day0 = firstBusinessDay(start)
  const opening = new Date(`${day0}T08:45:00+02:00`)
  if (now().getTime() > opening.getTime()) {
    throw new Error(`the sim clock is at ${now().toISOString()}, past ${day0} 08:45 SAST; time only moves forward — pick a later --start`)
  }

  const result = await runOrigination(createOriginationContext(), persona, {
    start,
    stopAfter: parseStep(arg("stop-after")),
    decision: parseDecision(arg("decision")),
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

main()
  .catch((err: unknown) => {
    log(err instanceof Error ? err.stack ?? err.message : String(err))
    process.exitCode = 1
  })
  .finally(() => closeInbox())
