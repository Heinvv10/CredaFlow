import { Prisma } from "@prisma/client"

/** The application or a document changed between the read and the write: the caller is told to start again (409). */
export class ConcurrentChangeError extends Error {}

/** A refusal raised by the database (a trigger, CHECK or constraint): the only database errors answered as a conflict. */
export function isDatabaseRefusal(error: unknown): error is Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientUnknownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError || error instanceof Prisma.PrismaClientUnknownRequestError
}

/** The sentence the database raised, without Prisma's query noise. */
export function databaseMessage(error: Error): string {
  const m = /message: "([^"]+)"/.exec(error.message) ?? /Message: `ERROR: ([^`]+)`/.exec(error.message)
  return m ? m[1] : error.message.split("\n").at(-1) ?? "The database refused the change"
}
