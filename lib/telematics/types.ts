/**
 * The tracker/telematics provider contract (docs/asset-finance/SLICE5.md part
 * B). A provider is polled with the tenant's ACTIVE devices of that provider
 * and answers the normalised events since each device's cursor. Device status
 * and heartbeat are read off the events (the newest of any kind is "last
 * seen"). No real provider is included; `providers/simulated.ts` is the only one.
 */
import type { TelematicsAlertKind, TelematicsEventKind } from "@prisma/client"

export interface NormalisedTelematicsEvent {
  /** The provider's own id; the ingest's only idempotency key, with the provider. */
  providerEventId: string
  externalDeviceId: string
  occurredAt: Date
  kind: TelematicsEventKind
  position?: { latitude: number; longitude: number; accuracyM: number | null }
  meter?: { value: number; unit: "HOURS" | "KM" }
  ignitionOn?: boolean
  alert?: TelematicsAlertKind
}

export interface TelematicsPollDevice {
  externalDeviceId: string
  /** Opaque to the caller: whatever the provider returned last time, or null. */
  cursor: string | null
  /** yyyy-mm-dd (SAST). */
  installedOn: string
}

export interface TelematicsPollResult {
  events: NormalisedTelematicsEvent[]
  /** The next cursor per device that advanced; a device absent here keeps its cursor. */
  cursors: Record<string, string>
  simulated: boolean
  simulationSource?: "simulated-telematics"
}

export interface TelematicsProvider {
  /** Registry key, stored on TrackerDevice.provider (CHECK ^[a-z0-9-]{1,40}$). */
  id: string
  label: string
  simulated: boolean
  /** Refuses a device id the provider would never answer for; null when it is acceptable. */
  deviceIdError(externalDeviceId: string): string | null
  /** Throws TelematicsProviderError NOT_CONFIGURED when it may not run in this environment. */
  assertUsable(): void
  poll(input: { devices: TelematicsPollDevice[]; now: Date }): Promise<TelematicsPollResult>
}

export type TelematicsProviderErrorCode = "NOT_CONFIGURED" | "UNAVAILABLE" | "BAD_RESPONSE"

export class TelematicsProviderError extends Error {
  constructor(readonly code: TelematicsProviderErrorCode, message: string) {
    super(message)
    this.name = "TelematicsProviderError"
  }
}
