/**
 * Slice 4a a recovery is opened by the loan that holds the asset now (migration
 * 20261015400000, guardRecovery), each rule proved as in the lease suites: the
 * attack is refused, and goes through with that one statement taken out,
 * inside a rolled-back transaction; and the same attack through the staff
 * route answers 409 with the database's sentence (the pre-check in
 * createRecoveryTx). A loan opens a recovery only while it is ACTIVE,
 * DEFAULTED or PENDING_WRITE_OFF, and only if no other live loan of the lender
 * (not COMPLETED, CANCELLED or WRITTEN_OFF) names the same asset: an asset a
 * lease returned and a new lease took is recovered through the new lease.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-rules-holder.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient, type LoanStatus } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { dbDate } from "./dates"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, newAsset, newLoan, recoveryFixtureTenantId, today, type RecoveryFixture, type RecoveryLoan } from "./recovery.integration-fixture"
import { raiseOff, rules, triggersOff, triggersOn, type Tx } from "./recovery-rules.integration-fixture"
import { recoveryRoutes } from "./recovery-routes.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

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
const G = "guardRecovery"
const STATUS = "A recovery is opened on an active, defaulted or pending write-off loan"
const HOLDER = "A recovery is opened by the loan that holds the asset now"

const open = (tx: Tx, loan: RecoveryLoan) => tx.recovery.create({
  data: {
    tenantId: fx.tenantId, loanId: loan.loanId, assetId: loan.assetId, route: "NON_NCA_VOLUNTARY", recoveredOn: dbDate(today()), location: "TEST Yard", condition: "Synthetic: fair", createdById: fx.officer,
  },
})
const setStatus = async (tx: Tx, loan: RecoveryLoan, status: LoanStatus) => {
  await triggersOff(tx)
  await tx.$executeRawUnsafe(`UPDATE "Loan" SET "status" = '${status}'::"LoanStatus" WHERE "id" = '${loan.loanId}'`)
  await triggersOn(tx)
}
/** Two NON_NCA leases of one asset, the first ended unless `firstStatus` says otherwise. */
async function twoLeases(firstStatus: LoanStatus = "COMPLETED"): Promise<{ first: RecoveryLoan; second: RecoveryLoan }> {
  const assetId = await newAsset(database(), fx)
  const first = await newLoan(database(), fx, "NON_NCA", "OPERATING_LEASE", { assetId })
  const second = await newLoan(database(), fx, "NON_NCA", "OPERATING_LEASE", { assetId })
  await database().$transaction([
    database().$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
    database().$executeRawUnsafe(`UPDATE "Loan" SET "status" = '${firstStatus}'::"LoanStatus" WHERE "id" = '${first.loanId}'`),
  ])
  return { first, second }
}

suite("slice 4a a recovery is opened by the loan that holds the asset now", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createRecoveryFixture(database(), t)
  }, 120_000)

  afterAll(async () => {
    session.current = null
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$disconnect()
  }, 120_000)

  it("opens a recovery only on an ACTIVE, DEFAULTED or PENDING_WRITE_OFF loan", async () => {
    const rule = raiseOff(G, STATUS)
    for (const status of ["COMPLETED", "CANCELLED", "WRITTEN_OFF", "RESTRUCTURED"] as const) {
      await refuses(rule, new RegExp(STATUS), async (tx) => { const loan = await newLoan(database(), fx, "NON_NCA"); await setStatus(tx, loan, status); await open(tx, loan) })
    }
    for (const status of ["ACTIVE", "DEFAULTED", "PENDING_WRITE_OFF"] as const) {
      await admits(async (tx) => { const loan = await newLoan(database(), fx, "NON_NCA"); await setStatus(tx, loan, status); await open(tx, loan) })
    }
  })

  it("is opened by the asset's current holder: an ended lease cannot recover what a live lease holds (A1)", async () => {
    // the ended lease is refused by its status; the status rule is out so the holder rule is what refuses it
    await refuses(raiseOff(G, HOLDER), new RegExp(STATUS), async (tx) => { const { first } = await twoLeases(); await open(tx, first) }, [raiseOff(G, STATUS)])
    const holder = raiseOff(G, HOLDER)
    // two live loans on one asset: the one that is not the holder's is refused whichever it is
    await refuses(holder, new RegExp(HOLDER), async (tx) => { const { first } = await twoLeases("DEFAULTED"); await open(tx, first) })
    await refuses(holder, new RegExp(HOLDER), async (tx) => { const { second } = await twoLeases("DEFAULTED"); await open(tx, second) })
    // once the other loan has ended, the live one is the holder
    for (const ended of ["COMPLETED", "CANCELLED", "WRITTEN_OFF"] as const) await admits(async (tx) => { const { second } = await twoLeases(ended); await open(tx, second) })
  })

  describe("through the staff route", () => {
    const as = (id: string) => { session.current = { user: { id, email: `${id}@holder-it.test`, role: "CREDIT_OFFICER", tenantId: fx.tenantId } } }
    const create = (loan: RecoveryLoan) => recoveryRoutes(fx.host).create(loan.loanId, { route: "NON_NCA_VOLUNTARY", recoveredOn: today(), location: "TEST Yard", condition: "Synthetic: fair" })

    it("answers 409 with the database's sentence, and writes no recovery and no asset status", async () => {
      as(fx.officer)
      const ended = await twoLeases() // A1: the COMPLETED lease 1 of an asset re-leased on live lease 2
      const refusedEnded = await create(ended.first)
      expect(refusedEnded).toMatchObject({ status: 409, body: { error: STATUS } })
      const shared = await twoLeases("DEFAULTED") // both live
      expect(await create(shared.first)).toMatchObject({ status: 409, body: { error: HOLDER } })
      for (const loan of [ended.first, ended.second, shared.first]) expect(await database().recovery.count({ where: { loanId: loan.loanId } })).toBe(0)
      expect((await database().financedAsset.findUniqueOrThrow({ where: { id: ended.first.assetId } })).lessorStatus).toBeNull()
      // the holder is recovered normally
      expect((await create(ended.second)).status).toBe(201)
      expect((await database().financedAsset.findUniqueOrThrow({ where: { id: ended.second.assetId } })).lessorStatus).toBe("RECOVERED")
    })
  })
})
