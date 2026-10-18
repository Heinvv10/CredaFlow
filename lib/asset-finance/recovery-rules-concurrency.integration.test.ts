/**
 * Slice 4a recovery rules under concurrency (READ COMMITTED): two connections,
 * the first holding its transaction open while the second tries its write. The
 * rules read other tables to decide (the loan's status, the asset's other
 * loans, the surrender's status, a recovery's figures), so each takes locks on
 * the rows it relies on: a recovery locks its loan (share), its asset
 * (update) and its s127 surrender (update); a loan insert locks the asset
 * (share); a credit of a surrender waits for the lock and then sees the
 * recovery. Each test shows the second connection WAITS and is then refused (or
 * admitted); the mutation takes the lock out and the same race goes through
 * (the function is redefined without the clause for the one race, then put back).
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-rules-concurrency.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"
import { dbDate } from "./dates"
import { testSetup } from "./lease-servicing.integration-fixture"
import { ladderRecovery } from "./recovery-path.integration-fixture"
import { disburseApplication } from "./recovery-sale.integration-fixture"
import { race, without } from "./recovery-race.integration-fixture"
import {
  cleanupRecoveryFixture, createRecoveryFixture, newLoan, newSurrender, newValuation, recoveryFixtureTenantId, today, type RecoveryFixture, type RecoveryLoan,
} from "./recovery.integration-fixture"

// The deal fixture imports the real route handlers, which import the session helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const other = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}
const second = (): PrismaClient => {
  if (!other) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return other
}
let fx: RecoveryFixture
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]
const G = "guardRecovery"

const openRecovery = (loan: RecoveryLoan, over: Record<string, unknown> = {}) => (tx: Tx) => tx.recovery.create({
  data: { tenantId: fx.tenantId, loanId: loan.loanId, assetId: loan.assetId, route: "NON_NCA_VOLUNTARY", recoveredOn: dbDate(today()), location: "TEST Yard", condition: "Synthetic: fair", createdById: fx.officer, ...over },
})
const recoveries = (loan: RecoveryLoan) => database().recovery.count({ where: { loanId: loan.loanId } })

suite.sequential("slice 4a recovery rules under concurrency", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
  }, 120_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$disconnect()
    await other?.$disconnect()
  }, 120_000)

  describe("the holder rule against a booking on the same asset", () => {
    /** A live loan on an asset, and a second loan ready to be booked on the same asset (its application written, the loan not). */
    const setup = async () => {
      const holder = await newLoan(database(), fx, "NON_NCA")
      const booking = await newLoan(database(), fx, "NCA", "INSTALMENT_SALE", { assetId: holder.assetId, deferred: true })
      return { holder, booking }
    }

    it("a recovery opens first: the booking waits, then is refused the recovered asset", async () => {
      const { holder, booking } = await setup()
      const raced = await race(database(), second(), openRecovery(holder), (tx) => booking.book?.(tx) as Promise<unknown>)
      expect(raced).toMatchObject({ first: { status: "committed" }, second: { status: "refused", message: "A recovered asset cannot be financed again" }, secondWaited: true })
      expect(await recoveries(holder)).toBe(1)
      expect(await database().loan.count({ where: { id: booking.loanId } })).toBe(0)
      // the loan guard is what refuses it: with it off the booking goes through beside the recovery
      const holder2 = await setup()
      const open = await without(database(), { table: "Loan", trigger: "Loan_asset_not_recovered" }, () =>
        race(database(), second(), openRecovery(holder2.holder), (tx) => holder2.booking.book?.(tx) as Promise<unknown>))
      expect(open.second.status).toBe("committed")
    })

    it("a booking goes first: the recovery waits, then is refused for the other live loan", async () => {
      const { holder, booking } = await setup()
      const raced = await race(database(), second(), (tx) => booking.book?.(tx) as Promise<unknown>, openRecovery(holder))
      expect(raced).toMatchObject({ first: { status: "committed" }, second: { status: "refused", message: "A recovery is opened by the loan that holds the asset now" }, secondWaited: true })
      expect(await recoveries(holder)).toBe(0)
      const again = await setup()
      const lockless = await without(database(), { fn: G, replace: [`WHERE a."id" = NEW."assetId" AND a."tenantId" = NEW."tenantId" FOR UPDATE;`, `WHERE a."id" = NEW."assetId" AND a."tenantId" = NEW."tenantId";`] }, () =>
        race(database(), second(), (tx) => again.booking.book?.(tx) as Promise<unknown>, openRecovery(again.holder)))
      // without the asset lock the recovery has already passed the holder check when it waits (on the asset update it ends with): both commit
      expect(lockless.second.status).toBe("committed")
      expect(await recoveries(again.holder)).toBe(1)
      expect(await database().loan.count({ where: { id: again.booking.loanId } })).toBe(1)
    })
  })

  describe("the loan's status against a settlement", () => {
    const completing = (loan: RecoveryLoan) => (tx: Tx) => tx.$executeRawUnsafe(`UPDATE "Loan" SET "status" = 'COMPLETED'::"LoanStatus" WHERE "id" = '${loan.loanId}'`)

    it("a loan completing at the same time is not recovered: the recovery waits for the loan lock, then sees COMPLETED", async () => {
      const loan = await newLoan(database(), fx, "NON_NCA")
      await disburseApplication(database(), fx, loan) // a loan whose application is not disbursed cannot be settled
      const raced = await race(database(), second(), completing(loan), openRecovery(loan))
      expect(raced).toMatchObject({ first: { status: "committed" }, second: { status: "refused", message: "A recovery is opened on an active, defaulted or pending write-off loan" }, secondWaited: true })
      expect(await recoveries(loan)).toBe(0)
      const stale = await newLoan(database(), fx, "NON_NCA")
      await disburseApplication(database(), fx, stale)
      const lockless = await without(database(), { fn: G, replace: [`FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" FOR SHARE;`, `FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId";`] }, () =>
        race(database(), second(), completing(stale), openRecovery(stale)))
      expect(lockless).toMatchObject({ second: { status: "committed" }, secondWaited: false }) // a completed loan recovered: the hole
    })
  })

  describe("a surrender credited at the same time as a recovery links it", () => {
    /** An NCA surrender at VALUATION_NOTICE_ISSUED (triggers off for the setup only), its loan and the legacy credit's two writes. */
    const surrender = async () => {
      const loan = await newLoan(database(), fx, "NCA")
      const surrenderId = await newSurrender(database(), fx, loan)
      const valuationId = await newValuation(database(), fx, loan.assetId)
      await testSetup(database(), [`UPDATE "SurrenderRequest" SET "status" = 'VALUATION_NOTICE_ISSUED', "valuationId" = $1, "valuationNoticePath" = '/nonexistent/vn.pdf', "valuationNoticeSha256" = $2, "valuationNoticeIssuedOn"=CURRENT_DATE-30, "valuationNoticeReceivedOn"=CURRENT_DATE-30, "valuationReceiptReference"='Synthetic received notice; clock advanced' WHERE "id" = $3`, valuationId, "b".repeat(64), surrenderId])
      const credit = async (tx: Tx) => {
        const payment = await tx.payment.create({ data: { tenantId: fx.tenantId, loanId: loan.loanId, amount: 50_000_000, capturedBy: fx.officer } })
        await tx.surrenderRequest.update({ where: { id: surrenderId }, data: { status: "PROCEEDS_CREDITED", saleProceedsCents: 50_000_000, proceedsPaymentId: payment.id, shortfallCents: 0, refundCents: 0 } })
      }
      const link = openRecovery(loan, { route: "NCA_S127_SURRENDER", surrenderRequestId: surrenderId })
      return { loan, surrenderId, credit, link }
    }
    const state = async (s: { loan: RecoveryLoan; surrenderId: string }) => ({
      recovered: await recoveries(s.loan),
      credited: (await database().surrenderRequest.findUniqueOrThrow({ where: { id: s.surrenderId } })).status === "PROCEEDS_CREDITED",
    })

    it("the credit goes first: the recovery waits for the surrender, then is refused it", async () => {
      const s = await surrender()
      const raced = await race(database(), second(), s.credit, s.link)
      expect(raced).toMatchObject({ first: { status: "committed" }, second: { status: "refused", message: "An s127 recovery follows a surrender that has not yet been credited or finally noticed" }, secondWaited: true })
      expect(await state(s)).toEqual({ recovered: 0, credited: true })
      const m = await surrender()
      const lockless = await without(database(), { fn: G, replace: [`AND s."status" IN ('REQUESTED', 'VALUED', 'VALUATION_NOTICE_ISSUED') FOR UPDATE;`, `AND s."status" IN ('REQUESTED', 'VALUED', 'VALUATION_NOTICE_ISSUED');`] }, () =>
        race(database(), second(), m.credit, m.link))
      expect(lockless.second.status).toBe("committed") // credited and linked at once: the hole
      expect(await state(m)).toEqual({ recovered: 1, credited: true })
    })

    it("the recovery goes first: the credit waits, then is refused (the legacy path)", async () => {
      const s = await surrender()
      const raced = await race(database(), second(), s.link, s.credit)
      expect(raced).toMatchObject({ first: { status: "committed" }, second: { status: "refused", message: "Sale proceeds for this surrender go through its recovery" }, secondWaited: true })
      expect(await state(s)).toEqual({ recovered: 1, credited: false })
      const m = await surrender()
      const lockless = await without(database(), { fn: G, replace: [`AND s."status" IN ('REQUESTED', 'VALUED', 'VALUATION_NOTICE_ISSUED') FOR UPDATE;`, `AND s."status" IN ('REQUESTED', 'VALUED', 'VALUATION_NOTICE_ISSUED');`] }, () =>
        race(database(), second(), m.link, m.credit))
      // the surrender's lock is not what holds the credit back (the credit's unique-index write waits on the recovery's foreign-key lock); the trigger is
      const noTrigger = await without(database(), { table: "SurrenderRequest", trigger: "SurrenderRequest_recovery_proceeds" }, async () => {
        const n = await surrender()
        return { n, raced: await race(database(), second(), n.link, n.credit) }
      })
      expect(lockless.second.status).toBe("refused")
      expect(noTrigger.raced.second.status).toBe("committed")
      expect(await state(noTrigger.n)).toEqual({ recovered: 1, credited: true })
    })
  })

  describe("the window between the proceeds and the costs the ledger could not carry", () => {
    /** An NCA recovery SOLD, and the proceeds written the way the service does but with the figure left unset (committed in its own transaction). */
    const sold = async () => {
      const rec = await ladderRecovery(database(), fx, true, "SOLD")
      const proceeds = async (tx: Tx) => {
        const payment = await tx.payment.create({ data: { tenantId: fx.tenantId, loanId: rec.loan.loanId, amount: 120_000_000, capturedBy: fx.officer, idempotencyKey: `asset-recovery:${rec.id}:proceeds` } })
        await tx.recovery.update({
          where: { id: rec.id },
          data: {
            status: "PROCEEDS_APPLIED", settlementDueCents: 150_000_000, grossProceedsCents: 120_000_000, deductedCostsCents: 0, chargedCostsCents: 0, netProceedsCents: 120_000_000,
            shortfallCents: 30_000_000, surplusCents: 0, proceedsPaymentId: payment.id, chargesFrozenFrom: dbDate(today()),
          },
        })
      }
      const finalNotice = (tx: Tx) => tx.recovery.update({
        where: { id: rec.id },
        data: { status: "FINAL_NOTICE_ISSUED", finalNoticeIssuedOn: dbDate(today()), finalNoticePath: "/nonexistent/fn.pdf", finalNoticeSha256: "c".repeat(64), chargesFrozenUntil: dbDate(addSouthAfricanBusinessDays(today(), 10)) },
      })
      return { rec, proceeds, finalNotice }
    }

    it("a final notice cannot be issued on figures that leave the unrecoverable costs unset", async () => {
      const s = await sold()
      const raced = await race(database(), second(), s.proceeds, s.finalNotice)
      expect(raced.first.status).toBe("committed")
      expect(raced.second).toEqual({ status: "refused", message: "The costs the loan's ledger could not carry are recorded before the final notice" })
      expect(raced.secondWaited).toBe(true)
      expect((await database().recovery.findUniqueOrThrow({ where: { id: s.rec.id } })).status).toBe("PROCEEDS_APPLIED")
      // without the rule the notice is issued on the unset figure
      const m = await sold()
      const open = await without(database(), { fn: G, replace: [`IF NEW."unrecoverableCostsCents" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The costs the loan''s ledger could not carry are recorded before the final notice';`, `IF false THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The costs the loan''s ledger could not carry are recorded before the final notice';`] }, () =>
        race(database(), second(), m.proceeds, m.finalNotice))
      expect(open.second.status).toBe("committed")
      expect((await database().recovery.findUniqueOrThrow({ where: { id: m.rec.id } })).status).toBe("FINAL_NOTICE_ISSUED")
    })
  })
})
