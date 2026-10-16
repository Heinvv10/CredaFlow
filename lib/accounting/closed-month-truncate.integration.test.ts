/**
 * A closed month is final, also against TRUNCATE: the row guards of 20261015090000 never see it, so the
 * migration 20261015500000 adds statement triggers. Each TRUNCATE below runs in a transaction that is rolled
 * back, so a missing guard would still leave the table as it was.
 *
 *   RUN_ACCOUNTING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/accounting/closed-month-truncate.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, describe, expect, it } from "vitest"

const suite = process.env.RUN_ACCOUNTING_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

class RolledBack extends Error {}

async function truncateRolledBack(table: string): Promise<unknown> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`)
    throw new RolledBack("the TRUNCATE succeeded")
  }).then(() => null, (error: unknown) => error)
}

suite.sequential("closed-month tables refuse TRUNCATE (real Postgres)", () => {
  afterAll(async () => { await db.$disconnect() })

  it.each(["AccountingExportBatch", "AccountingLedgerEntry", "AccountingJournalLine", "AccountingOpeningPosition"])("%s", async (table) => {
    const error = await truncateRolledBack(table)
    expect(error, "expected the database to refuse").not.toBeInstanceOf(RolledBack)
    expect(String((error as Error).message)).toMatch(new RegExp(`${table} is part of the closed months and is never truncated`))
  })
})
