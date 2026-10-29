/** Housekeeping for RateLimitHit (lib/rate-limit-store.ts): expired rows, and a ceiling on each group's row count. */

interface ExecClient {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>
}

/**
 * Most rows one group may hold. A group's rows are one per distinct key, and a key can be chosen by the caller (an
 * email address typed into a login form): without a ceiling one flood of fresh keys grows the table without bound
 * for as long as their windows last. Generous next to any real population of limited keys.
 */
export const MAX_ROWS_PER_GROUP = 200_000

/** Rows whose window has passed hold no hit that still counts: deleting them changes no decision. */
export async function purgeExpired(db: ExecClient): Promise<number> {
  return db.$executeRaw`DELETE FROM "RateLimitHit" WHERE "expiresAt" < now()`
}

/**
 * Deletes, in each group over `cap` rows, the rows that expire soonest (the least recently used keys), keeping the
 * `cap` that expire last. `onlyGroups` limits it to those groups (suites sharing a database). Returns the number deleted. A deleted live key starts a fresh window: the price of bounding a flood.
 */
export async function capRowsPerGroup(db: ExecClient, cap = MAX_ROWS_PER_GROUP, onlyGroups?: readonly string[]): Promise<number> {
  const groups = onlyGroups ?? null
  return db.$executeRaw`
    DELETE FROM "RateLimitHit" WHERE "keyHash" IN (
      SELECT "keyHash" FROM (
        SELECT "keyHash", row_number() OVER (PARTITION BY "ns" ORDER BY "expiresAt" DESC, "keyHash") AS rn FROM "RateLimitHit" WHERE (${groups}::text[] IS NULL OR "ns" = ANY(${groups}::text[]))
      ) ranked WHERE rn > ${cap}::int
    )`
}
