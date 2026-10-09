/**
 * Real-Postgres test of the quotation calendar: the TypeScript caller and the
 * database function it names must agree, and the database's calendar must
 * carry the proclaimed public holiday the baseline migration seeds.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/compliance/sa-business-calendar.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, describe, expect, it } from "vitest"
import { quotationValidUntilDateFromDatabase } from "./sa-business-calendar.server"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip

suite("quotationValidUntilDateFromDatabase against the migrated database", () => {
  const db = new PrismaClient()
  afterAll(async () => { await db.$disconnect() })

  it("counts five business days, skipping the proclaimed 2024 election day", async () => {
    // Wed 22 May 2024 + 5 business days: 23, 24, 27, 28, (29 May proclaimed
    // holiday), 30. Without the holiday row the answer would be the 29th.
    await expect(
      quotationValidUntilDateFromDatabase(db, new Date("2024-05-22T08:00:00.000Z")),
    ).resolves.toBe("2024-05-30")
  })

  it("skips a weekend and a base public holiday (Freedom Day, 27 April 2026)", async () => {
    // Thu 23 Apr 2026 + 2 business days: 24, (25-26 weekend, 27 Freedom Day), 28.
    await expect(
      quotationValidUntilDateFromDatabase(db, new Date("2026-04-23T08:00:00.000Z"), 2),
    ).resolves.toBe("2026-04-28")
  })
})
