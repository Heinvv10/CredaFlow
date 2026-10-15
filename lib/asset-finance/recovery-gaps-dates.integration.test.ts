/**
 * Slice 4a recovery date rules the first review found untested: the SQL
 * business-day count ("recoveryAddBusinessDays") pinned to dates worked by
 * hand and held to the application's calendar over a range, and the South
 * African day the database reads a UTC timestamp as (a section 129 notice
 * completed at 22:30 UTC is 00:30 the next day in SAST).
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-gaps-dates.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"
import { dbDate, fromDayNumber, toDayNumber } from "./dates"
import { ladderRecovery, proceedsKey } from "./recovery-path.integration-fixture"
import {
  cleanupRecoveryFixture, createRecoveryFixture, day, newLoan, newMatter, recoveryFixtureTenantId, today, type RecoveryFixture,
} from "./recovery.integration-fixture"
import { clauseOff, rules, triggersOff, triggersOn, type Tx } from "./recovery-rules.integration-fixture"

// The deal fixture imports the real route handlers, which import the session helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}
const { refuses, admits } = rules(database)
let fx: RecoveryFixture

const sqlAdd = async (start: string, days: number): Promise<string> => {
  const [row] = await database().$queryRawUnsafe<{ d: string }[]>(`SELECT public."recoveryAddBusinessDays"($1::date, $2::int)::text AS d`, start, days)
  return row.d
}

suite("slice 4a recovery date rules: business days and the SAST day", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
  }, 300_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$disconnect()
  }, 120_000)

  describe("recoveryAddBusinessDays", () => {
    // Worked by hand. 2026: 14 Dec is a Monday; 16 Dec (Wed, Day of Reconciliation), 25 Dec (Fri) and 26 Dec (Sat) are public holidays;
    // 9 Aug is a Sunday, so Monday 10 Aug is a holiday too.
    it("14 Dec 2026 plus 10 business days is 30 Dec: 15, 17, 18, 21, 22, 23, 24, 28, 29, 30 (16 Dec and 25/26 Dec skipped)", async () => {
      expect(await sqlAdd("2026-12-14", 10)).toBe("2026-12-30")
    })

    it("a start on a Saturday counts from the Monday: 12 Dec plus 1 is 14 Dec, plus 3 is 17 Dec (16 Dec skipped)", async () => {
      expect(await sqlAdd("2026-12-12", 1)).toBe("2026-12-14")
      expect(await sqlAdd("2026-12-12", 3)).toBe("2026-12-17")
    })

    it("a start on a public holiday counts from the next business day: 16 Dec plus 1 is 17 Dec, plus 2 is 18 Dec", async () => {
      expect(await sqlAdd("2026-12-16", 1)).toBe("2026-12-17")
      expect(await sqlAdd("2026-12-16", 2)).toBe("2026-12-18")
    })

    it("a holiday on a Sunday moves to the Monday: 9 Aug 2026 plus 1 is Tuesday 11 Aug", async () => {
      expect(await sqlAdd("2026-08-09", 1)).toBe("2026-08-11")
    })

    it("a count of 0 is the start itself", async () => {
      expect(await sqlAdd("2026-12-12", 0)).toBe("2026-12-12")
    })

    it("agrees with the application's calendar for every start from 1 Nov 2026 to 31 Jan 2027 and every count from 1 to 12", async () => {
      const rows = await database().$queryRawUnsafe<{ start: string; n: number; sql: string }[]>(
        `SELECT d::date::text AS start, n, public."recoveryAddBusinessDays"(d::date, n)::text AS sql
           FROM generate_series(DATE '2026-11-01', DATE '2027-01-31', INTERVAL '1 day') AS d, generate_series(1, 12) AS n ORDER BY d, n`)
      expect(rows).toHaveLength(92 * 12)
      const differing = rows.filter((r) => r.sql !== addSouthAfricanBusinessDays(r.start, r.n)).map((r) => `${r.start}+${r.n}: sql ${r.sql}`)
      expect(differing).toEqual([])
    })
  })

  describe("the SAST day of a UTC timestamp", () => {
    const utc = (dayOffset: number, time: string) => new Date(`${fromDayNumber(toDayNumber(today()) + dayOffset)}T${time}Z`)

    it("a section 129 notice completed at 22:30 UTC is that of the next SAST day: a step dated the UTC day is refused, the SAST day admitted", async () => {
      // completed 22:30 UTC on day -3 = 00:30 SAST on day -2
      const loan = await newLoan(database(), fx, "NCA")
      const matterId = await newMatter(database(), fx, loan.loanId)
      const record = (await database().complianceRecord.create({
        data: { tenantId: fx.tenantId, type: "SECTION_129_NOTICE", referenceId: loan.loanId, status: "COMPLETED", completedAt: utc(-3, "22:30:00.000") },
      })).id
      const sent = (stepDate: string) => (tx: Tx) => tx.legalMatterStep.create({
        data: { tenantId: fx.tenantId, matterId, kind: "S129_SENT", stepDate: dbDate(stepDate), recordedById: fx.officer, section129RecordId: record },
      })
      const sastDay = clauseOff("guardLegalMatterStep", `AND (c."completedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date <= NEW."stepDate"`)
      await refuses(sastDay, /names this loan's completed section 129 notice record/, sent(day(-3)))
      await admits(sent(day(-2)))
    })

    it("a proceeds receipt is received on or after the SAST day the sale completed: 22:10 UTC is already the next day, 21:30 UTC is not", async () => {
      // the sale completed at 22:30 UTC on day -3 = 00:30 SAST on day -2
      const rec = await ladderRecovery(database(), fx, false, "SOLD")
      const sale = await database().remarketingSale.findFirstOrThrow({ where: { recoveryId: rec.id, status: "COMPLETED" } })
      const proceeds = (receivedAt: Date) => async (tx: Tx) => {
        await triggersOff(tx)
        await tx.remarketingSale.update({ where: { id: sale.id }, data: { completedAt: utc(-3, "22:30:00.000") } })
        await triggersOn(tx)
        const payment = await tx.payment.create({
          data: { tenantId: fx.tenantId, loanId: rec.loan.loanId, amount: 120_000_000, capturedBy: fx.officer, idempotencyKey: proceedsKey(rec.id), receivedAt },
        })
        await tx.recovery.update({
          where: { id: rec.id },
          data: {
            status: "PROCEEDS_APPLIED", settlementDueCents: 150_000_000, grossProceedsCents: 120_000_000, deductedCostsCents: 0, chargedCostsCents: 0, netProceedsCents: 120_000_000,
            shortfallCents: 30_000_000, surplusCents: 0, proceedsPaymentId: payment.id, chargesFrozenFrom: dbDate(today()), chargesFrozenUntil: dbDate(day(10)),
          },
        })
      }
      const receivedDay = clauseOff("guardRecovery", `AND (p."receivedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date >= sale_day`)
      await refuses(receivedDay, /lesser of the net proceeds and the settlement/, proceeds(utc(-3, "21:30:00.000")))
      await admits(proceeds(utc(-3, "22:10:00.000")))
      await admits(proceeds(utc(-2, "10:00:00.000")))
    })
  })
})
