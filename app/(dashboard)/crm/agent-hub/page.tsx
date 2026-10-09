import Link from "next/link"
import { prisma } from "@/lib/prisma"
import { getDefaultTenantId } from "@/lib/tenant"
import { requireMinRole } from "@/lib/auth-guards"
import { hasMinRole } from "@/lib/permissions"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { AgentHubTabs } from "@/components/agent-hub/AgentHubTabs"
import { OverviewTab } from "@/components/agent-hub/OverviewTab"
import { AgentsTab } from "@/components/agent-hub/AgentsTab"
import { CommissionTab } from "@/components/agent-hub/CommissionTab"
import { StatementsTab } from "@/components/agent-hub/StatementsTab"
import { summariseCommission, summariseByAgent } from "@/lib/agent-hub/summary"
import { needsCommissionAttention } from "@/lib/agent-hub/attention"
import { parsePeriod } from "@/lib/agent-hub/period"
import { parsePage } from "@/lib/agent-hub/pagination"
import { loadStatementData } from "./load-statement-data"
import { parseAgentSelection } from "@/lib/agent-hub/agent-selection"
import { loadCommissionData } from "./load-commission-data"

// No pagination UI for history (Step 3 doesn't ask for one) — capped instead,
// with the true total shown so a cap is never silent (same principle as the
// queue's true-total badge, addendum item 2).
const HISTORY_PAGE_SIZE = 50

