/**
 * Review round 3 repro for PR #222: the asset's lessor status alone never
 * ends a tenure (telematicsLoanAt reads the loan's own dated records). A stale
 * status from an earlier lease, or one dated after the event, does not stop
 * collection.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/lessor-status-bounds.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { testSetup } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { prisma } from "@/lib/prisma"
import { ingestEvent } from "./ingest"
import { bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, installDevice, telematicsTestClient } from "./telematics.integration-fixture"
import type { NormalisedTelematicsEvent } from "./types"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
let deviceId = ""
const database = (): PrismaClient => { if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required"); return db }
const setSession = (user: SessionUser | null) => { session.current = user && { user } }

const position = (n: number): NormalisedTelematicsEvent => ({
  providerEventId: `lsb-${t}-${n}`, externalDeviceId: "SIM-STEADY-9", occurredAt: new Date(Date.now() - 60_000 * n), kind: "POSITION",
  position: { latitude: -26.1, longitude: 28.1, accuracyM: 5 },
})
const ingest = (n: number) => prisma.$transaction((tx) => ingestEvent(tx,
  { id: deviceId, tenantId: fx.tenantId, assetId: fx.assets[1], provider: "simulated" }, position(n), { now: new Date(), simulated: true, retentionDays: 90 }))

suite.sequential("telematicsLoanAt: lessor status bounds (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
    await bookOperatingLease(database(), fx, setSession, fx.assets[1])
    deviceId = await installDevice(fx, fx.assets[1], "SIM-STEADY-9", daysAgo(30))
  }, 600_000)

  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("a lessor status from before the loan began (an earlier lease) does not stop collection", async () => {
    await testSetup(database(), [`UPDATE "FinancedAsset" SET "lessorStatus" = 'RETURNED_TO_STOCK', "lessorStatusAt" = now() - INTERVAL '400 days' WHERE "id" = $1`, fx.assets[1]])
    expect(await ingest(1)).toMatchObject({ stored: true, positionStored: true })
  }, 120_000)

  it("a lessor status dated after the event does not end the tenure at that event", async () => {
    await testSetup(database(), [`UPDATE "FinancedAsset" SET "lessorStatus" = 'RETURNED_TO_STOCK', "lessorStatusAt" = now() + INTERVAL '2 days' WHERE "id" = $1`, fx.assets[1]])
    expect(await ingest(-1)).toMatchObject({ stored: true, positionStored: true })
  }, 120_000)
})
