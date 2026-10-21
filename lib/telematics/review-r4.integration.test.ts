/**
 * Review round 4 repro for PR #222: the view's tenure ends at a TOTAL_LOSS end
 * of term (telematicsLoanAt does too; only the DB side was mutation-guarded).
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=... npx vitest run lib/telematics/review-r4.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { testSetup } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { pollTenant } from "./poll"
import { revealPosition } from "./position-view"
import { bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, installDevice, telematicsTestClient } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
let loanId = ""
let collector = ""
const database = (): PrismaClient => { if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required"); return db }
const setSession = (user: SessionUser | null) => { session.current = user && { user } }

suite.sequential("position view: a total loss ends the tenure (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
    loanId = await bookOperatingLease(database(), fx, setSession, fx.assets[1])
    await installDevice(fx, fx.assets[1], "SIM-STEADY-4", daysAgo(30))
    expect(await pollTenant(fx.tenantId, new Date())).toMatchObject({ ok: true, failed: 0 })
    collector = (await database().user.create({ data: { tenantId: fx.tenantId, email: `c-${t}@staff.invalid`, password: "x", role: "COLLECTIONS_OFFICER" } })).id
  }, 600_000)

  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("shows no position dated after the total loss", async () => {
    await testSetup(database(),
      [`INSERT INTO "LeaseEndOfTerm" ("id", "tenantId", "loanId", "origin", "outcome", "status", "electedAt", "updatedAt")
        VALUES (gen_random_uuid()::text, $1, $2, 'EARLY_TERMINATION', 'TOTAL_LOSS', 'ELECTED', now() - INTERVAL '2 days', now())`, fx.tenantId, loanId],
      [`UPDATE "Loan" SET "status" = 'DEFAULTED' WHERE "id" = $1`, loanId])
    const answer = await revealPosition({ tenantId: fx.tenantId, userId: collector, userEmail: "c@staff.invalid", role: "COLLECTIONS_OFFICER" }, loanId, { context: "DEFAULT" },
      { ipAddress: "192.0.2.10", userAgent: "review-r4" })
    expect(answer).toMatchObject({ kind: "ok" })
    const shown = "position" in answer ? new Date(answer.position.occurredAt).getTime() : 0
    expect(shown).toBeLessThanOrEqual(Date.now() - 2 * 86_400_000)
  }, 120_000)
})
