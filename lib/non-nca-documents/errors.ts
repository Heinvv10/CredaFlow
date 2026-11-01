import { Prisma } from "@prisma/client"

/** The application or a document changed between the read and the write: the caller is told to start again (409). */
export class ConcurrentChangeError extends Error {}

/** A refusal raised by the database (a trigger, CHECK or constraint): the only database errors answered as a conflict. */
export function isDatabaseRefusal(error: unknown): error is Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientUnknownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError || error instanceof Prisma.PrismaClientUnknownRequestError
}

/**
 * A SERIALIZABLE transaction lost to another that moved the same evidence: not a refusal, a change under its feet. The snapshot is fixed
 * by the transaction's first statement, the advisory lock it may wait on, so a change committed during that wait ends here.
 */
export function isSerializationFailure(error: unknown): boolean {
  if (!isDatabaseRefusal(error)) return false
  return ("code" in error && error.code === "P2034") || /40001|could not serialize/.test(error.message)
}

/** The sentence the database raised, without Prisma's query noise. */
export function databaseMessage(error: Error): string {
  const m = /message: "([^"]+)"/.exec(error.message) ?? /Message: `ERROR: ([^`]+)`/.exec(error.message)
  return m ? m[1] : error.message.split("\n").at(-1) ?? "The database refused the change"
}
