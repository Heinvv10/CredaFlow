/**
 * Real-Postgres proof of the daily arrears history (workstream G, migration
 * 20261017090000_loan_arrears_snapshot): the NCR return for a closed quarter
 * reads that quarter's last day of history, a rerun on the same day writes
 * nothing, history rows cannot be changed, and the history reproduces the
 * live book-arrears figures by the same definitions.
 *
 *   RUN_ARREARS_HISTORY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/reports/arrears-snapshot.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { createChargesLoan, createChargesTenant, SCHEDULE_TOTAL } from "@/lib/loan/charges.integration-fixture"
import { recomputeLoanBalances } from "@/lib/loan/balances"
import { getBookArrears } from "@/lib/reports/book-arrears"
import { getNcrReturnData } from "@/lib/compliance/ncr-return"
import { bookArrearsFromSnapshot, readSnapshotDay, snapshotDay, snapshotTenantArrears } from "./arrears-snapshot"

const RUN = process.env.RUN_ARREARS_HISTORY_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
// The helpers are typed for the app's extended client; a plain one serves here.
const appDb = db as unknown as Parameters<typeof snapshotTenantArrears>[2] & Parameters<typeof getBookArrears>[2] & Parameters<typeof readSnapshotDay>[2]

// The fixture's R2,000 bullet fell due 1 Sep 2026 and is unpaid.
const Q3_LAST_EVENING = new Date("2026-09-30T20:00:00Z") // 22:00 SAST, 30 Sep: 29 days past due
const Q4_LAST_EVENING = new Date("2026-12-31T20:00:00Z") // 22:00 SAST, 31 Dec: 121 days past due
const AFTER_Q4 = new Date("2027-01-15T10:00:00Z")

suite("daily arrears history", () => {
  let tenantId = ""
  let loanId = ""

  beforeAll(async () => {
    const tenant = await createChargesTenant(db, false)
    tenantId = tenant.tenantId
    loanId = (await createChargesLoan(db, tenant)).loanId
  }, 60_000)

  afterAll(async () => {
    await db.$disconnect()
  })

  it("records each SAST day once: a rerun the same day writes nothing", async () => {
    expect(await snapshotTenantArrears(tenantId, Q3_LAST_EVENING, appDb)).toEqual({ snapshotDate: "2026-09-30", loans: 1, written: 1 })
    expect(await snapshotTenantArrears(tenantId, Q3_LAST_EVENING, appDb)).toEqual({ snapshotDate: "2026-09-30", loans: 1, written: 0 })
    expect(await snapshotTenantArrears(tenantId, Q4_LAST_EVENING, appDb)).toMatchObject({ snapshotDate: "2026-12-31", written: 1 })
    const rows = await db.loanArrearsSnapshot.findMany({ where: { tenantId }, orderBy: { snapshotDate: "asc" } })
    expect(rows.map((r) => [r.snapshotDate.toISOString().slice(0, 10), r.daysInArrears, r.arrearsCents])).toEqual([
      ["2026-09-30", 29, SCHEDULE_TOTAL],
      ["2026-12-31", 121, SCHEDULE_TOTAL],
    ])
  }, 60_000)

  // Re-review of #153: rows and marker commit together, so a crash part-way
  // leaves the day unrecorded rather than rows without a marker.
  it("rolls the day's marker back with its rows when the write fails", async () => {
    const crashing = {
      ...appDb,
      loan: db.loan, tenantConfig: db.tenantConfig,
      $transaction: <T>(fn: (tx: never) => Promise<T>) => db.$transaction((tx) => fn({
        arrearsSnapshotRun: tx.arrearsSnapshotRun,
        loanArrearsSnapshot: { createMany: async () => { throw new Error("crash mid-write") } },
      } as never)),
    } as unknown as typeof appDb
    const CRASH_DAY = new Date("2026-11-15T20:00:00Z")
    await expect(snapshotTenantArrears(tenantId, CRASH_DAY, crashing)).rejects.toThrow("crash mid-write")
    expect(await db.arrearsSnapshotRun.count({ where: { tenantId, snapshotDate: snapshotDay(CRASH_DAY) } })).toBe(0)
    // The next run that day records it whole.
    expect(await snapshotTenantArrears(tenantId, CRASH_DAY, appDb)).toMatchObject({ written: 1 })
    expect(await db.arrearsSnapshotRun.count({ where: { tenantId, snapshotDate: snapshotDay(CRASH_DAY) } })).toBe(1)
  }, 60_000)

  it("returns each closed quarter from its own last day: the earlier quarter from the earlier snapshot", async () => {
    const q3 = await getNcrReturnData(tenantId, "2026-Q3", AFTER_Q4)
    const q4 = await getNcrReturnData(tenantId, "2026-Q4", AFTER_Q4)
    const line = (data: typeof q3, key: string) => data.lines.find((l) => l.key === key)!

    expect(q3).toMatchObject({ positionSource: "SNAPSHOT", positionAsOf: new Date("2026-09-30T00:00:00.000Z"), positionIsStale: false })
    expect(line(q3, "arrears")).toMatchObject({ count: 1, value: SCHEDULE_TOTAL })
    expect(line(q3, "par30")).toMatchObject({ count: 0 })
    expect(line(q3, "par90")).toMatchObject({ count: 0 })

    expect(q4).toMatchObject({ positionSource: "SNAPSHOT", positionAsOf: new Date("2026-12-31T00:00:00.000Z") })
    expect(line(q4, "par90")).toMatchObject({ count: 1, value: 200_000 })

    expect(q3.historyStartsOn).toEqual(new Date("2026-09-30T00:00:00.000Z"))
  }, 60_000)

  it("keeps today's book, flagged stale, for a closed quarter before history began", async () => {
    const q2 = await getNcrReturnData(tenantId, "2026-Q2", AFTER_Q4)
    expect(q2).toMatchObject({ positionSource: "LIVE", positionAsOf: null, positionIsStale: true })
  }, 60_000)

  it("refuses to change, remove or truncate history", async () => {
    await expect(db.$executeRawUnsafe(
      `UPDATE "LoanArrearsSnapshot" SET "daysInArrears" = 0 WHERE "tenantId" = $1`, tenantId,
    )).rejects.toThrow(/append-only/)
    await expect(db.$executeRawUnsafe(`DELETE FROM "LoanArrearsSnapshot" WHERE "tenantId" = $1`, tenantId)).rejects.toThrow(/append-only/)
    await expect(db.$executeRawUnsafe(`UPDATE "ArrearsSnapshotRun" SET "loanCount" = 0 WHERE "tenantId" = $1`, tenantId)).rejects.toThrow(/append-only/)
    await expect(db.$executeRawUnsafe(`TRUNCATE "LoanArrearsSnapshot"`)).rejects.toThrow(/append-only/)
    await expect(db.$executeRawUnsafe(`TRUNCATE "ArrearsSnapshotRun"`)).rejects.toThrow(/append-only/)
  }, 60_000)

  // Review of #153: a quarter-end day the snapshot ran on with an empty book
  // reads as that (empty) position, not as missing history.
  it("reads a quarter-end day with an empty collectible book as an empty position", async () => {
    const empty = await createChargesTenant(db, false)
    await snapshotTenantArrears(empty.tenantId, Q3_LAST_EVENING, appDb)
    const q3 = await getNcrReturnData(empty.tenantId, "2026-Q3", AFTER_Q4)
    expect(q3).toMatchObject({ positionSource: "SNAPSHOT", positionIsStale: false, collectibleBook: { count: 0, value: 0 } })
  }, 60_000)

  it("reproduces the live book-arrears figures when the loan columns are current", async () => {
    const now = new Date()
    const loan = await db.loan.findUniqueOrThrow({ where: { id: loanId }, include: { repaymentSchedule: { orderBy: { dueDate: "asc" } } } })
    const live = recomputeLoanBalances(loan.principal, loan.repaymentSchedule, now)
    // As the DPD cron would leave them today.
    await db.loan.update({ where: { id: loanId }, data: { daysInArrears: live.daysInArrears, arrearsAmount: live.arrearsAmount } })
    await snapshotTenantArrears(tenantId, now, appDb)

    const fromHistory = bookArrearsFromSnapshot((await readSnapshotDay(tenantId, snapshotDay(now), appDb))!, "NCA")
    const fromLoans = await getBookArrears(tenantId, "NCA", appDb)
    const { defaulted: _d, attorneyReferred: _a, ...comparable } = fromHistory
    expect(comparable).toEqual(fromLoans)
  }, 60_000)
})
