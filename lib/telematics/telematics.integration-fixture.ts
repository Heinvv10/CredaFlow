/**
 * Real-Postgres fixture for the telematics suites (docs/asset-finance/SLICE5.md
 * part B), on the lease fixture: every asset reads 1 000 h (the simulator's
 * start), leases are booked through the real routes and moved back in time
 * (test setup only, triggers off), devices are registered through
 * lib/telematics/devices.ts and polled through lib/telematics/poll.ts.
 * Every value is synthetic. Not a test file.
 */
import { randomUUID } from "node:crypto"
import { PrismaClient, type TelematicsAlertKind } from "@prisma/client"
import { expect } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { fromDayNumber, toDayNumber } from "@/lib/asset-finance/dates"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import { approveDeal, type SetSession } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { shiftLease } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import { cleanupDealFixture, dealFixtureTenantId } from "@/lib/asset-finance/deal.integration-fixture"
import { START_HOURS } from "./__fixtures__/simulated-telematics-scenarios"
import { registerTrackerDevice } from "./devices"
import type { NormalisedTelematicsEvent } from "./types"

/**
 * The suites' client. Its errors carry the database's message only: the default
 * format quotes the calling source, so a refusal regex written beside its
 * attack (ruleRefuses) would match its own text whatever the database said.
 */
export const telematicsTestClient = () => new PrismaClient({ errorFormat: "minimal" })

export const today = () => sastCalendarDate(new Date())
export const daysAgo = (n: number) => fromDayNumber(toDayNumber(today()) - n)

export async function createTelematicsFixture(db: PrismaClient, t: string): Promise<LeaseFixture> {
  const fx = await createLeaseFixture(db, t)
  await db.financedAsset.updateMany({ where: { tenantId: fx.tenantId }, data: { hours: START_HOURS } })
  return fx
}

/** Another payout-ready excavator of the fixture's tenant. */
export async function addAsset(db: PrismaClient, fx: LeaseFixture): Promise<string> {
  const source = await db.financedAsset.findUniqueOrThrow({ where: { id: fx.assets[1] } })
  const { id: _id, createdAt: _c, updatedAt: _u, serialNumber: _s, registrationNumber: _r, trackerId: _t, ...rest } = source
  const serial = `TEST${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`
  return (await db.financedAsset.create({ data: { ...rest, serialNumber: serial, trackerId: `TRK-${serial.slice(-6)}`, registrationNumber: null } })).id
}

const staffOf = (fx: LeaseFixture, setSession: SetSession) => (id: string, role: string) =>
  setSession({ id, email: `${id}@telematics-it.test`, role, tenantId: fx.tenantId })

/** An operating lease of 1 500 h a year (start reading 1 000 h), booked and moved `daysBack` days into the past. */
export async function bookOperatingLease(db: PrismaClient, fx: LeaseFixture, setSession: SetSession, assetId: string, daysBack = 30): Promise<string> {
  const staff = staffOf(fx, setSession)
  const dealId = await approveLease(fx, staff, leaseBody(fx, {
    assetId, contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced,
    usageAllowancePerYear: 1_500, usageUnit: "HOURS", excessRateCents: 35_000,
  }))
  await signLease(fx, db, setSession, dealId)
  const loanId = await payoutAndBook(fx, db, staff, dealId)
  if (daysBack > 0) await shiftLease(db, loanId, `${daysBack} days`)
  return loanId
}

/** An instalment sale of `assetId`, booked and moved `daysBack` days into the past. */
export async function bookInstalmentSale(db: PrismaClient, fx: LeaseFixture, setSession: SetSession, assetId: string, daysBack = 30): Promise<string> {
  const staff = staffOf(fx, setSession)
  const dealId = await approveDeal(fx as never, assetId, staff, db)
  await signLease(fx, db, setSession, dealId)
  const loanId = await payoutAndBook(fx, db, staff, dealId)
  if (daysBack > 0) await shiftLease(db, loanId, `${daysBack} days`)
  return loanId
}

export const loanStartDate = async (db: PrismaClient, loanId: string) =>
  sastCalendarDate((await db.loan.findUniqueOrThrow({ where: { id: loanId }, select: { startDate: true } })).startDate)

/** Registers a simulated device on the asset, installed on `installedOn`, as the fixture's officer. */
export async function installDevice(fx: LeaseFixture, assetId: string, externalDeviceId: string, installedOn: string): Promise<string> {
  const result = await registerTrackerDevice(
    { tenantId: fx.tenantId, userId: fx.officer, userEmail: `${fx.officer}@telematics-it.test` },
    assetId, { provider: "simulated", externalDeviceId, installedOn },
  )
  expect(result, JSON.stringify(result)).toMatchObject({ kind: "ok" })
  return (result as { id: string }).id
}

/** A hand-made provider event (for cases no scenario plays). */
export function meterEvent(externalDeviceId: string, occurredAt: Date, value: number, id = randomUUID()): NormalisedTelematicsEvent {
  return { providerEventId: `it:${id}`, externalDeviceId, occurredAt, kind: "METER", meter: { value, unit: "HOURS" } }
}
export function alertEvent(externalDeviceId: string, occurredAt: Date, alert: TelematicsAlertKind, id = randomUUID()): NormalisedTelematicsEvent {
  return { providerEventId: `it:${id}`, externalDeviceId, occurredAt, kind: "ALERT", alert }
}
/** 18:00 SAST on `day`. */
export const eveningOf = (day: string) => new Date(`${day}T16:00:00.000Z`)

/** Removes the telematics rows (triggers off), then the lease and deal fixture's. */
export async function cleanupTelematicsFixture(db: PrismaClient | null, t: string): Promise<void> {
  if (!db) return
  const tenantId = dealFixtureTenantId(t)
  await db.$transaction([
    db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
    db.telematicsPositionAccess.deleteMany({ where: { tenantId } }),
    db.telematicsAlert.deleteMany({ where: { tenantId } }),
    db.telematicsHeldReading.deleteMany({ where: { tenantId } }),
    db.telematicsPosition.deleteMany({ where: { tenantId } }),
    db.assetMeterReading.deleteMany({ where: { tenantId } }),
    db.telematicsEvent.deleteMany({ where: { tenantId } }),
    db.trackerDevice.deleteMany({ where: { tenantId } }),
    db.legalMatter.deleteMany({ where: { tenantId } }),
    db.recovery.deleteMany({ where: { tenantId } }),
    db.leaseEndOfTerm.deleteMany({ where: { tenantId } }),
    db.leaseTerminationQuote.deleteMany({ where: { tenantId } }),
  ])
  await cleanupLeaseRows(db, tenantId).catch(() => undefined)
  await cleanupDealFixture(db, { tenantId })
}
