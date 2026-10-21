import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { formatDate, formatDateTime } from "@/lib/utils"
import type { AssetTrackerDevice } from "@/lib/telematics/devices"
import { SimulatedChip } from "./SimulatedChip"
import { RegisterTrackerDevice, RemoveTrackerDevice } from "./TrackerDeviceControls"
import { VerifyMeterAction } from "./TelematicsActions"

/**
 * The asset page's "Tracker devices" card (SLICE5.md part B): every device the
 * asset has had, when each was last heard from, and whether it is the tracker
 * id recorded on the asset (information only; the payout checklist still needs
 * the tracker certificate). A real provider's device feeds no lease reading
 * until staff verify its meter against the asset's own.
 */
export function TrackerDevicesPanel(props: { assetId: string; devices: AssetTrackerDevice[]; canManage: boolean; providers: { id: string; label: string }[] }) {
  const { assetId, devices, canManage, providers } = props
  const live = devices.some((d) => d.status === "ACTIVE")
  return (
    <DataPanel title="Tracker devices" description="Polled every 15 minutes. A heartbeat never replaces the tracker certificate." density="loose">
      {devices.length === 0 ? (
        <p className="text-sm text-[var(--cf-text-muted)]">No tracker device registered.</p>
      ) : (
        <ul className="space-y-3">
          {devices.map((d) => (
            <li key={d.deviceId} className="flex flex-wrap items-center gap-2 border-b border-[var(--cf-border-subtle)] pb-3 text-sm">
              <span className="font-mono text-[var(--cf-text)]">{d.externalDeviceId}</span>
              <StatusPill tone={d.status === "ACTIVE" ? "success" : "neutral"}>{d.status === "ACTIVE" ? "Live" : "Removed"}</StatusPill>
              {d.simulated && <SimulatedChip />}
              <span className="text-[var(--cf-text-secondary)]">
                {`Installed ${formatDate(d.installedOn)}`}
                {d.removedOn && ` · removed ${formatDate(d.removedOn)}`}
                {` · last seen ${d.lastSeenAt ? formatDateTime(d.lastSeenAt) : "never"}`}
                {` · ${d.matchesTrackerId ? "matches" : "does not match"} the recorded tracker id`}
              </span>
              {d.lastPollError && d.status === "ACTIVE" && <span className="text-xs text-[var(--cf-danger)]">{d.lastPollError}</span>}
              {d.meterVerifiedAt
                ? <span className="text-xs text-[var(--cf-text-muted)]">{`Meter verified ${formatDateTime(d.meterVerifiedAt)}`}</span>
                : !d.simulated && d.status === "ACTIVE" && <span className="text-xs text-[var(--cf-text-muted)]">Meter not verified: its readings feed no lease</span>}
              {canManage && d.status === "ACTIVE" && <RemoveTrackerDevice deviceId={d.deviceId} />}
              {canManage && d.status === "ACTIVE" && !d.simulated && !d.meterVerifiedAt && <VerifyMeterAction deviceId={d.deviceId} />}
            </li>
          ))}
        </ul>
      )}
      {canManage && !live && <RegisterTrackerDevice assetId={assetId} providers={providers} />}
    </DataPanel>
  )
}
