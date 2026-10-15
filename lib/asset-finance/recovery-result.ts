import { Prisma, type RecoveryStatus } from "@prisma/client"
import type { RecoveryActor } from "./recovery-create"
import type { SigningTx } from "./signing-prepare"

export type NotFound = { kind: "not_found" }
export type NotReady = { kind: "not_ready"; reason: string }
export type RecoveryResult = NotFound | NotReady | { kind: "done"; id: string }

/** Thrown inside a transaction to roll it back and answer `not_ready`. */
export class RecoveryRefusal extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = "RecoveryRefusal"
  }
}

/**
 * The database guard's own sentence from a 23514 (check_violation) error, or
 * null for any other error. Prisma words it two ways: an ORM write carries
 * `PostgresError { code: "23514", message: "..." }`, a raw query
 * `Code: `23514`. Message: `ERROR: ...``.
 */
export function guardSentence(error: unknown): string | null {
  const chain: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    chain.push(current.message)
    current = (current as { cause?: unknown }).cause
  }
  const text = chain.join("\n")
  const orm = /code: "23514", message: "((?:[^"\\]|\\.)*)"/.exec(text)
  if (orm) return orm[1].replace(/\\(.)/g, "$1")
  const raw = /Code: `23514`\. Message: `(?:ERROR: )?([^`]+)`/.exec(text)
  if (raw) return raw[1].trim()
  return /23514/.test(text) ? "The database refused this step" : null
}

/**
 * Runs a service step: a refusal (RecoveryRefusal, a database guard's 23514,
 * a unique-index clash) becomes `not_ready` with its sentence; anything else
 * is thrown.
 */
export async function refusable<T extends { kind: string }>(run: () => Promise<T>): Promise<T | NotReady> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof RecoveryRefusal) return { kind: "not_ready", reason: error.reason }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { kind: "not_ready", reason: "That recovery, surrender or payment is already recorded" }
    }
    const sentence = guardSentence(error)
    if (sentence) return { kind: "not_ready", reason: sentence }
    throw error
  }
}

/** A status step guarded against a concurrent change: it applies only while the recovery is still at `from`. */
export async function advance(tx: SigningTx, actor: RecoveryActor, id: string, from: RecoveryStatus, data: Prisma.RecoveryUncheckedUpdateManyInput): Promise<void> {
  const result = await tx.recovery.updateMany({ where: { id, tenantId: actor.tenantId, status: from }, data })
  if (result.count !== 1) throw new RecoveryRefusal("The recovery changed while this ran; reload and try again")
}
