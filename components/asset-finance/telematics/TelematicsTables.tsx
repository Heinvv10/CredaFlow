import Link from "next/link"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatDate, formatDateTime } from "@/lib/utils"
import type { AlertRow } from "@/lib/telematics/alerts"
import type { HeldReadingRow } from "@/lib/telematics/held-readings"
import { ALERT_KIND_LABELS, ALERT_QUEUE_LABELS, ALERT_STATUS_LABELS, HELD_REASON_LABELS } from "@/lib/telematics/labels"
import { SimulatedChip } from "./SimulatedChip"
import { AlertActions, HeldReadingActions } from "./TelematicsActions"

const link = "text-[var(--cf-brand)] underline-offset-2 hover:underline"
const STATUS_TONE = { OPEN: "danger", ACKNOWLEDGED: "warning", RESOLVED: "neutral" } as const

/** Tracker alert work items; the actions only for work_telematics_alerts. */
export function AlertsTable({ alerts, canWork, showLoan = true }: { alerts: AlertRow[]; canWork: boolean; showLoan?: boolean }) {
  if (alerts.length === 0) return <p className="text-sm text-[var(--cf-text-muted)]">No tracker alerts.</p>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Alert</TableHead>
          <TableHead>Queue</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>First / last</TableHead>
          {showLoan && <TableHead>Loan · asset</TableHead>}
          {canWork && <TableHead>Action</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {alerts.map((a) => (
          <TableRow key={a.id} className="align-top">
            <TableCell>
              <span className="mr-2">{ALERT_KIND_LABELS[a.kind as keyof typeof ALERT_KIND_LABELS] ?? a.kind}</span>
              {a.occurrences > 1 && <span className="mr-2 text-xs text-[var(--cf-text-muted)]">{`× ${a.occurrences}`}</span>}
              {a.simulated && <SimulatedChip />}
            </TableCell>
            <TableCell>{ALERT_QUEUE_LABELS[a.queue]}</TableCell>
            <TableCell>
              <StatusPill tone={STATUS_TONE[a.status]}>{ALERT_STATUS_LABELS[a.status]}</StatusPill>
              {a.resolutionNote && <p className="mt-1 text-xs text-[var(--cf-text-muted)]">{a.resolutionNote}</p>}
            </TableCell>
            <TableCell className="text-xs">{`${formatDateTime(a.firstOccurredAt)} / ${formatDateTime(a.lastOccurredAt)}`}</TableCell>
            {showLoan && (
              <TableCell className="text-xs">
                <Link className={link} href={`/loans/${a.loanId}`}>{a.loanReference}</Link>
                {" · "}
                <Link className={link} href={`/asset-finance/assets/${a.assetId}`}>{a.assetLabel}</Link>
              </TableCell>
            )}
            {canWork && <TableCell>{a.status !== "RESOLVED" && <AlertActions alertId={a.id} status={a.status} />}</TableCell>}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** Tracker readings held for a decision; the actions only for manage_asset_finance. */
export function HeldReadingsTable({ held, canManage, showLoan = true }: { held: HeldReadingRow[]; canManage: boolean; showLoan?: boolean }) {
  if (held.length === 0) return <p className="text-sm text-[var(--cf-text-muted)]">No held tracker readings.</p>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Reading date</TableHead>
          <TableHead className="text-right">Value</TableHead>
          <TableHead>Why it was held</TableHead>
          {showLoan && <TableHead>Lease</TableHead>}
          {canManage && <TableHead>Decision</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {held.map((h) => (
          <TableRow key={h.id} className="align-top">
            <TableCell>{formatDate(h.readingDate)}</TableCell>
            <TableCell className="text-right tabular-nums">{`${h.value.toLocaleString("en-ZA")} ${h.unit === "HOURS" ? "h" : "km"}`}</TableCell>
            <TableCell>
              <span className="mr-2">{HELD_REASON_LABELS[h.reason]}</span>
              {h.simulated && <SimulatedChip />}
            </TableCell>
            {showLoan && <TableCell><Link className={link} href={`/loans/${h.loanId}`}>{h.loanReference}</Link></TableCell>}
            {canManage && <TableCell>{h.status === "HELD" ? <HeldReadingActions heldId={h.id} /> : h.decisionNote}</TableCell>}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
