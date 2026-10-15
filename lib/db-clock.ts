import { Prisma } from "@prisma/client"

export interface DatabaseClockTransaction {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>
}

/**
 * The database server's current time, to the millisecond.
 *
 * Use it where two records written by DIFFERENT app hosts must be ordered
 * against each other (an in-person attestation and a later face verdict): a
 * host clock that runs behind would stamp a verdict "before" an attestation
 * that in fact preceded it. Read it inside the transaction that holds the
 * client evidence lock, so the order of the stamps is the order of the locks.
 */
export async function databaseNow(tx: DatabaseClockTransaction): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`)
  const now = rows?.[0]?.now
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("The database clock could not be read")
  }
  return now
}
