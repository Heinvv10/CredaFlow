import { DataPanel } from "@/components/app-shell/DataPanel"
import { MetricCard } from "@/components/app-shell/MetricCard"
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ScrollTable } from "@/components/asset-finance/ScrollTable"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { ReadingForm } from "./ReadingForm"
import type { LeaseStaffData } from "./lease-staff-data"

// Meter readings of a lease with contracted usage, and what the usage so far
// would bill at the end of term (lib/asset-finance/lease-usage.ts).

const metric = (text: string) => <span className="block text-xl tabular-nums">{text}</span>
const SOURCES: Record<string, string> = { STAFF: "Staff", PORTAL: "Lessee (portal)" }

export function LeaseReadingsPanel({ data, usage, canRecord }: {
  data: LeaseStaffData
  usage: NonNullable<LeaseStaffData["deal"]["usage"]>
  canRecord: boolean
}) {
  const unitLabel = usage.unit === "HOURS" ? "hours" : "km"
  const projection = data.usage
  return (
    <DataPanel
      title="Meter readings and usage"
      description={`Contracted ${usage.allowancePerYear.toLocaleString("en-ZA")} ${unitLabel} a year · excess billed at ${formatMoney(usage.excessRateCents)} per ${usage.unit === "HOURS" ? "hour" : "km"} ex VAT at the end of term`}
      density="loose"
    >
      <div className="space-y-5">
        {projection ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <MetricCard label="Used so far" value={metric(`${projection.usedUnits.toLocaleString("en-ZA")} ${unitLabel}`)} detail="Latest reading less the start reading" />
            <MetricCard label="Projected at term end" value={metric(`${projection.projectedFinalReading.toLocaleString("en-ZA")} ${unitLabel}`)}
              detail={`Against an allowance of ${projection.allowedUnits.toLocaleString("en-ZA")} ${unitLabel} over the term`} />
            <MetricCard label="Projected excess ex VAT" value={metric(formatMoney(projection.excessCents))} tone={projection.excessCents > 0 ? "warning" : "neutral"}
              detail="An estimate: extrapolated per day from the readings" />
          </div>
        ) : (
          <p className="text-sm text-[var(--cf-text-muted)]">A projection needs a reading after the start reading.</p>
        )}
        {data.readings.length > 0 && (
          <ScrollTable maxHeight="max-h-72">
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Reading ({unitLabel})</TableHead>
                <TableHead>Recorded by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.readings.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{formatIsoDate(r.readingDate)}</TableCell>
                  <TableCell className="text-right">{r.value.toLocaleString("en-ZA")}</TableCell>
                  <TableCell>{SOURCES[r.source] ?? r.source}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ScrollTable>
        )}
        {canRecord && <ReadingForm url={`/api/asset-finance/leases/${data.loanId}/readings`} today={data.today} unitLabel={unitLabel} />}
      </div>
    </DataPanel>
  )
}
