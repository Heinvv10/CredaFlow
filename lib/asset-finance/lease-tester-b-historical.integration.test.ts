/** Legal gaps 13, 14 and 25, through the real migrated ledger and tax-invoice service. Synthetic only. */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { cleanupDealFixture, dealFixtureTenantId } from "./deal.integration-fixture"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { quoteEarlyTermination, acceptEarlyTermination } from "./lease-termination-store"
import { backdateLease, testSetup } from "./lease-servicing.integration-fixture"
import { presentValueOfRentals } from "./lease-termination"
import { isoOfDbDate } from "./dates"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const db = RUN ? new PrismaClient() : null
const database = () => { if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT required"); return db }
const suite = RUN ? describe : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const loans: string[] = []
const today = () => sastCalendarDate(new Date())
const setSession = (user: SessionUser | null) => { session.current = user && { user } }
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })
suite.sequential("experimental historical CPA rate state: application reachability unproven", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
    for (const assetId of fx.assets.slice(0, 4)) {
      const id = await approveLease(fx, staff, leaseBody(fx, { assetId, contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", ...(assetId === fx.assets[3] ? { clientId: fx.lessee } : { entityId: fx.evidenced }) }))
      await signLease(fx, database(), setSession, id)
      loans.push(await payoutAndBook(fx, database(), staff, id))
    }
    const source = await database().financedAsset.findUniqueOrThrow({ where: { id: fx.assets[3] } })
    for (const label of ["PREPAID", "RECOVERY"]) {
      const asset = await database().financedAsset.create({ data: { ...source, id: undefined, serialNumber: `SYN-${label}-${t}`, vin: null, registrationNumber: null, lessorStatus: null, releasedAt: null } })
      const deal = await approveLease(fx, staff, leaseBody(fx, { assetId: asset.id, contractType: label === "PREPAID" ? "FULL_MAINTENANCE_LEASE" : "OPERATING_LEASE", rentalTiming: "ARREARS", ...(label === "PREPAID" ? { clientId: fx.lessee, maintenanceRiskModel: "LESSEE_SETTLED" } : { entityId: fx.evidenced }) }))
      await signLease(fx, database(), setSession, deal)
      loans.push(await payoutAndBook(fx, database(), staff, deal))
    }

  }, 600_000)
  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(t) })
    await db?.$disconnect()
  }, 60_000)

  it("assesses a historical CPA cancellation at the rate effective on its fixed termination date", async () => {
    const loanId = loans[3]
    await backdateLease(database(), loanId, 3)
    const actor = { tenantId: fx.tenantId, userId: fx.adminA }
    // Simulate the previously served notice, without changing the wall clock.
    const notice = await database().$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
      return quoteEarlyTermination(tx as never, actor, { loanId, today: "2026-08-01" })
    })
    expect(notice.kind).toBe("quoted")
    if (notice.kind !== "quoted") throw new Error(JSON.stringify(notice))
    const before = await database().loan.findUniqueOrThrow({ where: { id: loanId }, include: { contractRates: true, leaseRentals: true } })
    const originalRate = before.contractRates[0]
    await testSetup(database(), ['INSERT INTO "ContractRate" ("id", "tenantId", "loanId", "effectiveDate", "basis", "fixedRate", "margin", "resultingRate", "createdAt") SELECT $1,"tenantId","loanId",$2,"basis","fixedRate","margin",0.25,now() FROM "ContractRate" WHERE "id"=$3', `synthetic-after-cpa-${t}`, new Date("2026-10-01"), originalRate.id])
    const assessed = await database().$transaction((tx) => acceptEarlyTermination(tx as never, actor, { quoteId: notice.quoteId, today: today(), assessment: { goodsValueCents: 0, costs: [] } }))
    expect(assessed.kind).toBe("accepted")
    const quote = await database().leaseTerminationQuote.findUniqueOrThrow({ where: { id: notice.quoteId } })
    const expected = presentValueOfRentals(before.leaseRentals.map((r) => ({ dueDate: isoOfDbDate(r.dueDate), rentalExclVatCents: r.rentalExclVatCents })), notice.terminationDate, Number(originalRate.resultingRate))
    expect(quote.pvCents).toBe(expected)
  })

})
