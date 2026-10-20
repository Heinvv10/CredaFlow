import { Prisma } from "@prisma/client"
import { sqlStateOf } from "@/lib/db-guard-refusal"

/**
 * Prisma error codes that mean the DATABASE (or the way to it) is at fault, not the
 * row being worked on: unreachable (P1001), timed out (P1002, P1008), connection
 * closed (P1017), pool exhausted (P2024), a transaction closed under the caller
 * (P2028), a write conflict or deadlock (P2034, "please retry your transaction"),
 * too many connections (P2037). P2037 is defined in the installed client (5.22);
 * the others are documented Prisma error codes.
 */
const INFRASTRUCTURE_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024", "P2028", "P2034", "P2037"])

/** A statement Postgres refused for this row's data: an integrity violation (class 23) or a trigger's RAISE. */
function isRowRefusal(sqlState: string | undefined): boolean {
  return sqlState !== undefined && (sqlState.startsWith("23") || sqlState === "P0001")
}

/**
 * True for a fault that is the database's: a restart or a network drop mid-run.
 * The nightly crons isolate one loan's failure from the rest of the tenant, but a
 * fault like this is not one loan's; they rethrow it so the tenant fails and the
 * run is retried (instead of N per-loan errors on a run that is then closed DONE).
 */
export function isDatabaseInfrastructureError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true
  if (error instanceof Prisma.PrismaClientRustPanicError) return true
  // The engine reports a connection that closed under a query as an unknown request error. So it does a trigger's
  // RAISE (P0001) and a CHECK or other integrity violation (SQLSTATE class 23), which are about the row, not the database.
  if (error instanceof Prisma.PrismaClientUnknownRequestError) return !isRowRefusal(sqlStateOf(error)?.code)
  return error instanceof Prisma.PrismaClientKnownRequestError && INFRASTRUCTURE_CODES.has(error.code)
}
