/**
 * Architecture review round 4 repro (PR #222), asserting the fix: an extended
 * lease is inspected on its EXTEND end-of-term row (recordInspection:
 * "extensionOver"), so the tenure ends at the inspection whatever the
 * outcome, in telematicsLoanAt and in the view.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/extended-return.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { edgeHelpers } from "./edge.integration-fixture"
import { loanCovering } from "./event-insert"
import { revealPosition } from "./position-view"
import { cleanupTelematicsFixture, createTelematicsFixture, daysAgo, telematicsTestClient } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const { leaseWithDevice, asTestSetup } = edgeHelpers(database, () => fx, (user) => { session.current = user && { user } })
const INSPECTED = (outcome: string) => `INSERT INTO "LeaseEndOfTerm" ("id", "tenantId", "loanId", "origin", "outcome", "status", "electedAt", "inspectedOn",
  "inspectedById", "inspectionCondition", "updatedAt")
  VALUES (gen_random_uuid()::text, $1, $2, 'EXPIRY', '${outcome}', 'INSPECTED', now() - INTERVAL '20 days', $3::date, $4, 'Synthetic inspection', now())`

suite.sequential("tenure ends at the return inspection, whatever the end-of-term outcome (real DB)", () => {
  beforeAll(async () => {
    fx = await createTelematicsFixture(database(), t)
  }, 600_000)
  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it.each(["RETURN", "EXTEND"])("an inspected %s end of term ends the tenure", async (outcome) => {
    const lease = await leaseWithDevice()
    await asTestSetup([INSPECTED(outcome), fx.tenantId, lease.loanId, daysAgo(2), fx.officer])
    const covering = await database().$transaction((tx) => loanCovering(tx as never, fx.tenantId, lease.assetId, new Date()))
    expect(covering).toBeNull()
    // The view agrees: a fix from an hour ago, after the inspection day began, is not this loan's.
    await asTestSetup(
      [`INSERT INTO "TelematicsEvent" ("id", "tenantId", "deviceId", "provider", "providerEventId", "kind", "occurredAt", "simulated")
        VALUES ($1, $2, $3, 'simulated', $1, 'POSITION', (now() AT TIME ZONE 'UTC') - INTERVAL '1 hour', true)`, `xr_${lease.deviceId}`, fx.tenantId, lease.deviceId],
      [`INSERT INTO "TelematicsPosition" ("id", "tenantId", "eventId", "deviceId", "occurredAt", "latitude", "longitude")
        SELECT $1, "tenantId", "id", "deviceId", "occurredAt", -35.01, 20.01 FROM "TelematicsEvent" WHERE "id" = $1`, `xr_${lease.deviceId}`],
      [`UPDATE "Loan" SET "status" = 'DEFAULTED' WHERE "id" = $1`, lease.loanId])
    expect(await revealPosition({ tenantId: fx.tenantId, userId: fx.officer, userEmail: "o@staff.invalid", role: "CREDIT_OFFICER" }, lease.loanId, { context: "DEFAULT" },
      { ipAddress: null, userAgent: null })).toEqual({ kind: "ok", none: true })
    // Back in good standing: the next case books another lease for the same borrower.
    await asTestSetup([`UPDATE "Loan" SET "status" = 'ACTIVE' WHERE "id" = $1`, lease.loanId])
  }, 300_000)
})
