/**
 * One provider event, in the caller's transaction (docs/asset-finance/SLICE5.md
 * part B). The device row is locked first, so two sweeps over one device
 * take turns. With no agreement covering the event (telematicsLoanAt: before
 * payout, after the agreement; POPIA: collection ends with the agreement) only
 * a heartbeat is kept; anything else is not stored. The event row is inserted
 * ON CONFLICT DO NOTHING (event-insert.ts): no row back means a duplicate and
 * nothing else happens, so a replayed batch or a second sweep changes nothing.
 * Then its meter reading (meter-route.ts) and, under that agreement, its
 * position and its alert (alerts-raise.ts). Every position inside a tenure and
 * within retention is kept (the trail); the purge removes them by age.
 * Nothing is sent to anyone.
 */
import type { TelematicsMeterOutcome } from "@prisma/client"
import { sastCalendarDate } from "@/lib/date/sast"
import type { SigningTx } from "@/lib/asset-finance/signing-prepare"
import { raiseAlert } from "./alerts-raise"
import { routeMeterReading } from "./meter-route"
import { insertEvent, loanCovering } from "./event-insert"
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
  | { stored: false; noAgreement?: true }
  | { stored: true; eventId: string; positionStored: boolean; meterOutcome?: TelematicsMeterOutcome; alertId?: string }

const DAY_MS = 86_400_000
/** A position this close to the retention edge is not stored: the database's clock may already be past it. */
const EDGE_MS = 60_000

/** Appends the position: every one inside a tenure and retention is kept (the trail); the purge removes them by age. */
async function storePosition(tx: SigningTx, device: IngestDevice, eventId: string, event: NormalisedTelematicsEvent & { position: NonNullable<NormalisedTelematicsEvent["position"]> }) {
  await tx.telematicsPosition.create({
    data: {
      tenantId: device.tenantId, eventId, deviceId: device.id, occurredAt: event.occurredAt,
      latitude: event.position.latitude, longitude: event.position.longitude, accuracyM: event.position.accuracyM,
    },
  })
  return true
}

export async function ingestEvent(tx: SigningTx, device: IngestDevice, event: NormalisedTelematicsEvent, ctx: IngestContext): Promise<IngestOutcome> {
  const { tenantId } = device
  await tx.$queryRaw`SELECT 1 FROM "TrackerDevice" WHERE "id" = ${device.id} AND "tenantId" = ${tenantId} FOR UPDATE`
  const loanId = await loanCovering(tx, tenantId, device.assetId, event.occurredAt)
  // No agreement covers it (before payout, after the agreement): only a heartbeat is kept.
  if (!loanId && event.kind !== "HEARTBEAT") return { stored: false, noAgreement: true }
  const eventId = await insertEvent(tx, device, event, ctx.simulated)
  if (!eventId) return { stored: false }

  const position = event.position
  const positionStored = loanId !== null && position !== undefined && event.occurredAt.getTime() >= ctx.now.getTime() - ctx.retentionDays * DAY_MS + EDGE_MS
    ? await storePosition(tx, device, eventId, { ...event, position })
    : false
  let meterOutcome: TelematicsMeterOutcome | undefined
  if (event.meter) {
    meterOutcome = await routeMeterReading(tx, { ...device, simulated: ctx.simulated }, eventId, event.meter, event.occurredAt, sastCalendarDate(ctx.now))
    await tx.telematicsEvent.update({ where: { id: eventId, tenantId }, data: { meterOutcome } })
  }
  const alertId = event.alert && loanId ? (await raiseAlert(tx, device, eventId, event.alert, event.occurredAt, loanId)).alertId : undefined
  return { stored: true, eventId, positionStored, ...(meterOutcome ? { meterOutcome } : {}), ...(alertId ? { alertId } : {}) }
}
