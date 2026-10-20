import Link from "next/link"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { prisma } from "@/lib/prisma"
import { formatDateTime } from "@/lib/utils"
import { trackerHeartbeat } from "@/lib/telematics/devices"
import { listAlerts } from "@/lib/telematics/alerts"
import { listHeldReadings } from "@/lib/telematics/held-readings"
import { SimulatedChip } from "./SimulatedChip"
import { AlertsTable, HeldReadingsTable } from "./TelematicsTables"

const subheading = "mb-2 mt-4 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--cf-text-muted)]"

/**
 * The staff loan page's tracker panel (SLICE5.md part B): the asset's device
 * and heartbeat, the loan's open alerts (work_telematics_alerts) and its held
 * readings (manage_asset_finance). Never a position: that is the logged
 * "Show last known position" in the Recovery and Legal matter panels. The
 * TELEMATICS readings themselves are in the lease's readings table.
 */
export async function TelematicsPanel({ tenantId, loanId, canManage, canWork }: { tenantId: string; loanId: string; canManage: boolean; canWork: boolean }) {
  const loan = await prisma.loan.findFirst({ where: { id: loanId, tenantId }, select: { assetId: true } })
  if (!loan?.assetId) return null
  const [heartbeat, alerts, held] = await Promise.all([
    trackerHeartbeat(tenantId, loan.assetId),
    canWork ? listAlerts(tenantId, { loanId }) : Promise.resolve([]),
    canManage ? listHeldReadings(tenantId, { loanId }) : Promise.resolve([]),
  ])
  if (!heartbeat && alerts.length === 0 && held.length === 0) return null

  return (
    <DataPanel title="Tracker" description="Device heartbeat, alerts and held meter readings. Nothing here is sent to the borrower." density="loose">
      <p className="flex flex-wrap items-center gap-2 text-sm text-[var(--cf-text)]">
        {heartbeat ? (
          <>
            <span className="font-mono">{heartbeat.externalDeviceId}</span>
            <span className="text-[var(--cf-text-secondary)]">{`Last heard ${heartbeat.lastSeenAt ? formatDateTime(heartbeat.lastSeenAt) : "never"}`}</span>
            {heartbeat.simulated && <SimulatedChip />}
          </>
        ) : (
          <span className="text-[var(--cf-text-muted)]">No live tracker device.</span>
        )}
        <Link className="text-xs text-[var(--cf-brand)] underline-offset-2 hover:underline" href={`/asset-finance/assets/${loan.assetId}`}>Asset</Link>
      </p>
      {canWork && (
        <>
          <h3 className={subheading}>Open alerts</h3>
          <AlertsTable alerts={alerts} canWork showLoan={false} />
        </>
      )}
      {canManage && held.length > 0 && (
        <>
          <h3 className={subheading}>Held readings</h3>
          <HeldReadingsTable held={held} canManage showLoan={false} />
        </>
      )}
    </DataPanel>
  )
}
