/**
 * Real-Postgres proof of what restore.sh and backup.sh call an "unfinished
 * migration". `prisma migrate resolve --rolled-back` leaves finished_at NULL and sets
 * rolled_back_at, so that row must NOT count; a failed, unresolved one must.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... npx vitest run scripts/lender/migration-state.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
// The predicate and the query exactly as the scripts define them (lib-health.sh).
const shell = (name: string) => spawnSync("bash", ["-c", `. ${__dirname}/lib-health.sh; printf %s "$${name}"`], { encoding: "utf8" }).stdout
const ROLLBACK = "__test_rollback__"

class Undo extends Error {}

suite("unfinished-migration predicate (real DB)", () => {
  const run = async (rows: string) => {
    let state = ""
    await db
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`DELETE FROM _prisma_migrations WHERE migration_name LIKE '${ROLLBACK}%'`)
        await tx.$executeRawUnsafe(rows)
        // MIG_STATE_SQL's own text, narrowed to this test's rows so the real migrations do not count
        const sql = shell("MIG_STATE_SQL").replace("FROM _prisma_migrations", `FROM _prisma_migrations WHERE migration_name LIKE '${ROLLBACK}%'`)
        const r = await tx.$queryRawUnsafe<{ s: string }[]>(sql.replace(" FROM _prisma", " AS s FROM _prisma"))
        state = r[0].s
        throw new Undo()
      })
      .catch((e) => {
        if (!(e instanceof Undo)) throw e
      })
    return state
  }
  const row = (suffix: string, cols: string) =>
    `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count, finished_at, rolled_back_at) VALUES (gen_random_uuid()::text, 'x', '${ROLLBACK}${suffix}', now(), 0, ${cols})`

  it("a finished migration is not unfinished", async () => expect(await run(row("a", "now(), NULL"))).toBe("0 1"))
  it("a failed, unresolved migration IS unfinished", async () => expect(await run(row("b", "NULL, NULL"))).toBe("1 1"))
  it("a migration resolved --rolled-back (finished_at NULL, rolled_back_at set) is NOT unfinished", async () =>
    expect(await run(row("c", "NULL, now()"))).toBe("0 1"))
})
