/**
 * The sentence a database guard refused a write with, or null.
 *
 * A BEFORE trigger's `RAISE EXCEPTION` (SQLSTATE 23514 here by convention, or
 * P0001 when a RAISE names no code) reaches a route as whichever Prisma error
 * class wrapped the statement. Answered as a bare 500 it looks like an outage
 * and the UI has nothing to show; the guard's own sentence says what was
 * refused. Only a guard refusal is matched: any other error returns null and
 * stays a 500.
 */
import { messageChain } from "@/lib/disbursement/guard-violation"

const GUARD_SQLSTATE = /\b(?:23514|P0001)\b/
// Prisma's ConnectorError prints the driver error as `code: "23514", message: "…"`.
const QUOTED_MESSAGE = /code: "(?:23514|P0001)", message: "((?:[^"\\]|\\.)*)"/

export function databaseGuardRefusal(error: unknown): string | null {
  const chain = messageChain(error)
  if (!GUARD_SQLSTATE.test(chain)) return null
  const quoted = QUOTED_MESSAGE.exec(chain)
  return quoted ? quoted[1].replace(/\\(.)/g, "$1") : "The database refused this change."
}
