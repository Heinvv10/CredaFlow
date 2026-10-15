import { isCheckViolation } from "@/lib/disbursement/guard-violation"

export type Refused = { kind: "not_ready"; reason: string }

/** Thrown inside a transaction to roll it back with a sentence for the operator. */
export class LegalRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LegalRefusal"
  }
}

function chain(error: unknown): string[] {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    parts.push(current.message)
    const meta = (current as { meta?: { message?: unknown } }).meta
    if (typeof meta?.message === "string") parts.push(meta.message)
    current = (current as { cause?: unknown }).cause
  }
  return parts
}

/** The database guard's own sentence for a refused write (SQLSTATE 23514), or null for any other error. */
export function legalGuardMessage(error: unknown): string | null {
  if (!isCheckViolation(error)) return null
  for (const part of chain(error)) {
    // The query engine's wrapper: PostgresError { code: "23514", message: "...", severity: ... }
    const engine = /PostgresError \{ code: "23514", message: "((?:[^"\\]|\\.)*)"/.exec(part)
    if (engine) return engine[1].replace(/\\(.)/g, "$1").trim()
    const plain = /(?:ERROR:\s*|Message: `)([^\n`]+)/.exec(part)
    if (plain) return plain[1].trim()
  }
  return "The database refused this change"
}

/** Prisma's unique-violation code, which a partial unique index also raises. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === "P2002"
}

/** Runs a legal-matter write; a refusal (ours or the database's) becomes `not_ready`, anything else rethrows. */
export async function refusing<T>(run: () => Promise<T>, onUnique: string): Promise<T | Refused> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof LegalRefusal) return { kind: "not_ready", reason: error.message }
    const guard = legalGuardMessage(error)
    if (guard) return { kind: "not_ready", reason: guard }
    if (isUniqueViolation(error)) return { kind: "not_ready", reason: onUnique }
    throw error
  }
}
