/**
 * The surrender and the recovery keep out of each other's way, through the real
 * routes against a migrated Postgres: a borrower cannot ask to surrender an
 * asset the lender already holds (portal POST, 422) until the recovery is
 * withdrawn, and a recovery links only a surrender whose proceeds are not yet
 * credited (409).
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-surrender-gate.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { POST as portalSurrender } from "@/app/api/portal/asset-finance/loans/[loanId]/surrender/route"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { testSetup } from "./lease-servicing.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, newLoan, recoveryFixtureTenantId, today, type RecoveryFixture } from "./recovery.integration-fixture"
import { ladderRecovery } from "./recovery-path.integration-fixture"
import { recoveryRoutes } from "./recovery-routes.integration-fixture"
import { requestSurrender } from "./surrender-store"

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

async function portalRequest(loanId: string) {
  const clientId = (await database().loan.findUniqueOrThrow({ where: { id: loanId } })).clientId ?? ""
  as(clientId, "CLIENT")
  const response = await portalSurrender(new NextRequest(`http://${fx.host}/api/portal/asset-finance/loans/${loanId}/surrender`, {
    method: "POST", headers: { host: fx.host, "content-type": "application/json" }, body: JSON.stringify({ assetCondition: "Synthetic: running" }),
  }), { params: Promise.resolve({ loanId }) })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

suite.sequential("surrender and recovery gates (real Postgres)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createRecoveryFixture(database(), t)
  }, 120_000)
  afterAll(async () => {
    if (!db) return
    await cleanupRecoveryFixture(db, recoveryFixtureTenantId(t))
    await db.$disconnect()
  }, 120_000)

  it("a borrower cannot ask to surrender an asset the lender already holds, until the recovery is withdrawn", async () => {
    const control = await newLoan(database(), fx, "NCA")
    expect((await portalRequest(control.loanId)).status).toBe(201)

    const { id, loan } = await ladderRecovery(database(), fx, true, "RECOVERED")
    expect((await database().financedAsset.findUniqueOrThrow({ where: { id: loan.assetId } })).lessorStatus).toBe("RECOVERED")
    const refused = await portalRequest(loan.loanId)
    expect(refused.status).toBe(422)
    expect(refused.body.error).toBe("The asset is already in the lender's possession")
    expect(await database().surrenderRequest.count({ where: { loanId: loan.loanId } })).toBe(0)

    as(fx.officer, "CREDIT_OFFICER")
    expect((await recoveryRoutes(fx.host).withdraw(id, { reason: "The debtor paid the arrears in full" })).status).toBe(200)
    expect((await portalRequest(loan.loanId)).status).toBe(201)
  }, 120_000)

  it("a recovery links a surrender only before its proceeds are credited", async () => {
    const loan = await newLoan(database(), fx, "NCA")
    const requested = await requestSurrender({ tenantId: fx.tenantId, userId: fx.officer }, loan.loanId, "Synthetic: running", "STAFF")
    if (requested.kind !== "done") throw new Error("surrender not requested")
    const body = { route: "NCA_S127_SURRENDER", recoveredOn: today(), location: "TEST Yard", condition: "Synthetic: fair", surrenderRequestId: requested.id }
    as(fx.officer, "CREDIT_OFFICER")
    const r = recoveryRoutes(fx.host)
    for (const status of ["PROCEEDS_CREDITED", "FINAL_NOTICE_ISSUED"]) {
      await testSetup(database(), [`UPDATE "SurrenderRequest" SET "status" = $2::"SurrenderStatus" WHERE "id" = $1`, requested.id, status])
      const refused = await r.create(loan.loanId, body)
      expect(refused.status).toBe(409)
      expect(refused.body.error).toBe("A recovery links a surrender before its sale proceeds are credited")
    }
    expect(await database().recovery.count({ where: { loanId: loan.loanId } })).toBe(0)
    await testSetup(database(), [`UPDATE "SurrenderRequest" SET "status" = 'REQUESTED' WHERE "id" = $1`, requested.id])
    expect((await r.create(loan.loanId, body)).status).toBe(201)
  }, 120_000)
})