// agentId is `string | string[]`: the Statements selector is a <select multiple>,
// so Next hands back an array once more than one agent is chosen (and a bare
// string for exactly one). Typing it as `string` would compile while silently
// dropping every agent but the first.
export default async function AgentHubPage({ searchParams }: { searchParams: Promise<{ tab?: string; from?: string; to?: string; page?: string; agentId?: string | string[] }> }) {
  const sp = await searchParams
  const defaultTab = ["overview", "agents", "commission", "statements"].includes(sp.tab ?? "") ? sp.tab! : "overview"
  const user = await requireMinRole("LOAN_ADMIN")
  const tenantId = await getDefaultTenantId()
  // The tenant default prices every agent without an override, so editing it sits
  // a rung above the per-agent editors on this page. The API route enforces the
  // same floor independently — this only decides whether to render the control.
  const canEditTenantRate = hasMinRole(user.role, "ADMIN")

  // parsePeriod throws on a malformed range (including "" — see period.ts) so a
  // typo'd or cleared date-filter field can't silently misreport a different
  // period than the URL asked for. Caught here rather than left to crash the
  // whole page: fall back to the default month and surface the rejection as a
  // banner above the tabs (not scoped to one tab) instead of a 500 — every tab
  // reads `from`/`to` off this same page-level period.
  let periodError: string | null = null
  let period: ReturnType<typeof parsePeriod>
  try {
    period = parsePeriod(sp.from, sp.to)
  } catch (err) {
    periodError = err instanceof Error ? err.message : "Invalid date filter"
    period = parsePeriod(null, null)
  }
  const { fromUtc, toUtc, label: periodLabel } = period
  const [periodFrom, periodTo] = periodLabel.split(" to ")

  const queuePageRaw = parsePage(sp.page)
  // Statements tab: reuses the page's one period rather than parsing a second one.
  const statementSelection = parseAgentSelection(sp.agentId)

  // Owner rule: the queue must show ALL unapproved items
  // regardless of date — an approval queue must not hide outstanding work by
  // calendar default. Only decided-history below is period-bound; see the
  // caption in CommissionTab.tsx for the user-facing scope statement.
  // Otherwise unchanged: PENDING, or anything carrying a qualityFlag —
  // including a resolved one like APPROVED (preserved quirk, see CommissionTab.tsx).
  const queueWhere = {
    tenantId,
    commissionStatus: { not: "REVERSED" },
    OR: [{ commissionStatus: "PENDING" }, { qualityFlag: { not: null } }],
  }

  const decidedAuditWhere = {
    tenantId,
    action: "REFERRAL_EVENT_DECIDED",
    entity: "ReferralEvent",
    createdAt: { gte: fromUtc, lt: toUtc },
  }

  const [agents, unmatchedEvents, commissionEvents, flaggedEvents, queueTotal, reversedEvents, tenantConfig, historyTotal, decidedAudits, statementData] = await Promise.all([
    prisma.referralAgent.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      include: {
        referralCodes: {
          orderBy: { createdAt: "desc" },
          include: {
            _count: { select: { leads: true, referralEvents: true } },
          },
        },
      },
    }),
    prisma.referralEvent.count({ where: { tenantId, qualityFlag: "UNMATCHED_CODE" } }),
    // Money totals source: every CONVERTED event, uncapped — commissionCents/commissionStatus
    // (PENDING/PAYABLE/PAID/REVERSED) is only ever set on this eventType (lib/referral-agents/commission.ts),
    // so this mirrors the ledger exactly rather than a `take`-limited slice.
    prisma.referralEvent.findMany({
      where: { tenantId, eventType: "CONVERTED" },
      select: { agentId: true, commissionStatus: true, commissionCents: true, agent: { select: { displayName: true } } },
    }),
    // REVERSED and BLOCKED are excluded here at the DB layer as an optimisation
    // (fewer rows fetched); needsCommissionAttention() re-checks both anyway so
    // this stays consistent even if the where clause above ever drifts. UNMATCHED_CODE
    // and APPROVED are qualityFlag values, not commissionStatus, so they're filtered
    // client-side below via that same predicate — see its comment for the full rationale.
    prisma.referralEvent.findMany({
      where: { tenantId, commissionStatus: { notIn: ["REVERSED", "BLOCKED"] }, qualityFlag: { not: null } },
      select: { commissionStatus: true, qualityFlag: true },
    }),
    // True total for the queue (tab badge; addendum item 2) AND needed to clamp
    // the page below before it's used for `skip` (fix round 1: an unclamped
    // stale/hand-edited `?page=` could skip past every row) — must resolve
    // before the paginated fetch, so it can't join that query in one round trip.
    prisma.referralEvent.count({ where: queueWhere }),
    // Clawbacks: qualityFlag is untouched by reversal, so this is queried independently of it.
    prisma.referralEvent.findMany({
      where: { tenantId, commissionStatus: "REVERSED" },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        code: { select: { code: true, label: true, agent: { select: { displayName: true } } } },
      },
    }),
    prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: { referralCommissionBps: true },
    }),
    // True total for the decided-history cap below, same "never silent" reasoning.
    prisma.auditLog.count({ where: decidedAuditWhere }),
    prisma.auditLog.findMany({
      where: decidedAuditWhere,
      orderBy: { createdAt: "desc" },
      take: HISTORY_PAGE_SIZE,
      select: { id: true, entityId: true, userEmail: true, createdAt: true, newValue: true },
    }),
    loadStatementData(tenantId, statementSelection, fromUtc, toUtc),
  ])
  // Schema default (model TenantConfig) when no config row exists yet.
  const tenantCommissionBps = tenantConfig?.referralCommissionBps ?? 0

  // Sequential, not folded into the Promise.all above: the pagination clamp
  // inside loadCommissionData needs queueTotal's real count first — see that
  // file for why (a re-review verified this ordering is load-bearing).
  const commissionData = await loadCommissionData({
    tenantId, queueWhere, queuePageRaw, queueTotal, reversedEvents, decidedAudits,
  })

  const commissionSummary = summariseCommission(commissionEvents)
  const commissionByAgent = summariseByAgent(
    commissionEvents.map((event) => ({
      agentId: event.agentId,
      agentName: event.agent?.displayName ?? "Unknown agent",
      commissionStatus: event.commissionStatus,
      commissionCents: event.commissionCents,
    })),
  )
  // needsCommissionAttention() excludes APPROVED and (by owner rule)
  // BLOCKED as resolved staff decisions, REVERSED as stale, and UNMATCHED_CODE
  // because it already gets its own attention row above.
  //
  // Deliberately asymmetric with queueWhere above: the queue is the actionable
  // work list (the only surface with decide/un-block buttons; the decision-history
  // section below it is read-only), so it must keep SHOWING a blocked event or
  // there would be no UI left to un-block it. This attention count answers "what
  // still needs a decision?", so a blocked event — already decided — drops out.
  const flaggedEventsCount = flaggedEvents.filter(needsCommissionAttention).length

  const clientAgents = agents.map((agent) => ({
    id: agent.id,
    displayName: agent.displayName,
    legalName: agent.legalName,
    phone: agent.phone,
    email: agent.email,
    channel: agent.channel,
    status: agent.status,
    commissionBps: agent.commissionBps,
    referralCodes: agent.referralCodes.map((code) => ({
      id: code.id,
      code: code.code,
      label: code.label,
      campaign: code.campaign,
      status: code.status,
    })),
  }))

  return (
    <div className="space-y-6 p-6 lg:p-8">
      <Breadcrumbs
        items={[
          { label: "CRM", href: "/crm" },
          { label: "Agent Hub" },
        ]}
      />
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-amber-500">Referral growth</p>
          <h1 className="mt-2 text-2xl font-bold text-[var(--cf-text)]">Agent Hub</h1>
          <p className="mt-2 max-w-2xl text-sm text-gray-400">
            Create approved agents, issue/pause referral codes, and decide commission eligibility after quality checks. Public user approval and payout still stay in the regulated LMS workflow.
          </p>
        </div>
        <Link href="/crm/leads" className="rounded-md border border-amber-500/30 px-4 py-2 text-sm font-semibold text-[var(--cf-warning)] hover:bg-amber-500/10">
          View leads
        </Link>
      </div>

      {periodError ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm font-semibold text-[var(--cf-danger)]">
          {periodError} — showing the default period below instead.
        </div>
      ) : null}

      <AgentHubTabs
        defaultTab={defaultTab}
        agentCount={agents.length}
        queueCount={queueTotal}
        overview={
          <OverviewTab
            summary={commissionSummary}
            byAgent={commissionByAgent}
            attention={{ unmatchedCodesCount: unmatchedEvents, flaggedEventsCount }}
            agents={clientAgents}
            tenantCommissionBps={tenantCommissionBps}
            canEditTenantRate={canEditTenantRate}
          />
        }
        agents={<AgentsTab agents={clientAgents} />}
        commission={
          <CommissionTab
            events={commissionData.events}
            clawbacks={commissionData.clawbacks}
            history={commissionData.history}
            historyTotal={historyTotal}
            page={commissionData.page}
            totalPages={commissionData.totalPages}
            periodFrom={periodFrom}
            periodTo={periodTo}
          />
        }
        statements={
          <StatementsTab
            agents={commissionByAgent}
            selection={statementSelection}
            periodFrom={periodFrom}
            periodTo={periodTo}
            groups={statementData.groups}
            totals={statementData.totals}
            requestedAgentCount={statementData.requestedAgentCount}
            unknownAgentIds={statementData.unknownAgentIds}
          />
        }
      />
    </div>
  )
}
