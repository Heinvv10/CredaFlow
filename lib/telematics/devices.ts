/**
 * Tracker devices on financed assets (docs/asset-finance/SLICE5.md part B):
 * registered by staff under a registered provider (manage_asset_finance),
 * removed once, never deleted (guardTrackerDevice). A real provider's device
 * feeds meter readings only once staff verified its meter against the
 * asset's own, with a note (set once, audited). The heartbeat is shown
 * beside the payout checklist's tracker item as information only: the item
 * still needs the staff-uploaded certificate, and FinancedAsset.trackerId
 * stays its source.
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { dbDate, isoOfDbDate, toDayNumber } from "@/lib/asset-finance/dates"
import { getTelematicsProvider, registeredTelematicsProviderIds } from "./registry"
import { hasControlCharacter } from "./event-shape"
import { noteOf, objectBody, refused, type TelematicsActor, type TelematicsResult } from "./result"

export interface TrackerHeartbeat {
  deviceId: string
  provider: string
  externalDeviceId: string
  simulated: boolean
  /** The newest event of any kind, or null before the first poll. */
  lastSeenAt: Date | null
  /** Information only: whether the device id is the asset's recorded tracker id. */
  matchesTrackerId: boolean
}

function calendarDate(value: unknown): string | null {
  if (typeof value !== "string") return null
  try {
    toDayNumber(value)
    return value
  } catch {
    return null
  }
}

const sameId = (a: string | null, b: string) => (a ?? "").trim().toUpperCase() === b.trim().toUpperCase()

