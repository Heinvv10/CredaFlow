/**
 * The sentence a database guard refused a write with, or null.
 *
 * A BEFORE trigger's `RAISE EXCEPTION` (SQLSTATE 23514 here by convention, or
 * P0001 when a RAISE names no code) reaches a route as whichever Prisma error
 * class wrapped the statement. Answered as a bare 500 it looks like an outage
 * and the UI has nothing to show; the guard's own sentence says what was
 * refused.
 *
 * Only the SQLSTATE in its own field counts — the driver's `code: "23514"`
 * or a raw query's `meta.code` — never a number that happens to appear in a
 * message. A plain CHECK constraint violation names its table and constraint,
 * which are not for the client: it gets a generic sentence. Any other error
 * returns null and stays a 500.
 */
const GUARD_SQLSTATES = new Set(["23514", "P0001"])
// Prisma's ConnectorError prints the driver error as `code: "…", message: "…"`.
const CONNECTOR_ERROR = /PostgresError \{ code: "([0-9A-Z]{5})", message: "((?:[^"\\]|\\.)*)"/
const CHECK_CONSTRAINT = /violates check constraint/i

export const GENERIC_GUARD_REFUSAL = "The change breaks one of the lender's data rules and was not saved."

type Found = { code: string; message: string | null }

function sqlStateOf(error: unknown): Found | null {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const connector = CONNECTOR_ERROR.exec(current.message)
    if (connector) return { code: connector[1], message: connector[2].replace(/\\(.)/g, "$1") }
    const meta = (current as { meta?: { code?: unknown; message?: unknown } }).meta
    if (typeof meta?.code === "string") {
      return { code: meta.code, message: typeof meta.message === "string" ? meta.message.replace(/^ERROR:\s*/, "") : null }
    }
    current = (current as { cause?: unknown }).cause
  }
  return null
}

export function databaseGuardRefusal(error: unknown): string | null {
  const found = sqlStateOf(error)
  if (!found || !GUARD_SQLSTATES.has(found.code)) return null
  if (!found.message || CHECK_CONSTRAINT.test(found.message)) return GENERIC_GUARD_REFUSAL
  return found.message
}
