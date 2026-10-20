/**
 * The telematics poll (cron asset-finance-telematics-poll, every 15 minutes;
 * docs/asset-finance/SLICE5.md part B). For each asset-finance tenant, in its
 * tenant frame, the ACTIVE devices are polled per provider from their
 * cursors. A provider error marks those devices (lastPollError, audited) and
 * the sweep goes on. Each event is its own transaction (ingest.ts); an event
 * id the tenant's devices do not have is dropped and counted. A device's
 * cursor moves on only when every one of its events was stored: a failed
 * event is retried next time, which the idempotent ingest makes safe.
 */
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { AuditAction, logAudit } from "@/lib/audit"
import { isoOfDbDate } from "@/lib/asset-finance/dates"
import { ingestEvent } from "./ingest"
import { invalidEvent } from "./event-shape"
import { getTelematicsProvider } from "./registry"
import { TelematicsProviderError, type TelematicsPollResult } from "./types"

export interface TelematicsPollRun {
  ok: boolean
  tenants: number
  devices: number
  stored: number
  duplicates: number
  /** Events the provider sent malformed: skipped, never stored. */
  rejected: number
  /** Events for a device id the tenant does not have under that provider. */
  unknownDevices: number
  /** Provider calls and events that failed. */
  failed: number
}

const emptyRun = (): TelematicsPollRun => ({ ok: true, tenants: 0, devices: 0, stored: 0, duplicates: 0, rejected: 0, unknownDevices: 0, failed: 0 })
const FAILED_EVENT = "An event could not be stored; it is retried on the next poll"

type PolledDevice = { id: string; tenantId: string; assetId: string; provider: string; externalDeviceId: string; installedOn: Date; pollCursor: string | null }

async function pollProvider(tenantId: string, providerId: string, devices: PolledDevice[], now: Date, retentionDays: number, run: TelematicsPollRun): Promise<void> {
  const ids = devices.map((d) => d.id)
  let result: TelematicsPollResult
  const provider = getTelematicsProvider(providerId)
  try {
    if (!provider) throw new TelematicsProviderError("NOT_CONFIGURED", `Tracker provider "${providerId}" is not registered`)
    result = await provider.poll({ devices: devices.map((d) => ({ externalDeviceId: d.externalDeviceId, cursor: d.pollCursor, installedOn: isoOfDbDate(d.installedOn) })), now })
  } catch (error) {
    const message = (error instanceof TelematicsProviderError ? `${error.code}: ${error.message}` : "UNAVAILABLE: the provider call failed").slice(0, 500)
    run.failed++
    await prisma.trackerDevice.updateMany({ where: { tenantId, id: { in: ids }, status: "ACTIVE" }, data: { lastPollError: message } })
    await logAudit({ tenantId, action: AuditAction.TELEMATICS_POLL_FAILED, entity: "TrackerDevice", newValue: { provider: providerId, deviceIds: ids, error: message } })
    console.error("[telematics-poll] provider failed", { tenantId, provider: providerId, error: message })
    return
  }
  const byExternalId = new Map(devices.map((d) => [d.externalDeviceId, d]))
  const failedDevices = new Set<string>()
  const simulated = result.simulated || provider?.simulated === true
  for (const event of result.events) {
    const device = byExternalId.get(event.externalDeviceId)
    if (!device) {
      run.unknownDevices++
      continue
    }
    if (failedDevices.has(device.id)) continue
    if (invalidEvent(event)) {
      run.rejected++
      continue
    }
    try {
      const outcome = await prisma.$transaction((tx) => ingestEvent(tx, device, event, { now, simulated, retentionDays }))
      if (outcome.stored) run.stored++
      else run.duplicates++
    } catch (error) {
      run.failed++
      failedDevices.add(device.id)
      console.error("[telematics-poll] event failed", { tenantId, deviceId: device.id, providerEventId: event.providerEventId, error: error instanceof Error ? error.message : "unknown" })
    }
  }
  for (const device of devices) {
    const cursor = result.cursors[device.externalDeviceId]
    await prisma.trackerDevice.updateMany({
      where: { id: device.id, tenantId, status: "ACTIVE" },
      data: failedDevices.has(device.id)
        ? { lastPolledAt: now, lastPollError: FAILED_EVENT }
        : { lastPolledAt: now, lastPollError: null, ...(cursor ? { pollCursor: cursor } : {}) },
    })
  }
}

/** One tenant's ACTIVE devices, in its tenant frame. */
export async function pollTenant(tenantId: string, now: Date): Promise<TelematicsPollRun> {
  return runWithTenant(tenantId, async () => {
    const run = emptyRun()
    run.tenants = 1
    const config = await prisma.tenantConfig.findUnique({ where: { tenantId }, select: { telematicsPositionRetentionDays: true } })
    const devices = await prisma.trackerDevice.findMany({
      where: { tenantId, status: "ACTIVE" }, orderBy: { id: "asc" },
      select: { id: true, tenantId: true, assetId: true, provider: true, externalDeviceId: true, installedOn: true, pollCursor: true },
    })
    run.devices = devices.length
    const byProvider = new Map<string, PolledDevice[]>()
    for (const device of devices) byProvider.set(device.provider, [...(byProvider.get(device.provider) ?? []), device])
    for (const [providerId, group] of byProvider) {
      await pollProvider(tenantId, providerId, group, now, config?.telematicsPositionRetentionDays ?? 90, run)
    }
    run.ok = run.failed === 0
    return run
  })
}

export async function runTelematicsPoll(now: Date = new Date()): Promise<TelematicsPollRun> {
  const run = emptyRun()
  const tenants = await prisma.tenantConfig.findMany({ where: { featureAssetFinance: true }, orderBy: { tenantId: "asc" }, select: { tenantId: true } })
  for (const { tenantId } of tenants) {
    try {
      const one = await pollTenant(tenantId, now)
      for (const key of ["tenants", "devices", "stored", "duplicates", "rejected", "unknownDevices", "failed"] as const) run[key] += one[key]
    } catch (error) {
      run.tenants++
      run.failed++
      console.error("[telematics-poll] tenant failed", { tenantId, error: error instanceof Error ? error.name : "unknown" })
    }
  }
  run.ok = run.failed === 0
  return run
}
