/**
 * One provider event, in the caller's transaction (docs/asset-finance/SLICE5.md
 * part B). The device row is locked first, so two sweeps over one device
 * take turns. The event row is inserted ON CONFLICT DO NOTHING on (tenant,
 * provider, provider event id): no row back means a duplicate and nothing else
 * happens, so a replayed batch or a second sweep changes nothing. Then its
 * meter reading (meter-route.ts) and, only while a running agreement on the
 * asset covers the event (telematicsLoanAt, POPIA: collection ends with the
 * agreement), its position and its alert (alerts-raise.ts). A position is
 * kept only if it is the device's latest and within retention; it replaces
 * the older one. Nothing is sent to anyone.
 */
import type { TelematicsMeterOutcome } from "@prisma/client"
import { sastCalendarDate } from "@/lib/date/sast"
import type { SigningTx } from "@/lib/asset-finance/signing-prepare"
import { raiseAlert } from "./alerts-raise"
import { routeMeterReading } from "./meter-route"
import type { NormalisedTelematicsEvent } from "./types"

export interface IngestDevice {
  id: string
  tenantId: string
  assetId: string
  provider: string
  /** Set once staff compared the device's meter with the asset's; a real provider's meter feeds the lease only then. */
  meterVerifiedAt?: Date | null
}

export interface IngestContext {
  now: Date
  simulated: boolean
  /** The tenant's TenantConfig.telematicsPositionRetentionDays. */
  retentionDays: number
}

export type IngestOutcome =
  | { stored: false }
  | { stored: true; eventId: string; positionStored: boolean; meterOutcome?: TelematicsMeterOutcome; alertId?: string }

const DAY_MS = 86_400_000
/** A position this close to the retention edge is not stored: the database's clock may already be past it. */
const EDGE_MS = 60_000

/** The running agreement whose tenure of the device's asset covers the stored event, or null (the database's own rule). */
async function loanAt(tx: SigningTx, tenantId: string, eventId: string): Promise<string | null> {
  const [row] = await tx.$queryRaw<{ loanId: string | null }[]>`
    SELECT public."telematicsLoanAt"(e."tenantId", d."assetId", e."occurredAt") AS "loanId"
    FROM "TelematicsEvent" e JOIN "TrackerDevice" d ON d."id" = e."deviceId" AND d."tenantId" = e."tenantId"
    WHERE e."id" = ${eventId} AND e."tenantId" = ${tenantId}`
  return row?.loanId ?? null
}

/** Keeps the position if it is the device's newest: the older one is deleted, a newer one wins. */
async function storePosition(tx: SigningTx, device: IngestDevice, eventId: string, event: NormalisedTelematicsEvent & { position: NonNullable<NormalisedTelematicsEvent["position"]> }) {
  const { tenantId } = device
  const current = await tx.telematicsPosition.findFirst({ where: { tenantId, deviceId: device.id }, select: { id: true, occurredAt: true } })
  if (current && current.occurredAt >= event.occurredAt) return false
  if (current) await tx.telematicsPosition.delete({ where: { id: current.id, tenantId } })
  await tx.telematicsPosition.create({
    data: {
      tenantId, eventId, deviceId: device.id, occurredAt: event.occurredAt,
      latitude: event.position.latitude, longitude: event.position.longitude, accuracyM: event.position.accuracyM,
    },
  })
  return true
}

export async function ingestEvent(tx: SigningTx, device: IngestDevice, event: NormalisedTelematicsEvent, ctx: IngestContext): Promise<IngestOutcome> {
  const { tenantId } = device
  await tx.$queryRaw`SELECT 1 FROM "TrackerDevice" WHERE "id" = ${device.id} AND "tenantId" = ${tenantId} FOR UPDATE`
  const [row] = await tx.telematicsEvent.createManyAndReturn({
    data: [{
      tenantId, deviceId: device.id, provider: device.provider, providerEventId: event.providerEventId, kind: event.kind, occurredAt: event.occurredAt,
      meterValue: event.meter?.value ?? null, meterUnit: event.meter?.unit ?? null, ignitionOn: event.ignitionOn ?? null, alertKind: event.alert ?? null,
      simulated: ctx.simulated,
    }],
    skipDuplicates: true,
    select: { id: true },
  })
  if (!row) return { stored: false }

  const loanId = event.position || event.alert ? await loanAt(tx, tenantId, row.id) : null
  const position = event.position
  const positionStored = loanId !== null && position !== undefined && event.occurredAt.getTime() >= ctx.now.getTime() - ctx.retentionDays * DAY_MS + EDGE_MS
    ? await storePosition(tx, device, row.id, { ...event, position })
    : false
  let meterOutcome: TelematicsMeterOutcome | undefined
  if (event.meter) {
    meterOutcome = await routeMeterReading(tx, { ...device, simulated: ctx.simulated }, row.id, event.meter, event.occurredAt, sastCalendarDate(ctx.now))
    await tx.telematicsEvent.update({ where: { id: row.id, tenantId }, data: { meterOutcome } })
  }
  const alertId = event.alert && loanId ? (await raiseAlert(tx, device, row.id, event.alert, event.occurredAt, loanId)).alertId : undefined
  return { stored: true, eventId: row.id, positionStored, ...(meterOutcome ? { meterOutcome } : {}), ...(alertId ? { alertId } : {}) }
}
