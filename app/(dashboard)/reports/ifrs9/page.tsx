import { Download } from "lucide-react"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { InfoStrip } from "@/components/app-shell/InfoStrip"
import { MetricCard } from "@/components/app-shell/MetricCard"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Ifrs9RunActions, type MonthChoice } from "@/components/ifrs9/Ifrs9RunActions"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { hasMinRole, requireMinRole } from "@/lib/auth-guards"
import { previousMonthKey } from "@/lib/ifrs9/period"
import { listRuns, loadRunReport, type RunHead } from "@/lib/ifrs9/run-report"
import { loadSettings } from "@/lib/ifrs9/store"
import { prisma } from "@/lib/prisma"
import { getStaffTenantId } from "@/lib/session-tenant"
import { sastCalendarDate } from "@/lib/date/sast"
import { formatZAR } from "@/lib/utils"
import Link from "next/link"

export const metadata = { title: "IFRS 9 — Reports" }

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`
const edge = (e: string) => (e === "NEW" ? "New loan" : e === "CLOSED" ? "Left the book" : `Stage ${e}`)

function runLabel(run: RunHead): string {
  return run.kind === "MONTHLY" ? `Month end ${run.periodKey}` : `Analysis ${run.runDate}`
}

/** The ended months an administrator can still act on: those with no run, and the open months' current runs. */
function actionableMonths(runs: RunHead[], closed: Set<string>, today: string): MonthChoice[] {
  const current = new Map(runs.filter((r) => r.kind === "MONTHLY" && !r.superseded).map((r) => [r.periodKey!, r.id]))
  const months: string[] = []
  for (let key = previousMonthKey(today.slice(0, 7)), i = 0; i < 6; key = previousMonthKey(key), i++) months.push(key)
  return months.filter((m) => !closed.has(m)).map((periodKey) => ({ periodKey, currentRunId: current.get(periodKey) ?? null }))
}

export default async function Ifrs9ReportPage({ searchParams }: { searchParams: Promise<{ runId?: string }> }) {
  const user = await requireMinRole("LOAN_ADMIN")
  const tenantId = await getStaffTenantId()
  const { runId } = await searchParams
  const [settings, runs, batches] = await Promise.all([
    loadSettings(prisma, tenantId),
    listRuns(prisma, tenantId),
    prisma.accountingExportBatch.findMany({ where: { tenantId }, select: { periodKey: true } }),
  ])
  // Opens on the latest official month-end run, not on an analysis run made since.
  const official = runs.find((r) => r.kind === "MONTHLY" && !r.superseded)
  const report = await loadRunReport(prisma, tenantId, runId ?? official?.id)
  const months = actionableMonths(runs, new Set(batches.map((b) => b.periodKey)), sastCalendarDate(new Date()))

  return (
    <div className="space-y-6 px-4 py-5 lg:px-8 lg:py-7">
      <div className="flex flex-col gap-4 border-b border-[var(--cf-border-subtle)] pb-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <Breadcrumbs className="mb-3" items={[{ label: "Reports", href: "/reports" }, { label: "IFRS 9" }]} />
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">Expected credit loss</p>
          <h1 className="mt-2 text-2xl font-semibold text-[var(--cf-text)]">IFRS 9 staging and ECL</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--cf-text-muted)]">
            Every loan staged 1, 2 or 3 with its exposure, PD, LGD and expected credit loss, and the interest held on non-performing loans.
            Month-end runs feed the accounting close; analysis runs describe today only.
          </p>
        </div>
        {report && (
          <Button asChild>
            <a href={`/api/reports/export?type=ifrs9-ecl&runId=${report.run.id}`} download><Download className="h-4 w-4" />Export loan-level ECL (Excel)</a>
          </Button>
        )}
      </div>

      {!settings.enabled && (
        <InfoStrip variant="warning">IFRS 9 is off for this lender: month-end runs are not made and the accounting close does not ask for one. Analysis runs still work once the PD and LGD table is set.</InfoStrip>
      )}

      {report ? (
        <>
          <p className="text-sm text-[var(--cf-text-muted)]">
            Showing <strong className="text-[var(--cf-text)]">{runLabel(report.run)}</strong> (position at {report.run.runDate}
            {report.run.late ? ", made late" : ""}{report.run.superseded ? ", replaced by a later run" : ""})
            {report.previousRun ? <>, compared with {runLabel(report.previousRun)}.</> : "."}
          </p>
          <div className="grid gap-4 md:grid-cols-3">
            {report.summary.byStage.map((s) => (
              <MetricCard
                key={s.stage}
                label={`Stage ${s.stage}`}
                value={`${s.loans} loan${s.loans === 1 ? "" : "s"}`}
                tone={s.stage === 3 ? "danger" : s.stage === 2 ? "warning" : "neutral"}
                detail={<>{formatZAR(s.eadCents)} exposure / {formatZAR(s.eclCents)} ECL ({pct(s.coverageBps)})<br />{formatZAR(s.suspendedCents)} interest in suspense</>}
              />
            ))}
          </div>
          <DataPanel title="Movement between stages" description="Each loan counted once, from its stage at the earlier run to its stage at this one.">
            {report.transitions && report.transitions.cells.length > 0 ? (
              <Table>
                <TableHeader><TableRow><TableHead>From</TableHead><TableHead>To</TableHead><TableHead className="text-right">Loans</TableHead><TableHead className="text-right">Exposure then</TableHead><TableHead className="text-right">Exposure now</TableHead></TableRow></TableHeader>
                <TableBody>
                  {report.transitions.cells.map((c) => (
                    <TableRow key={`${c.from}-${c.to}`}>
                      <TableCell>{edge(c.from)}</TableCell><TableCell>{edge(c.to)}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.loans}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatZAR(c.fromEadCents)}</TableCell><TableCell className="text-right tabular-nums">{formatZAR(c.toEadCents)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : <p className="text-sm text-[var(--cf-text-muted)]">There is no earlier run to compare with.</p>}
          </DataPanel>
        </>
      ) : (
        <InfoStrip>No IFRS 9 run has been made yet.</InfoStrip>
      )}

      <DataPanel title="Runs" description="The latest first. A superseded run stays on record; a stale run must be replaced before its month closes.">
        {runs.length === 0 ? <p className="text-sm text-[var(--cf-text-muted)]">None yet.</p> : (
          <Table>
            <TableHeader><TableRow><TableHead>Run</TableHead><TableHead>Position at</TableHead><TableHead className="text-right">Loans</TableHead><TableHead className="text-right">Exposure</TableHead><TableHead className="text-right">ECL</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
            <TableBody>
              {runs.map((r) => (
                <TableRow key={r.id}>
                  <TableCell><Link className="underline" href={`/reports/ifrs9?runId=${r.id}`}>{runLabel(r)}</Link></TableCell>
                  <TableCell>{r.runDate}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.loanCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatZAR(r.totalEadCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatZAR(r.totalEclCents)}</TableCell>
                  <TableCell className="space-x-1">
                    {r.kind === "ON_DEMAND" && <StatusPill tone="neutral">Analysis</StatusPill>}
                    {r.kind === "MONTHLY" && !r.superseded && <StatusPill tone="success">Official</StatusPill>}
                    {r.late && <StatusPill tone="warning">Late</StatusPill>}
                    {r.superseded && <StatusPill tone="neutral">Replaced</StatusPill>}
                    {r.stale && <StatusPill tone="danger">Stale</StatusPill>}
                    {r.reason && <span className="text-xs text-[var(--cf-text-muted)]">{r.reason}</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DataPanel>

      <DataPanel title="Make a run">
        <Ifrs9RunActions months={months} canRun={hasMinRole(user.role, "ADMIN")} />
      </DataPanel>
    </div>
  )
}