export async function registerTrackerDevice(actor: TelematicsActor, assetId: string, body: unknown): Promise<TelematicsResult<{ id: string }>> {
  const input = objectBody(body)
  if (!input) return refused(400, "Expected a JSON object")
  const fields: Record<string, string> = {}
  const provider = typeof input.provider === "string" ? getTelematicsProvider(input.provider.trim()) : null
  if (!provider) fields.provider = `Choose a registered tracker provider (${registeredTelematicsProviderIds().join(", ")})`
  const externalDeviceId = typeof input.externalDeviceId === "string" ? input.externalDeviceId.trim() : ""
  const deviceIdError = externalDeviceId.length < 1 || externalDeviceId.length > 100 ? "The device id is 1 to 100 characters"
    : hasControlCharacter(externalDeviceId) ? "The device id cannot hold control characters" : provider?.deviceIdError(externalDeviceId)
  if (deviceIdError) fields.externalDeviceId = deviceIdError
  const installedOn = calendarDate(input.installedOn)
  if (!installedOn) fields.installedOn = "The installation date is a calendar date YYYY-MM-DD"
  else if (installedOn > sastCalendarDate(new Date())) fields.installedOn = "A tracker cannot be installed after today"
  if (!provider || !installedOn || Object.keys(fields).length > 0) return refused(422, "The tracker device is not valid", fields)
  try {
    provider.assertUsable()
  } catch (error) {
    const message = error instanceof Error ? error.message : "This provider may not be used here"
    return refused(422, message, { provider: message })
  }
  const asset = await prisma.financedAsset.findFirst({ where: { id: assetId, tenantId: actor.tenantId }, select: { id: true } })
  if (!asset) return refused(404, "Asset not found")
  try {
    return await prisma.$transaction(async (tx) => {
      const device = await tx.trackerDevice.create({
        data: { tenantId: actor.tenantId, assetId, provider: provider.id, externalDeviceId, installedOn: dbDate(installedOn), createdById: actor.userId },
        select: { id: true },
      })
      await logAuditStrict({
        tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail, action: AuditAction.TRACKER_DEVICE_REGISTERED,
        entity: "TrackerDevice", entityId: device.id, newValue: { assetId, provider: provider.id, externalDeviceId, installedOn, simulated: provider.simulated },
      }, tx)
      return { kind: "ok" as const, id: device.id }
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return refused(409, "The asset already has a live tracker, or that device is live on another asset")
    }
    throw error
  }
}

export async function removeTrackerDevice(actor: TelematicsActor, deviceId: string, body: unknown): Promise<TelematicsResult> {
  const input = objectBody(body) ?? {}
  const today = sastCalendarDate(new Date())
  const removedOn = input.removedOn === undefined ? today : calendarDate(input.removedOn)
  if (!removedOn) return refused(422, "The removal date is a calendar date YYYY-MM-DD", { removedOn: "Use YYYY-MM-DD" })
  const device = await prisma.trackerDevice.findFirst({ where: { id: deviceId, tenantId: actor.tenantId }, select: { status: true, installedOn: true } })
  if (!device) return refused(404, "Tracker device not found")
  if (device.status !== "ACTIVE") return refused(409, "This tracker device is already removed")
  if (removedOn > today || removedOn < isoOfDbDate(device.installedOn)) {
    return refused(422, "A tracker is removed on a day between its installation and today", { removedOn: "Between the installation date and today" })
  }
  return prisma.$transaction(async (tx) => {
    const done = await tx.trackerDevice.updateMany({
      where: { id: deviceId, tenantId: actor.tenantId, status: "ACTIVE" },
      data: { status: "REMOVED", removedOn: dbDate(removedOn), removedById: actor.userId },
    })
    if (done.count !== 1) return refused(409, "This tracker device is already removed")
    await logAuditStrict({
      tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail, action: AuditAction.TRACKER_DEVICE_REMOVED,
      entity: "TrackerDevice", entityId: deviceId, newValue: { removedOn },
    }, tx)
    return { kind: "ok" as const }
  })
}

/** Records that staff compared the device's meter with the asset's own (once; a note of 3 to 500 characters). */
export async function verifyTrackerMeter(actor: TelematicsActor, deviceId: string, body: unknown): Promise<TelematicsResult> {
  const note = noteOf(objectBody(body)?.note)
  if (!note) return refused(400, "Say how the device's meter was compared with the asset's (3 to 500 characters)", { note: "3 to 500 characters" })
  const device = await prisma.trackerDevice.findFirst({ where: { id: deviceId, tenantId: actor.tenantId }, select: { id: true } })
  if (!device) return refused(404, "Tracker device not found")
  return prisma.$transaction(async (tx) => {
    const done = await tx.trackerDevice.updateMany({
      where: { id: deviceId, tenantId: actor.tenantId, status: "ACTIVE", meterVerifiedAt: null },
      data: { meterVerifiedAt: new Date(), meterVerifiedById: actor.userId, meterVerifiedNote: note },
    })
    if (done.count !== 1) return refused(409, "Only a live device whose meter is not yet verified can be verified")
    await logAuditStrict({
      tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail, action: AuditAction.TRACKER_METER_VERIFIED,
      entity: "TrackerDevice", entityId: deviceId, newValue: { note },
    }, tx)
    return { kind: "ok" as const }
  })
}

async function heartbeatOf(tenantId: string, device: { id: string; provider: string; externalDeviceId: string }, trackerId: string | null): Promise<TrackerHeartbeat> {
  const last = await prisma.telematicsEvent.findFirst({
    where: { tenantId, deviceId: device.id }, orderBy: { occurredAt: "desc" }, select: { occurredAt: true, simulated: true },
  })
  return {
    deviceId: device.id, provider: device.provider, externalDeviceId: device.externalDeviceId,
    simulated: last?.simulated ?? getTelematicsProvider(device.provider)?.simulated ?? false,
    lastSeenAt: last?.occurredAt ?? null, matchesTrackerId: sameId(trackerId, device.externalDeviceId),
  }
}

/** The asset's live device and when it was last heard from, or null without one. */
export async function trackerHeartbeat(tenantId: string, assetId: string): Promise<TrackerHeartbeat | null> {
  const asset = await prisma.financedAsset.findFirst({
    where: { id: assetId, tenantId },
    select: { trackerId: true, trackerDevices: { where: { status: "ACTIVE" }, select: { id: true, provider: true, externalDeviceId: true } } },
  })
  const device = asset?.trackerDevices[0]
  return device ? heartbeatOf(tenantId, device, asset.trackerId) : null
}

export interface AssetTrackerDevice extends TrackerHeartbeat {
  status: "ACTIVE" | "REMOVED"
  installedOn: string
  removedOn: string | null
  lastPollError: string | null
  meterVerifiedAt: Date | null
  /** Who verified the meter (name, else email) and what they compared. */
  meterVerifiedBy: string | null
  meterVerifiedNote: string | null
}

/** Every device the asset has had, newest first, for the asset page's card. */
export async function assetTrackerDevices(tenantId: string, assetId: string): Promise<AssetTrackerDevice[]> {
  const asset = await prisma.financedAsset.findFirst({
    where: { id: assetId, tenantId },
    select: {
      trackerId: true,
      trackerDevices: {
        orderBy: { createdAt: "desc" },
        select: { id: true, provider: true, externalDeviceId: true, status: true, installedOn: true, removedOn: true, lastPollError: true, meterVerifiedAt: true,
          meterVerifiedNote: true, meterVerifiedBy: { select: { name: true, email: true } },
        },
      },
    },
  })
  if (!asset) return []
  return Promise.all(asset.trackerDevices.map(async (device) => ({
    ...(await heartbeatOf(tenantId, device, asset.trackerId)),
    status: device.status, installedOn: isoOfDbDate(device.installedOn), removedOn: device.removedOn ? isoOfDbDate(device.removedOn) : null, lastPollError: device.lastPollError,
    meterVerifiedAt: device.meterVerifiedAt, meterVerifiedBy: device.meterVerifiedBy ? device.meterVerifiedBy.name ?? device.meterVerifiedBy.email : null,
    meterVerifiedNote: device.meterVerifiedNote,
  })))
}
