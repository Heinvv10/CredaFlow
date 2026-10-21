/**
 * The telematics poll (cron asset-finance-telematics-poll, every 15 minutes;
 * docs/asset-finance/SLICE5.md part B). For each asset-finance tenant, in its
 * tenant frame, the ACTIVE devices on an asset under an agreement are polled
 * per provider from their cursors: a running (ACTIVE or DEFAULTED) loan, or a
 * signed deal awaiting payout (the heartbeat beside the payout checklist's
 * tracker item; without a covering loan the database stores no position and
 * raises no alert). Collection ends with the agreement. A provider error
 * marks those devices (lastPollError,
 * audited) and the sweep goes on. Each event is its own transaction
 * (ingest.ts); an event id the tenant's devices do not have is dropped and
 * counted. An event refused for what it is (event-shape.ts, or a database rule
 * its transaction broke) is skipped, counted and audited: the cursor moves
 * past it, so one bad event never wedges a device. An event still in the
 * future waits: its device keeps its cursor and the next poll takes it. Any
 * other failure keeps the cursor too and is retried next time, which the
 * idempotent ingest makes safe.
 */
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { AuditAction, logAudit } from "@/lib/audit"
import { isoOfDbDate } from "@/lib/asset-finance/dates"
import { ingestEvent } from "./ingest"
import { invalidEvent, TelematicsEventRejected } from "./event-shape"
import { getTelematicsProvider } from "./registry"
import { TelematicsProviderError, type TelematicsPollResult } from "./types"

export interface TelematicsPollRun {
  ok: boolean
  tenants: number
  devices: number
  stored: number
  duplicates: number
  /** Events refused for what they are (malformed, or a database rule): skipped, never stored, audited. */
  rejected: number
  /** Events dated after the poll's clock: left for the next poll. */
  deferred: number
  /** Events for a device id the tenant does not have under that provider. */
  unknownDevices: number
  /** Provider calls and events that failed. */
  failed: number
}

const COUNTS = ["tenants", "devices", "stored", "duplicates", "rejected", "deferred", "unknownDevices", "failed"] as const
const emptyRun = (): TelematicsPollRun => ({ ok: true, ...Object.fromEntries(COUNTS.map((key) => [key, 0])) as Omit<TelematicsPollRun, "ok"> })
const FAILED_EVENT = "An event could not be stored; it is retried on the next poll"
/** SQLSTATEs and Prisma codes of a refusal no retry can change: a rule (23514), a byte or number the column cannot hold, a unique key. */
const RULE_CODES = /\b(23514|22021|22003|22P05|P2000|P2002|P2020)\b/
/** The driver's own refusal of a number its INT4 column cannot hold (before Postgres sees it). */
const OUT_OF_RANGE = /Unable to fit integer value/

type PolledDevice = {
  id: string; tenantId: string; assetId: string; provider: string; externalDeviceId: string; installedOn: Date; pollCursor: string | null; meterVerifiedAt: Date | null
}

/** Why the event's own transaction was refused for good, or null for a failure worth retrying. */
function ruleRefusal(error: unknown): string | null {
  if (error instanceof TelematicsEventRejected) return error.reason
  const parts: string[] = []
  for (let current = error, depth = 0; depth < 5 && current instanceof Error; depth++, current = (current as { cause?: unknown }).cause) {
    parts.push(current.message, String((current as { code?: unknown }).code ?? ""), JSON.stringify((current as { meta?: unknown }).meta ?? null))
  }
  const text = parts.join("\n")
  const code = RULE_CODES.exec(text)?.[1] ?? (OUT_OF_RANGE.test(text) ? "out of range" : undefined)
  return code ? `database refused it (${code})` : null
}

/** The provider's event id as an audit row can hold it: no control characters, at most 200 characters. */
const printable = (id: string) => [...id].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? "?" : c)).join("").slice(0, 200)

async function rejectEvent(run: TelematicsPollRun, device: PolledDevice, providerEventId: string, reason: string): Promise<void> {
  run.rejected++
  await logAudit({
    tenantId: device.tenantId, action: AuditAction.TELEMATICS_EVENT_REJECTED, entity: "TrackerDevice", entityId: device.id,
    newValue: { provider: device.provider, providerEventId: printable(providerEventId), reason, actor: { type: "system", source: "telematics" } },
  })
}

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
  const waitingDevices = new Set<string>()
  const simulated = result.simulated || provider?.simulated === true
  for (const event of result.events) {
    const device = byExternalId.get(event.externalDeviceId)
    if (!device) {
      run.unknownDevices++
      continue
    }
    if (failedDevices.has(device.id) || waitingDevices.has(device.id)) continue
    const invalid = invalidEvent(event, { installedOn: isoOfDbDate(device.installedOn), now })
    if (invalid) {
      await rejectEvent(run, device, event.providerEventId, invalid)
      continue
    }
    if (event.occurredAt > now) {
      run.deferred++
      waitingDevices.add(device.id)
      continue
    }
    try {
      const outcome = await prisma.$transaction((tx) => ingestEvent(tx, device, event, { now, simulated, retentionDays }))
      if (outcome.stored) run.stored++
      else run.duplicates++
    } catch (error) {
      const refusal = ruleRefusal(error)
      if (refusal) {
        await rejectEvent(run, device, event.providerEventId, refusal)
        continue
      }
      run.failed++
      failedDevices.add(device.id)
      console.error("[telematics-poll] event failed", { tenantId, deviceId: device.id, providerEventId: printable(event.providerEventId), error: error instanceof Error ? error.message : "unknown" })
    }
  }
  for (const device of devices) {
    const cursor = result.cursors[device.externalDeviceId]
    await prisma.trackerDevice.updateMany({
      where: { id: device.id, tenantId, status: "ACTIVE" },
      data: failedDevices.has(device.id)
        ? { lastPolledAt: now, lastPollError: FAILED_EVENT }
        : { lastPolledAt: now, lastPollError: null, ...(cursor && !waitingDevices.has(device.id) ? { pollCursor: cursor } : {}) },
    })
  }
}

/** One tenant's ACTIVE devices on an asset under an agreement (a running loan, or a signed deal awaiting payout), in its tenant frame. */
export async function pollTenant(tenantId: string, now: Date): Promise<TelematicsPollRun> {
  return runWithTenant(tenantId, async () => {
    const run = emptyRun()
    run.tenants = 1
    const config = await prisma.tenantConfig.findUnique({ where: { tenantId }, select: { telematicsPositionRetentionDays: true } })
    const devices = await prisma.trackerDevice.findMany({
      where: {
        tenantId, status: "ACTIVE",
        OR: [{ asset: { loans: { some: { tenantId, status: { in: ["ACTIVE", "DEFAULTED"] } } } } }, { asset: { deals: { some: { tenantId, status: "CONTRACTED" } } } }],
      },
      orderBy: { id: "asc" },
      select: { id: true, tenantId: true, assetId: true, provider: true, externalDeviceId: true, installedOn: true, pollCursor: true, meterVerifiedAt: true },
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
      for (const key of COUNTS) run[key] += one[key]
    } catch (error) {
      run.tenants++
      run.failed++
      console.error("[telematics-poll] tenant failed", { tenantId, error: error instanceof Error ? error.name : "unknown" })
    }
  }
  run.ok = run.failed === 0
  return run
}
