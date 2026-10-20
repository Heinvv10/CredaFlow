/**
 * One provider event, in the caller's transaction (docs/asset-finance/SLICE5.md
 * part B). The event row is inserted ON CONFLICT DO NOTHING on (tenant,
 * provider, provider event id): no row back means a duplicate and nothing else
 * happens, so a replayed batch or a second sweep changes nothing. Then its
 * position (unless already past retention), its meter reading (meter-route.ts)
 * and its alert (alerts-raise.ts). Nothing is sent to anyone.
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

export async function ingestEvent(tx: SigningTx, device: IngestDevice, event: NormalisedTelematicsEvent, ctx: IngestContext): Promise<IngestOutcome> {
  const { tenantId } = device
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

  let positionStored = false
  if (event.position && event.occurredAt.getTime() >= ctx.now.getTime() - ctx.retentionDays * DAY_MS + EDGE_MS) {
    await tx.telematicsPosition.create({
      data: {
        tenantId, eventId: row.id, deviceId: device.id, occurredAt: event.occurredAt,
        latitude: event.position.latitude, longitude: event.position.longitude, accuracyM: event.position.accuracyM,
      },
    })
    positionStored = true
  }
  let meterOutcome: TelematicsMeterOutcome | undefined
  if (event.meter) {
    meterOutcome = await routeMeterReading(tx, device, row.id, event.meter, event.occurredAt, sastCalendarDate(ctx.now))
    await tx.telematicsEvent.update({ where: { id: row.id, tenantId }, data: { meterOutcome } })
  }
  const alertId = event.alert ? (await raiseAlert(tx, device, row.id, event.alert, event.occurredAt)).alertId : undefined
  return { stored: true, eventId: row.id, positionStored, ...(meterOutcome ? { meterOutcome } : {}), ...(alertId ? { alertId } : {}) }
}
