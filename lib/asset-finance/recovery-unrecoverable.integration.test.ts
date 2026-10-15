/**
 * Charged costs the loan's ledger could not carry (Recovery.unrecoverableCostsCents)
 * are shown apart and the account shortfall is net of them, in the staff view
 * and the portal; and the legacy surrender proceeds path answers the database's
 * refusal (a recovery linked in the race window) as a 409. Real routes, a
 * migrated Postgres.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-unrecoverable.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma as appPrisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { testSetup } from "./lease-servicing.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, recoveryFixtureTenantId, type RecoveryFixture } from "./recovery.integration-fixture"
import { ladderRecovery } from "./recovery-path.integration-fixture"
import { recoveryRoutes } from "./recovery-routes.integration-fixture"
import { creditSurrenderProceeds } from "./surrender-store"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: RecoveryFixture
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}
const as = (id: string, role: string) => { session.current = { user: { id, email: `${id}@recovery-it.test`, role, tenantId: fx.tenantId } } }

suite.sequential("unrecoverable costs display and the legacy proceeds race (real Postgres)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createRecoveryFixture(database(), t)
  }, 120_000)
  afterAll(async () => {
    if (!db) return
    await cleanupRecoveryFixture(db, recoveryFixtureTenantId(t))
    await db.$disconnect()
  }, 120_000)

  it("the staff view and the portal show the cost apart and the shortfall net of it", async () => {
    const { id, loan } = await ladderRecovery(database(), fx, false, "SHORTFALL_OPEN", { costs: [{ type: "TOWING", treatment: "CHARGE_TO_ACCOUNT", grossCents: 800_000 }] })
    const row = await database().recovery.findUniqueOrThrow({ where: { id } })
    const shortfall = row.shortfallCents ?? 0
    expect(shortfall).toBeGreaterThan(300_000)
    await testSetup(database(), [`UPDATE "Recovery" SET "unrecoverableCostsCents" = 300000 WHERE "id" = $1`, id])
    as(fx.officer, "CREDIT_OFFICER")
    const r = recoveryRoutes(fx.host)
    const staff = (await r.view(id)).body.figures as { shortfallCents: number; unrecoverableCostsCents: number }
    expect(staff).toMatchObject({ shortfallCents: shortfall - 300_000, unrecoverableCostsCents: 300_000 })

    as(fx.director, "CLIENT") // a director of the company borrower
    const portal = (await r.portal(loan.loanId)).body.recovery as { finalAccount: { shortfallCents: number; unrecoverableCostsCents: number } }
    expect(portal.finalAccount).toMatchObject({ shortfallCents: shortfall - 300_000, unrecoverableCostsCents: 300_000 })

    // None recorded: the shortfall is as stored and the amount is nil.
    await testSetup(database(), [`UPDATE "Recovery" SET "unrecoverableCostsCents" = NULL WHERE "id" = $1`, id])
    as(fx.officer, "CREDIT_OFFICER")
    expect((await r.view(id)).body.figures).toMatchObject({ shortfallCents: shortfall, unrecoverableCostsCents: 0 })
  }, 120_000)

  it("answers 409 when a recovery is linked between the legacy path's check and its write", async () => {
    const { surrenderId, loan } = await ladderRecovery(database(), fx, true, "LISTED", {}, true)
    const real = appPrisma.surrenderRequest.findFirst.bind(appPrisma.surrenderRequest)
    // The check reads the surrender before the recovery is linked: simulate that read.
    const spy = vi.spyOn(appPrisma.surrenderRequest, "findFirst").mockImplementationOnce((async (args: never) => {
      const found = await real(args)
      return found ? { ...(found as object), recovery: null } : found
    }) as never)
    try {
      const result = await runWithTenant(fx.tenantId, () => creditSurrenderProceeds({ tenantId: fx.tenantId, userId: fx.officer }, surrenderId ?? "", 100_000))
      expect(result).toEqual({ kind: "not_ready", reason: "Sale proceeds for this surrender go through its recovery" })
    } finally {
      spy.mockRestore()
    }
    expect((await database().surrenderRequest.findUniqueOrThrow({ where: { id: surrenderId ?? "" } })).status).toBe("VALUATION_NOTICE_ISSUED")
    expect(loan.regime).toBe("NCA")
  }, 120_000)
})
