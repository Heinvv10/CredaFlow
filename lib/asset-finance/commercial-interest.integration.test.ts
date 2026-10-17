import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { syncLoanCharges } from "@/lib/loan/charges-sync"
import type { ChargesTx } from "@/lib/loan/charges-replay"
import { createBookedContractFixture, cleanupBookedContractFixture, type BookedContractFixture } from "./portal-contract.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
const run = process.env.RUN_ASSET_FINANCE_COMMERCIAL_IT === "1"
const db = run ? new PrismaClient() : null
const suite = run ? describe : describe.skip
let fx: BookedContractFixture
suite("common-law in duplum persisted through the real Postgres charge replay", () => {
  beforeAll(async () => {
    fx = await createBookedContractFixture(db!, randomUUID().replaceAll("-", "").slice(0, 16), (user) => { session.current = user && { user } }, { dealAArrears: { margin: "0.4", feeCents: 0 } })
    await db!.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { defaultChargesEnabled: true, defaultChargesStartedAt: new Date() } })
  }, 120000)
  afterAll(async () => { if (db) { await cleanupBookedContractFixture(db, fx); await db.$disconnect() } })
  it("caps unpaid interest at capital and writes the capped charge to the ledger", async () => {
    const loan = await db!.loan.findUniqueOrThrow({ where: { id: fx.loanId } })
    await db!.$transaction(async (tx) => {
      await syncLoanCharges(tx as unknown as ChargesTx, { tenantId: fx.tenantId, loanId: fx.loanId }, new Date("2050-01-01"), { source: "commercial-legal-it", userId: fx.officer })
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    })
    const charges = await db!.loanCharge.findMany({ where: { loanId: fx.loanId, type: "DEFAULT_INTEREST" } })
    const unpaidContractInterest = loan.totalInterest
    const expectedDefaultInterest = loan.principal - unpaidContractInterest
    expect(expectedDefaultInterest).toBeGreaterThan(0)
    expect(charges.reduce((sum, row) => sum + row.amount, 0)).toBe(expectedDefaultInterest)
    expect(await db!.loan.findUniqueOrThrow({ where: { id: fx.loanId } })).toMatchObject({ chargesOutstanding: expectedDefaultInterest })
  })
})
