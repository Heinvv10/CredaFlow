/**
 * The payout guards are enforced twice: once as preflight preconditions in
 * TypeScript, and again as BEFORE-trigger `RAISE EXCEPTION ... ERRCODE 23514`
 * on the `DISBURSED` status write. The second layer is deliberate defence in
 * depth, but it surfaces as a raw database error rather than a typed one, so
 * the disburse route answered it with a bare 500 and no cause. An operator
 * could not tell a refused payout from an outage.
 *
 * Prisma wraps a trigger-raised error in different classes depending on how
 * the statement was issued (known-request, unknown-request, or a raw-query
 * failure carrying the SQLSTATE in `meta`). Rather than guess the wrapper,
 * this matches the guards' own message text, which is emitted nowhere else in
 * the schema — so it cannot mislabel an unrelated failure as a payout refusal.
 */

/** Every payout guard RAISE begins with this. See the payout guards in the baseline migration. */
const GUARD_MESSAGE_PREFIX = "Loan disbursement requires"

/** SQLSTATE check_violation — carried in `meta.code` on raw-query failures. */
const CHECK_VIOLATION = "23514"

function messageChain(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  // Prisma nests the driver error under `cause` on some wrapper classes.
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    parts.push(current.message)
    // The SQLSTATE appears as `meta.code` on raw-query failures and as a
    // top-level `code` on the driver error itself; collect both.
    const holder = current as {
      code?: unknown
      meta?: { code?: unknown; message?: unknown }
    }
    if (typeof holder.code === "string") parts.push(holder.code)
    if (holder.meta) {
      if (typeof holder.meta.code === "string") parts.push(holder.meta.code)
      if (typeof holder.meta.message === "string") parts.push(holder.meta.message)
    }
    current = (current as { cause?: unknown }).cause
  }
  return parts.join("\n")
}

/**
 * Returns the database guard's own sentence when `error` is a refused payout,
 * or null when it is anything else. The sentence is returned verbatim so the
 * operator is told which evidence is missing rather than a generic summary.
 */
export function disbursementGuardViolation(error: unknown): string | null {
  const chain = messageChain(error)
  if (!chain.includes(GUARD_MESSAGE_PREFIX)) return null

  const start = chain.indexOf(GUARD_MESSAGE_PREFIX)
  // The RAISE text runs to the end of its line; trailing quoting varies by
  // wrapper class, so trim the punctuation Postgres and Prisma add around it.
  // Prisma delimits the driver message with backticks (Message: `...`).
  const line = chain.slice(start).split("\n")[0]
  return line.replace(/[`"')\\]+\s*$/, "").trim()
}

/** True when the error carries SQLSTATE 23514 anywhere Prisma exposed it. */
export function isCheckViolation(error: unknown): boolean {
  return messageChain(error).includes(CHECK_VIOLATION)
}
