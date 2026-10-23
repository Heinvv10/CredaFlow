/**
 * The telematics poll (cron asset-finance-telematics-poll, every 15 minutes;
 * docs/asset-finance/SLICE5.md part B). For each asset-finance tenant, in its
 * tenant frame, the ACTIVE devices on an asset under an agreement are polled
 * per provider from their cursors: a loan whose tenure covers now
 * (telematicsLoanAt: running, in default or pending write-off, the asset still
 * in the lessee's hands), or a deal awaiting payout (PRE_BOOKING: approved or
 * contracted; the heartbeat beside the payout checklist's tracker item, and
 * nothing else is kept before booking). A provider error marks those devices
 * (lastPollError, audited) and the sweep goes on. Each event is its own
 * transaction (ingest.ts); an event id the tenant's devices do not have is
 * dropped and counted. An event refused for what it is (event-shape.ts, or
 * the database refusing the event row itself, event-insert.ts) is skipped,
 * counted and audited, and the cursor moves past it. An event still in the
 * future waits, by the poll's clock or the database's (SQLSTATE 55000). Any
 * other failure keeps the cursor and is retried next time, which the
 * idempotent ingest makes safe. A passing fault on an explicit list (a lost
 * connection, a pool or transaction timeout, a deadlock, a serialisation
 * failure, a lock timeout) is retried for as long as it lasts. Anything else
 * (a refusal no rule names, an unknown error) counts a strike: three polls in
 * a row on the same event skip it, audited with that reason, so nothing
 * wedges a device for good. Every class is read from structured
 * fields (the error's class, Prisma code, SQLSTATE), never its message.
 * Whether events are simulated is the registered provider's own definition,
 * never the provider's answer.
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { AuditAction, logAudit } from "@/lib/audit"
import { isoOfDbDate } from "@/lib/asset-finance/dates"
import { ingestEvent } from "./ingest"
import { invalidEvent, TelematicsEventNotYet, TelematicsEventRejected } from "./event-shape"
import { getTelematicsProvider } from "./registry"
import { TelematicsProviderError, type TelematicsPollResult } from "./types"

export interface TelematicsPollRun {
  ok: boolean
  tenants: number
  devices: number
  stored: number
  duplicates: number
  /** Events refused for what they are, or failing three polls in a row: skipped, never stored, audited. */
  rejected: number
  /** Events no agreement covers (before payout, after the agreement) that are not heartbeats: not kept. */
  notKept: number
  /** Events dated after the poll's clock: left for the next poll. */
  deferred: number
  /** Events for a device id the tenant does not have under that provider. */
  unknownDevices: number
  /** Provider calls and events that failed. */
  failed: number
}

const COUNTS = ["tenants", "devices", "stored", "duplicates", "rejected", "notKept", "deferred", "unknownDevices", "failed"] as const
const emptyRun = (): TelematicsPollRun => ({ ok: true, ...Object.fromEntries(COUNTS.map((key) => [key, 0])) as Omit<TelematicsPollRun, "ok"> })
const FAILED_EVENT = "An event could not be stored; it is retried on the next poll"
/** The polls in a row one event may fail on before it is skipped. */
export const MAX_EVENT_ATTEMPTS = 3

/** A deal awaiting payout: approved or contracted (signed), not yet booked. Any other status (cancelled, declined, refused, draft) is not polled. */
export const PRE_BOOKING_DEAL_STATUSES = ["APPROVED", "CONTRACTED"] as const

type PolledDevice = {
  id: string; tenantId: string; assetId: string; provider: string; externalDeviceId: string; installedOn: Date; pollCursor: string | null; meterVerifiedAt: Date | null
  failingEventId: string | null; failingEventCount: number
}

/** Prisma codes of a passing fault: the database unreachable or gone away, a pool timeout, a transaction conflict or timeout. */
const TRANSIENT_PRISMA: ReadonlySet<string> = new Set(["P1001", "P1002", "P1017", "P2024", "P2028", "P2034"])
/** SQLSTATEs of a passing fault in a raw statement: serialisation failure, deadlock, lock not available, statement cancelled. */
const TRANSIENT_SQLSTATE: ReadonlySet<string> = new Set(["40001", "40P01", "55P03", "57014"])

/** The driver's PostgresError code field, the only SQLSTATE Prisma gives for a query's failure it does not map (an ORM deadlock). */
const DRIVER_SQLSTATE = /PostgresError \{ code: "([0-9A-Z]{5})"/

/**
 * The SQLSTATE behind a failure, where Prisma exposes it: a raw statement's
 * `meta.code`, or the driver's PostgresError code field in an unmapped
 * request error's message (that field only, never a number elsewhere in the
 * text), down the `cause` chain.
 */
function sqlStateOf(error: unknown): string | null {
  for (let current = error, depth = 0; depth < 5 && current instanceof Error; depth++, current = (current as { cause?: unknown }).cause) {
    const code = (current as { meta?: { code?: unknown } }).meta?.code
    if (current instanceof Prisma.PrismaClientKnownRequestError && current.code === "P2010" && typeof code === "string") return code
    if (current instanceof Prisma.PrismaClientUnknownRequestError) return DRIVER_SQLSTATE.exec(current.message)?.[1] ?? null
  }
  return null
}

/**
 * Whether a failure is a passing fault, retried for as long as it lasts and
 * never a strike: only the explicit allow-list above, read from structured
 * fields (the Prisma code, the SQLSTATE), and a client that could not reach
 * or stay connected to the database. Everything else, an unknown refusal or
 * an unknown error alike (a TypeError on a malformed payload never goes
 * away), counts a strike toward the skip.
 */
function isTransient(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code !== "P2010") return TRANSIENT_PRISMA.has(error.code)
  const sqlState = sqlStateOf(error)
  return sqlState !== null && TRANSIENT_SQLSTATE.has(sqlState)
}

