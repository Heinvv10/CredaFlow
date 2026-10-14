import { Prisma } from "@prisma/client"

// A transaction that lost a lock race to another write on the same
// application: Postgres aborts it with 40P01 (deadlock_detected) or 40001
// (serialization_failure). Nothing was written, and the same request can
// simply be retried, so the asset-finance regime routes answer 409 "try
// again" rather than 500.
//
// Prisma reports the SQLSTATE in three shapes (observed against Postgres 16):
//   - a raw query ($queryRaw / $executeRaw): P2010, SQLSTATE in meta.code;
//   - a model query that failed to serialize: P2034;
//   - a model query that deadlocked (also in a trigger it fired):
//     PrismaClientUnknownRequestError, SQLSTATE only in the message text
//     (`PostgresError { code: "40P01", ... }`).

const CONFLICT_SQLSTATES = new Set(["40P01", "40001"])
const SQLSTATE_IN_MESSAGE = /PostgresError \{ code: "(40P01|40001)"/

/** True when `error` is a deadlock or serialization failure: retryable, nothing written. */
export function isTransactionConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2034") return true
    const sqlState = error.meta?.code
    return error.code === "P2010" && typeof sqlState === "string" && CONFLICT_SQLSTATES.has(sqlState)
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return SQLSTATE_IN_MESSAGE.test(error.message)
  }
  return false
}
