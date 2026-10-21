import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DECLINE_CATEGORY_LABELS } from "@/lib/applications/decline-category"
import { SMALL_CELL_LOANS, type Tally } from "@/lib/learning-loop/dashboard/cells"
import { COHORT_METRICS, coverageTally, type CohortCell, type OverrideCell } from "@/lib/learning-loop/dashboard/cohorts"
import type { ArrangementSummary, StageCell } from "@/lib/learning-loop/dashboard/collections"
import type { DeclineSummary, TakeUpCell } from "@/lib/learning-loop/dashboard/offers-declines"
import { cn } from "@/lib/utils"

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
export const monthLabel = (key: string) => `${MONTHS[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}`
export const percent = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`)

const SMALL_TITLE = `Fewer than ${SMALL_CELL_LOANS} loans: too few to read a rate from`
const smallRow = (small: boolean) => cn(small && "text-[var(--cf-text-muted)] opacity-60")
const num = "text-right tabular-nums"

/** A rate with the observed counts it rests on; null when the window does not measure it. */
export function Rate({ t }: { t: Tally | null }) {
  if (!t) return <span title="A 3-month window is too short to measure 90+ DPD">not measured</span>
  return (
    <span>
      {percent(t.ratePct)}
      <span className="ml-1 text-[11px] text-[var(--cf-text-muted)]">{t.yes}/{t.yes + t.no}</span>
    </span>
  )
}

function MetricHeads() {
  return <>{COHORT_METRICS.map((m) => <TableHead key={m.key} className="text-right">{m.key === "ever90" ? "Ever 90+ (bad)" : m.label}</TableHead>)}</>
}

function MetricCells({ cell }: { cell: { metrics: CohortCell["metrics"] } }) {
  const headline = coverageTally(cell.metrics)
  return (
    <>
      {COHORT_METRICS.map((m) => <TableCell key={m.key} className={num}><Rate t={cell.metrics[m.key]} /></TableCell>)}
      <TableCell className={num}>{percent(headline.coveragePct)}</TableCell>
      <TableCell className={num}>{headline.pending}</TableCell>
      <TableCell className={num}>{headline.unobservable + headline.notComputed}</TableCell>
    </>
  )
}

const TAIL_HEADS = (
  <>
    <TableHead className="text-right">Coverage</TableHead>
    <TableHead className="text-right">Pending</TableHead>
    <TableHead className="text-right">Unobservable</TableHead>
  </>
)

export function CohortTable({ cells }: { cells: CohortCell[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Disbursed</TableHead>
          <TableHead>Rule version</TableHead>
          <TableHead>Policy</TableHead>
          <TableHead>Score band</TableHead>
          <TableHead>Override</TableHead>
          <TableHead>Product</TableHead>
          <TableHead className="text-right">Loans</TableHead>
          <MetricHeads />
          {TAIL_HEADS}
        </TableRow>
      </TableHeader>
      <TableBody>
        {cells.map((c) => (
          <TableRow key={[c.cohortMonth, c.ruleVersion, c.policyHash, c.scoreBand, c.overridden, c.product].join("|")}
            className={smallRow(c.small)} title={c.small ? SMALL_TITLE : undefined} data-small={c.small || undefined}>
            <TableCell>{monthLabel(c.cohortMonth)}</TableCell>
            <TableCell className="font-mono text-[11px]">{c.ruleVersion}</TableCell>
            <TableCell className="font-mono text-[11px]" title={c.policyHash}>{c.policyHash.slice(0, 8)}</TableCell>
            <TableCell>{c.scoreBand}</TableCell>
            <TableCell>{c.overridden ? "Yes" : "No"}</TableCell>
            <TableCell>{c.product}</TableCell>
            <TableCell className={num}>{c.loans}</TableCell>
            <MetricCells cell={c} />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function OverrideTable({ cells }: { cells: OverrideCell[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Disbursed</TableHead>
          <TableHead>Override</TableHead>
          <TableHead className="text-right">Loans</TableHead>
          <MetricHeads />
          {TAIL_HEADS}
        </TableRow>
      </TableHeader>
      <TableBody>
        {cells.map((c) => (
          <TableRow key={`${c.cohortMonth}|${c.overridden}`} className={smallRow(c.small)} title={c.small ? SMALL_TITLE : undefined} data-small={c.small || undefined}>
            <TableCell>{monthLabel(c.cohortMonth)}</TableCell>
            <TableCell>{c.overridden ? "Overridden" : "Not overridden"}</TableCell>
            <TableCell className={num}>{c.loans}</TableCell>
            <MetricCells cell={c} />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

const OFFER_LABELS: Record<string, string> = { APPROVED_TERMS: "Approved terms", QUOTATION_ISSUED: "Pre-agreement quotation" }

export function TakeUpTable({ cells }: { cells: TakeUpCell[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Offered</TableHead>
          <TableHead>Offer</TableHead>
          <TableHead className="text-right">Offers</TableHead>
          <TableHead className="text-right">Taken up</TableHead>
          <TableHead className="text-right">Not taken up</TableHead>
          <TableHead className="text-right">Pending</TableHead>
          <TableHead className="text-right">Take-up rate</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {cells.map((c) => (
          <TableRow key={`${c.month}|${c.decision}`} className={smallRow(c.small)} title={c.small ? SMALL_TITLE : undefined} data-small={c.small || undefined}>
            <TableCell>{monthLabel(c.month)}</TableCell>
            <TableCell>{OFFER_LABELS[c.decision] ?? c.decision}</TableCell>
            <TableCell className={num}>{c.offers}</TableCell>
            <TableCell className={num}>{c.takeUp.yes}</TableCell>
            <TableCell className={num}>{c.takeUp.no}</TableCell>
            <TableCell className={num}>{c.takeUp.pending + c.takeUp.unobservable + c.takeUp.notComputed}</TableCell>
            <TableCell className={num}>{percent(c.takeUp.ratePct)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

const categoryLabel = (c: string) => DECLINE_CATEGORY_LABELS[c as keyof typeof DECLINE_CATEGORY_LABELS] ?? "Not categorised"

export function DeclineTable({ summary }: { summary: DeclineSummary }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Declined</TableHead>
          <TableHead>Category</TableHead>
          <TableHead className="text-right">Declines</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {summary.cells.map((c) => (
          <TableRow key={`${c.month}|${c.category}`}>
            <TableCell>{monthLabel(c.month)}</TableCell>
            <TableCell>{categoryLabel(c.category)}</TableCell>
            <TableCell className={num}>{c.declines}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

const STAGE_LABELS: Record<string, string> = {
  NONE: "No stage", SOFT_REMINDER: "Soft reminder", FORMAL_REMINDER: "Formal reminder", SECTION_129_SENT: "Section 129 sent",
  PAYMENT_ARRANGEMENT: "Payment arrangement", ATTORNEY_REFERRED: "Attorney referred", WRITTEN_OFF: "Written off",
}

export function StageTable({ cells }: { cells: StageCell[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Stage</TableHead>
          <TableHead className="text-right">Loans</TableHead>
          <TableHead className="text-right">Episodes</TableHead>
          <TableHead className="text-right">Cured</TableHead>
          <TableHead className="text-right">Rolled</TableHead>
          <TableHead className="text-right">Stayed</TableHead>
          <TableHead className="text-right">Pending</TableHead>
          <TableHead className="text-right">Unobservable</TableHead>
          <TableHead className="text-right">Cure rate</TableHead>
          <TableHead className="text-right">Roll rate</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {cells.map((c) => (
          <TableRow key={c.stage} className={smallRow(c.small)} title={c.small ? SMALL_TITLE : undefined} data-small={c.small || undefined}>
            <TableCell>{STAGE_LABELS[c.stage] ?? c.stage}</TableCell>
            <TableCell className={num}>{c.loans}</TableCell>
            <TableCell className={num}>{c.episodes}</TableCell>
            <TableCell className={num}>{c.cured}</TableCell>
            <TableCell className={num}>{c.rolled}</TableCell>
            <TableCell className={num}>{c.stayed}</TableCell>
            <TableCell className={num}>{c.pending}</TableCell>
            <TableCell className={num}>{c.unobservable}</TableCell>
            <TableCell className={num}>{percent(c.cureRatePct)}</TableCell>
            <TableCell className={num}>{percent(c.rollRatePct)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function ArrangementLine({ a }: { a: ArrangementSummary }) {
  return (
    <p className={cn("text-sm text-[var(--cf-text)]", smallRow(a.small))} data-small={a.small || undefined}>
      {a.total} arrangements: {a.kept} kept, {a.broken} broken, {a.completedShort} ran to the end under 90% paid, {a.active} still active
      {a.other > 0 ? `, ${a.other} other` : ""}. Kept rate {percent(a.keptRatePct)}, broken rate {percent(a.brokenRatePct)} of those that ended.
    </p>
  )
}
