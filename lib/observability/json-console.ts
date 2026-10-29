import { formatLogLine, type LogLevel } from "./logger"

const METHODS = {
  log: "info",
  info: "info",
  debug: "debug",
  warn: "warn",
  error: "error",
} as const satisfies Record<string, LogLevel>

type ConsoleMethod = keyof typeof METHODS

const ORIGINALS_KEY = Symbol.for("credaflow.console.originals")
type Originals = Record<ConsoleMethod, (...args: unknown[]) => void>
const holder = globalThis as { [ORIGINALS_KEY]?: Originals }

/**
 * With `LOG_FORMAT=json`, routes every console call (the codebase's logging
 * convention, ~200 files) through the structured logger, so a cluster's log
 * collector gets one JSON object per line with the trace id of the request.
 * Unset, console is untouched. Returns whether it installed.
 */
export function installJsonConsole(env: Partial<Record<string, string>>): boolean {
  if (env.LOG_FORMAT?.trim().toLowerCase() !== "json") return false
  if (holder[ORIGINALS_KEY]) return true
  holder[ORIGINALS_KEY] = Object.fromEntries(
    (Object.keys(METHODS) as ConsoleMethod[]).map((method) => [method, console[method].bind(console)]),
  ) as Originals
  for (const method of Object.keys(METHODS) as ConsoleMethod[]) {
    const level = METHODS[method]
    console[method] = (...args: unknown[]) => {
      const stream = level === "warn" || level === "error" ? process.stderr : process.stdout
      stream.write(formatLogLine(level, args, { service: env.OTEL_SERVICE_NAME }))
    }
  }
  return true
}

/** Puts the original console methods back (tests). */
export function restoreConsole(): void {
  const originals = holder[ORIGINALS_KEY]
  if (!originals) return
  for (const method of Object.keys(originals) as ConsoleMethod[]) console[method] = originals[method]
  delete holder[ORIGINALS_KEY]
}
