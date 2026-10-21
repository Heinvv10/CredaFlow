import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { Scale } from "lucide-react"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { EmptyState } from "@/components/app-shell/EmptyState"
import { MetricCard } from "@/components/app-shell/MetricCard"
import { canDo, NO_ACCESS_PAGE, requireMinRole } from "@/lib/auth-guards"
import { SMALL_CELL_LOANS } from "@/lib/learning-loop/dashboard/cells"
import { COHORT_WINDOWS, coverageTally, type CohortWindow } from "@/lib/learning-loop/dashboard/cohorts"
import { HORIZON_DAYS } from "@/lib/learning-loop/dashboard/collections"
import { loadDecisionPerformance } from "@/lib/learning-loop/dashboard/loader"
import { prisma } from "@/lib/prisma"
import { getStaffTenantId } from "@/lib/session-tenant"
import { getTenantConfig } from "@/lib/tenant"
import { cn } from "@/lib/utils"
import { ArrangementLine, CohortTable, DeclineTable, OverrideTable, percent, Rate, StageTable, TakeUpTable } from "./tables"

type Props = { searchParams: Promise<{ window?: string }> }

export default async function DecisionPerformancePage({ searchParams }: Props) {
  // Default-deny: the permission (lib/registry/permissions/070-learning-loop.ts) and the lender's reports feature.
  const user = await requireMinRole("READONLY")
  if (!canDo(user.role, "view_decision_performance")) redirect(NO_ACCESS_PAGE)
  const tenantId = await getStaffTenantId()
  if (!(await getTenantConfig(tenantId))?.featureReports) notFound()

  const asked = (await searchParams).window
  const window: CohortWindow = COHORT_WINDOWS.find((w) => w === asked) ?? "12M"
  const data = await loadDecisionPerformance(prisma, tenantId, new Date(), window)
  // 3M does not measure 90+ DPD (DESIGN.md §3): coverage is read on 60+ there.
  const bad = data.totals.ever90
  const covered = coverageTally(data.totals)

  return (
    <div className="space-y-6 px-4 py-5 lg:px-8 lg:py-7">
      <div className="border-b border-[var(--cf-border-subtle)] pb-5">
        <Breadcrumbs className="mb-3" items={[{ label: "Reports", href: "/reports" }, { label: "Decision performance" }]} />
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">Credit Policy</p>
        <h1 className="mt-2 text-2xl font-semibold text-[var(--cf-text)]">Decision Performance</h1>
        <p className="mt-1 max-w-3xl text-sm text-[var(--cf-text-muted)]">
          What happened after each approval, by disbursal month, rule version, policy thresholds, bureau score band, override and product.
          Months on book count from the first instalment due date.
        </p>
      </div>

      <div className="rounded-md border border-[var(--cf-warning)] px-4 py-3 text-sm text-[var(--cf-text)]">
        Until a lender has 6 to 12 months of loans on book, these figures can only be checked on demo or simulator data; on a newer book most windows are still pending and the rates rest on few loans.
        No model scores these decisions: the rates count what was recorded.
      </div>

      <nav className="flex gap-2 text-sm" aria-label="Months on book">
        {COHORT_WINDOWS.map((w) => (
          <Link key={w} href={`/reports/decision-performance?window=${w}`}
            className={cn("rounded-md border px-3 py-1", w === window ? "border-[var(--cf-brand)] font-semibold text-[var(--cf-text)]" : "border-[var(--cf-border-subtle)] text-[var(--cf-text-muted)]")}>
            {w.replace("M", " months")}
          </Link>
        ))}
      </nav>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Approvals with outcomes" value={data.approvals} detail="Final approvals that produced a loan" />
        <MetricCard label={window === "12M" ? "Bad: ever 90+ DPD in 12 months" : `Ever 90+ DPD in ${window.replace("M", " months")}`}
          value={<Rate t={bad} />} tone="warning"
          detail={bad
            ? `Of ${bad.yes + bad.no} loans observed; ${bad.pending} pending, ${bad.unobservable + bad.notComputed} unobservable, neither counted as good`
            : "A 3-month window is 89 to 92 days, too short to compare 90+ DPD across months; see 6 or 12 months"} />
        <MetricCard label="Outcome coverage" value={percent(covered.coveragePct)}
          detail={`Observed ÷ matured (pending excluded), on ever ${bad ? "90" : "60"}+ DPD`} />
        <MetricCard label="90+ DPD in the book now" value={data.book.par90.count}
          detail={`PAR90 ${data.book.par90.pct.toFixed(1)}%: the board pack's figure, all loans, not only those above`} />
      </div>

      <DataPanel title="Approvals by cohort"
        description={`Rates divide observed outcomes only. Pending: the window has not elapsed. Unobservable: arrears history is missing for part of it, or the loan was cancelled in cooling-off. Cured counts loans that reached 30+ DPD. Rows under ${SMALL_CELL_LOANS} loans are greyed.`}>
        {data.cohorts.length === 0
          ? <EmptyState icon={Scale} title="No approval has outcomes yet" description="Outcomes are derived nightly from approvals recorded since the decision log shipped." />
          : <CohortTable cells={data.cohorts} />}
      </DataPanel>

      <DataPanel title="Overrides against the gates" description="Approvals where staff went against a gate, beside those where they did not, on the same disbursal month.">
        {data.overrides.length === 0 ? <EmptyState icon={Scale} title="No approvals yet" description="Nothing to compare." /> : <OverrideTable cells={data.overrides} />}
      </DataPanel>

      <DataPanel title="Offer take-up" description="An offer is taken up when the loan is paid out; a return, decline or cancellation first means it was not. With no approval expiry, an unsigned offer stays pending.">
        {data.takeUp.length === 0 ? <EmptyState icon={Scale} title="No offers recorded" description="Offers are recorded at approval and at the pre-agreement quotation." /> : <TakeUpTable cells={data.takeUp} />}
      </DataPanel>

      <DataPanel title="Declines by category" description="Declined applicants have no observable repayment, so every rate above describes approved loans only: it says nothing about how a declined applicant would have repaid.">
        {data.declines.total === 0 ? <EmptyState icon={Scale} title="No declines recorded" description="Declines are recorded with their category." /> : <DeclineTable summary={data.declines} />}
        <p className="mt-3 text-sm text-[var(--cf-text)]">
          Automated refusals recorded (no staff member decided): <span className="font-semibold">{data.declines.automated}</span>, for lender legal review (POPIA s71).
          Portal and website submission refusals are not recorded in this log yet, so they are not counted here.
        </p>
      </DataPanel>

      <DataPanel title="Collections" description={`Descriptive, not causal. There is no holdout, so a difference between stages reflects which loans reached them as much as what the stage did. An episode starts when a past-due loan enters a stage; within ${HORIZON_DAYS} days it cures (0 DPD or settled), rolls (a later arrears band or written off) or stays.`}>
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--cf-warning)]">Descriptive, not causal</p>
        {data.stages.length === 0
          ? <EmptyState icon={Scale} title="No arrears episodes in the history" description="The daily arrears history starts at its first nightly run and is not backfilled." />
          : <StageTable cells={data.stages} />}
        <div className="mt-4"><ArrangementLine a={data.arrangements} /></div>
        <p className="mt-2 text-xs text-[var(--cf-text-muted)]">
          By collection action (reminder, call, letter): not available, because collection actions are not recorded yet.
          An arrangement keeps only its latest result.
        </p>
      </DataPanel>
    </div>
  )
}
