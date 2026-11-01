import { Prisma } from "@prisma/client"

/** The application or a document changed between the read and the write: the caller is told to start again (409). */
export class ConcurrentChangeError extends Error {}

type PrismaRequestError = Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientUnknownRequestError

const isPrismaRequestError = (error: unknown): error is PrismaRequestError =>
  error instanceof Prisma.PrismaClientKnownRequestError || error instanceof Prisma.PrismaClientUnknownRequestError

/** The SQLSTATE of a raw query or a trigger error: Prisma carries it in `meta` or only in the message, depending on how the statement ran. */
function sqlState(error: PrismaRequestError): string | null {
  const meta = "meta" in error ? (error.meta as { code?: unknown } | undefined)?.code : undefined
  if (typeof meta === "string") return meta
  return /Code: `([0-9A-Z]{5})`/.exec(error.message)?.[1] ?? /code: "([0-9A-Z]{5})"/.exec(error.message)?.[1] ?? null
}

/** Prisma's own codes for a constraint: unique, foreign key, required, null. */
const CONSTRAINT_CODES = new Set(["P2002", "P2003", "P2004", "P2011"])

/** A refusal raised by the database (a trigger, CHECK or constraint): the only database errors answered as a refusal. Anything else is a fault. */
export function isDatabaseRefusal(error: unknown): error is PrismaRequestError {
  if (!isPrismaRequestError(error)) return false
  if ("code" in error && CONSTRAINT_CODES.has(error.code)) return true
  const state = sqlState(error)
  return state !== null && (state.startsWith("23") || state === "P0001")
}

/**
 * The transaction lost to another that moved the same evidence, or ran out of time waiting for it: not a refusal, a change under its feet.
 * A SERIALIZABLE snapshot is fixed by the first statement, the advisory lock it may wait on, so a change committed during that wait ends
 * here (40001, or Prisma's P2034); a wait past the transaction's timeout is P2028; a deadlock or a lock timeout are 40P01 and 55P03.
 */
export function isConcurrencyLoss(error: unknown): boolean {
  if (!isPrismaRequestError(error)) return false
  if ("code" in error && (error.code === "P2034" || error.code === "P2028")) return true
  const state = sqlState(error)
  return state === "40001" || state === "40P01" || state === "55P03"
}

/** The sentence the database raised, without Prisma's query noise. */
export function databaseMessage(error: Error): string {
  const m = /message: "([^"]+)"/.exec(error.message) ?? /Message: `ERROR: ([^`]+)`/.exec(error.message)
  return m ? m[1] : error.message.split("\n").at(-1) ?? "The database refused the change"
}
