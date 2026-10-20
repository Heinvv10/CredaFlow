import Link from "next/link"
import type { TelematicsAlertQueue, TelematicsAlertStatus } from "@prisma/client"
import { Header } from "@/components/layout/Header"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { canDo } from "@/lib/auth-guards"
import { requireAssetFinanceStaffPage } from "@/lib/asset-finance/staff-page"
import { ALERT_QUEUES, ALERT_STATUSES, listAlerts } from "@/lib/telematics/alerts"
import { listHeldReadings } from "@/lib/telematics/held-readings"
import { ALERT_QUEUE_LABELS, ALERT_STATUS_LABELS } from "@/lib/telematics/labels"
import { AlertsTable, HeldReadingsTable } from "@/components/asset-finance/telematics/TelematicsTables"

const one = (raw: string | string[] | undefined) => (Array.isArray(raw) ? raw[0] : raw)
const tab = (active: boolean) =>
  `rounded-md px-3 py-1.5 text-sm ${active ? "bg-[var(--cf-surface-hover)] font-medium text-[var(--cf-text)]" : "text-[var(--cf-text-secondary)] hover:text-[var(--cf-text)]"}`

/**
 * The tracker work queue (SLICE5.md part B): alerts by queue and status
 * (work_telematics_alerts) and the meter readings held for a decision
 * (manage_asset_finance). No position is shown here.
 */
export default async function TelematicsQueuePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, tenantId, canManage } = await requireAssetFinanceStaffPage()
  const canWork = canDo(user.role, "work_telematics_alerts")
  const params = await searchParams
  const view = one(params.tab) === "held" ? "held" : "alerts"
  const queue = ALERT_QUEUES.find((q) => q === one(params.queue))
  const status = ALERT_STATUSES.find((s) => s === one(params.status))
  const href = (over: Record<string, string | undefined>) => {
    const next = new URLSearchParams(Object.entries({ tab: view, queue, status, ...over }).filter((e): e is [string, string] => Boolean(e[1])))
    return `/asset-finance/telematics?${next.toString()}`
  }
  const [alerts, held] = await Promise.all([
    view === "alerts" && canWork ? listAlerts(tenantId, { queue: queue as TelematicsAlertQueue | undefined, status: status as TelematicsAlertStatus | undefined }) : Promise.resolve([]),
    view === "held" && canManage ? listHeldReadings(tenantId) : Promise.resolve([]),
  ])

  return (
    <>
      <Header title="Tracker alerts" subtitle="Work items raised by tracker devices, and meter readings held for a decision. Nothing here is sent to a borrower."
        breadcrumbs={[{ label: "Asset Finance" }, { label: "Tracker alerts" }]} />
      <div className="space-y-6 p-4 lg:p-8">
        <nav className="flex flex-wrap gap-2" aria-label="Tracker work queue">
          <Link className={tab(view === "alerts")} href={href({ tab: "alerts" })}>Alerts</Link>
          <Link className={tab(view === "held")} href={href({ tab: "held", queue: undefined, status: undefined })}>Held readings</Link>
        </nav>
        {view === "alerts" ? (
          <DataPanel title="Alerts" density="loose" actions={canWork ? (
            <div className="flex flex-wrap gap-1">
              <Link className={tab(!queue)} href={href({ queue: undefined })}>All queues</Link>
              {ALERT_QUEUES.map((q) => <Link key={q} className={tab(queue === q)} href={href({ queue: q })}>{ALERT_QUEUE_LABELS[q]}</Link>)}
              <span className="mx-1 border-l border-[var(--cf-border-subtle)]" />
              <Link className={tab(!status)} href={href({ status: undefined })}>Unresolved</Link>
              {ALERT_STATUSES.map((s) => <Link key={s} className={tab(status === s)} href={href({ status: s })}>{ALERT_STATUS_LABELS[s]}</Link>)}
            </div>
          ) : undefined}>
            {canWork ? <AlertsTable alerts={alerts} canWork /> : <p className="text-sm text-[var(--cf-text-muted)]">Tracker alerts are worked by collections staff.</p>}
          </DataPanel>
        ) : (
          <DataPanel title="Held readings" description="A reading below an earlier one, above a later one, or far above the contracted pace is held, never written unattended." density="loose">
            {canManage ? <HeldReadingsTable held={held} canManage /> : <p className="text-sm text-[var(--cf-text-muted)]">Held readings are decided by credit staff.</p>}
          </DataPanel>
        )}
      </div>
    </>
  )
}
