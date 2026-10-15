/**
 * Two-connection helpers for the recovery concurrency suite
 * (RUN_ASSET_FINANCE_RECOVERY_IT): `race` runs one transaction on a connection
 * and holds it open while a second transaction, on another connection, tries
 * its write; it reports whether the second had to WAIT for the first (the lock
 * under test) and how each ended. `without` redefines a trigger function with
 * one clause taken out (or disables a trigger) for the duration of a callback,
 * and puts the original back, to show the lock is what serialises them. Not a
 * test file.
 */
import type { PrismaClient } from "@prisma/client"

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]
export interface Ended { status: "committed" | "refused"; message: string }
export interface Raced { first: Ended; second: Ended; secondWaited: boolean }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const ended = (error: unknown): Ended => ({
  status: "refused",
  message: error instanceof Error ? (/message: "((?:[^"\\]|\\.)*)"/.exec(error.message)?.[1] ?? /Message: `(?:ERROR: )?([^`]+)`/.exec(error.message)?.[1] ?? error.message) : String(error),
})

/** `first` runs and stays uncommitted; `second` starts on its own connection; after `settleMs` the first commits. */
export async function race(a: PrismaClient, b: PrismaClient, first: (tx: Tx) => Promise<unknown>, second: (tx: Tx) => Promise<unknown>, settleMs = 700): Promise<Raced> {
  let release!: () => void
  const hold = new Promise<void>((resolve) => { release = resolve })
  let ready!: () => void
  const firstRan = new Promise<void>((resolve) => { ready = resolve })
  const firstEnd = a.$transaction(async (tx) => { await first(tx); ready(); await hold }, { timeout: 30_000, maxWait: 10_000 })
    .then((): Ended => ({ status: "committed", message: "" }), (error: unknown): Ended => { ready(); return ended(error) })
  await firstRan
  let secondDone = false
  const secondEnd = b.$transaction(async (tx) => { await second(tx) }, { timeout: 30_000, maxWait: 10_000 })
    .then((): Ended => ({ status: "committed", message: "" }), ended)
    .finally(() => { secondDone = true })
  await sleep(settleMs)
  const secondWaited = !secondDone
  release()
  return { first: await firstEnd, second: await secondEnd, secondWaited }
}

/** Runs `body` with one clause of a trigger function replaced (`replace`), or a trigger disabled, then restores it. */
export async function without<T>(db: PrismaClient, rule: { fn: string; replace: readonly [string, string] } | { table: string; trigger: string }, body: () => Promise<T>): Promise<T> {
  if ("trigger" in rule) {
    await db.$executeRawUnsafe(`ALTER TABLE "${rule.table}" DISABLE TRIGGER "${rule.trigger}"`)
    try { return await body() } finally { await db.$executeRawUnsafe(`ALTER TABLE "${rule.table}" ENABLE TRIGGER "${rule.trigger}"`) }
  }
  const [row] = await db.$queryRawUnsafe<{ def: string }[]>(`SELECT pg_get_functiondef('public."${rule.fn}"'::regproc) AS def`)
  const [clause, replacement] = rule.replace
  const found = row.def.split(clause).length - 1
  if (found !== 1) throw new Error(`${rule.fn}: the clause must occur exactly once, found ${found}: ${clause}`)
  await db.$executeRawUnsafe(row.def.replace(clause, () => replacement))
  try { return await body() } finally { await db.$executeRawUnsafe(row.def) }
}