/** A failure's structured kind for the audit: the Prisma code (and SQLSTATE of a raw statement), or the error's class. Never its message. */
function failureKind(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const sqlState = (error.meta as { code?: unknown } | undefined)?.code
    return typeof sqlState === "string" ? `${error.code} ${sqlState}` : error.code
  }
  return error instanceof Error ? error.name : "unknown"
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
  /** Devices whose event failed this poll: with the strike to record, or null for a passing fault (the count stands). */
  const failedDevices = new Map<string, { eventId: string; count: number } | null>()
  const waitingDevices = new Set<string>()
  const simulated = provider.simulated
  for (const event of result.events) {
    const device = byExternalId.get(event.externalDeviceId)
    if (!device) {
      run.unknownDevices++
      continue
    }
    if (failedDevices.has(device.id) || waitingDevices.has(device.id)) continue
    const invalid = invalidEvent(event, { installedOn: isoOfDbDate(device.installedOn), now, retentionDays })
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
      else if (outcome.noAgreement) run.notKept++
      else run.duplicates++
    } catch (error) {
      if (error instanceof TelematicsEventRejected) {
        await rejectEvent(run, device, event.providerEventId, error.reason)
        continue
      }
      if (error instanceof TelematicsEventNotYet) {
        run.deferred++
        waitingDevices.add(device.id)
        continue
      }
      if (isTransient(error)) {
        run.failed++
        failedDevices.set(device.id, null)
        console.error("[telematics-poll] event failed, retried", { tenantId, deviceId: device.id, providerEventId: printable(event.providerEventId), error: failureKind(error) })
        continue
      }
      const count = device.failingEventId === event.providerEventId ? device.failingEventCount + 1 : 1
      if (count >= MAX_EVENT_ATTEMPTS) {
        await rejectEvent(run, device, event.providerEventId, `failed ${count} polls in a row (${failureKind(error)})`)
        continue
      }
      run.failed++
      failedDevices.set(device.id, { eventId: event.providerEventId, count })
      console.error("[telematics-poll] event failed", { tenantId, deviceId: device.id, providerEventId: printable(event.providerEventId), error: failureKind(error) })
    }
  }
  for (const device of devices) {
    const cursor = result.cursors[device.externalDeviceId]
    const failing = failedDevices.get(device.id)
    await prisma.trackerDevice.updateMany({
      where: { id: device.id, tenantId, status: "ACTIVE" },
      data: failedDevices.has(device.id)
        ? { lastPolledAt: now, lastPollError: FAILED_EVENT, ...(failing ? { failingEventId: failing.eventId, failingEventCount: failing.count } : {}) }
        : {
          lastPolledAt: now, lastPollError: null, failingEventId: null, failingEventCount: 0,
          ...(cursor && !waitingDevices.has(device.id) ? { pollCursor: cursor } : {}),
        },
    })
  }
}

/** One tenant's ACTIVE devices on an asset under an agreement (a loan covering now, or a deal awaiting payout), in its tenant frame. */
export async function pollTenant(tenantId: string, now: Date): Promise<TelematicsPollRun> {
  return runWithTenant(tenantId, async () => {
    const run = emptyRun()
    run.tenants = 1
    const config = await prisma.tenantConfig.findUnique({ where: { tenantId }, select: { telematicsPositionRetentionDays: true } })
    const underAgreement = await prisma.$queryRaw<{ id: string }[]>`
      SELECT d."id" FROM "TrackerDevice" d
      WHERE d."tenantId" = ${tenantId} AND d."status" = 'ACTIVE'
        AND (public."telematicsLoanAt"(d."tenantId", d."assetId", (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')) IS NOT NULL
          OR EXISTS (SELECT 1 FROM "AssetFinanceDeal" x WHERE x."tenantId" = d."tenantId" AND x."assetId" = d."assetId"
            AND x."status"::text IN (${Prisma.join([...PRE_BOOKING_DEAL_STATUSES])})))`
    const devices = await prisma.trackerDevice.findMany({
      where: { tenantId, status: "ACTIVE", id: { in: underAgreement.map((d) => d.id) } },
      orderBy: { id: "asc" },
      select: {
        id: true, tenantId: true, assetId: true, provider: true, externalDeviceId: true, installedOn: true, pollCursor: true, meterVerifiedAt: true,
        failingEventId: true, failingEventCount: true,
      },
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
