import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { loanIdsFromEvents, resolveBorrower, type Borrower } from "@/lib/agent-hub/borrower"
import { matchDecidedHistory, type DecidedAuditRow, type DecidedHistoryRow } from "@/lib/agent-hub/decided-history"
import { pageOffsets, totalPages as computeTotalPages, clampPage } from "@/lib/agent-hub/pagination"
import { detectSignals, type TriageSignal } from "@/lib/agent-hub/triage-signals"
import { parseLastDecision, type LastDecision } from "@/lib/agent-hub/last-decision"

const QUEUE_PAGE_SIZE = 25

type ReversedEvent = {
  id: string
  commissionCents: number | null
  createdAt: Date
  metadata: unknown
  code: { code: string; label: string | null; agent: { displayName: string } } | null
}

type CommissionEvent = {
  id: string
  eventType: string
  source: string | null
  amountCents: number | null
  commissionStatus: string
  commissionCents: number | null
  qualityFlag: string | null
  attributionRaw: string | null
  createdAt: string
  code: { code: string; label: string | null; agent: { displayName: string } } | null
  lead: { id: string; firstName: string; lastName: string; status: string; requestedAmount: number | null } | null
  borrower: Borrower | null
  signals: TriageSignal[]
  lastDecision: LastDecision | null
}

type CommissionClawback = {
  id: string
  commissionCents: number | null
  createdAt: string
  code: { code: string; label: string | null; agent: { displayName: string } } | null
  loanId: string | null
  loanReference: string | null
}

// Commission-tab data assembly, colocated with page.tsx rather than under
// lib/agent-hub/ — every module there is deliberately I/O-free, and this one
// isn't. Must be awaited AFTER the page's Promise.all resolves, not folded
// into it: the pagination clamp below needs queueTotal's real count, which
// doesn't exist until that Promise.all settles — a re-review verified this
// ordering is load-bearing (an unclamped `?page=` can skip past a shrunk
// queue). recentEvents, the clawback lookup, and the decided-history lookup
// all inherit that same "after" placement from the block this was extracted
// from; only the pagination clamp them all now hangs off is unavoidably
// sequential — none of these three could move earlier on their own.
export async function loadCommissionData(opts: {
  tenantId: string
  queueWhere: Prisma.ReferralEventWhereInput
  queuePageRaw: number
  queueTotal: number
  reversedEvents: ReversedEvent[]
  decidedAudits: DecidedAuditRow[]
}): Promise<{ events: CommissionEvent[]; clawbacks: CommissionClawback[]; history: DecidedHistoryRow[]; page: number; totalPages: number }> {
  const { tenantId, queueWhere, queuePageRaw, queueTotal, reversedEvents, decidedAudits } = opts

  const totalPages = computeTotalPages(queueTotal, QUEUE_PAGE_SIZE)
  const page = clampPage(queuePageRaw, totalPages)
  const { skip, take } = pageOffsets(page, QUEUE_PAGE_SIZE)

  // commissionStatus excluded explicitly: a REVERSED row can carry a stale
  // qualityFlag set before reversal (e.g. "APPROVED"), which would otherwise
  // still match the qualityFlag arm above and resurface in the editable queue.
  const recentEvents = await prisma.referralEvent.findMany({
    where: queueWhere,
    orderBy: { createdAt: "desc" },
    skip,
    take,
    include: {
      code: { select: { code: true, label: true, agent: { select: { displayName: true } } } },
      lead: { select: { id: true, firstName: true, lastName: true, status: true, requestedAmount: true } },
    },
  })

  // metadata is set once at CONVERTED creation ({ loanId, principalCents, bps }) and never
  // updated on reversal, so loanId is the only linkable reference a clawback row carries.
  const reversedWithLoanId = reversedEvents.map((event) => {
    const metadata = event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
      ? (event.metadata as Record<string, unknown>)
      : {}
    return { event, loanId: typeof metadata.loanId === "string" ? metadata.loanId : null }
  })
  const clawbackLoanIds = [...new Set(reversedWithLoanId.map((r) => r.loanId).filter((id): id is string => id !== null))]
  const clawbackLoans = clawbackLoanIds.length
    ? await prisma.loan.findMany({ where: { id: { in: clawbackLoanIds }, tenantId }, select: { id: true, reference: true } })
    : []
  const loanRefById = new Map(clawbackLoans.map((loan) => [loan.id, loan.reference]))

  // Borrower resolution for the commission queue. Mirrors the clawback join above.
  const loanIds = loanIdsFromEvents(recentEvents)
  const loans = loanIds.length
    ? await prisma.loan.findMany({
        where: { id: { in: loanIds }, tenantId },
        select: { id: true, reference: true, client: { select: { id: true, firstName: true, lastName: true, phone: true } }, product: { select: { name: true } } },
      })
    : []
  const loansById = new Map(loans.map((l) => [l.id, l]))

  // Whole-book CONVERTED events, fetched once and reused below for both the
  // loan -> client map and the repeat-pair count — a prior version ran two
  // separate full scans of this same base row set (tenantId + CONVERTED),
  // narrowed only by agentId on the second. That filter now happens in the
  // loop below instead of the `where`.
  const convertedEvents = await prisma.referralEvent.findMany({
    where: { tenantId, eventType: "CONVERTED" },
    select: { agentId: true, metadata: true },
  })
  const loanIdOfConverted = (metadata: unknown): string | null => {
    const m = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {}
    return typeof m.loanId === "string" ? m.loanId : null
  }

  // Whole-book loan -> client map, so repeat counting is not limited to one page.
  const allConvertedLoanIds = [...new Set(convertedEvents.map((r) => loanIdOfConverted(r.metadata)).filter((id): id is string => id !== null))]
  const allLoans = allConvertedLoanIds.length
    ? await prisma.loan.findMany({ where: { id: { in: allConvertedLoanIds }, tenantId }, select: { id: true, clientId: true } })
    : []
  const clientIdByLoanId = new Map(allLoans.map((l) => [l.id, l.clientId]))

  // Agents are a small roster (12 in production), so fetching all of them is
  // cheaper than a per-row lookup and lets a borrower match ANY agent, not just
  // the referring one.
  const agents = await prisma.referralAgent.findMany({
    where: { tenantId },
    select: { id: true, displayName: true, phone: true },
  })

  const pairCounts = new Map<string, { agentId: string; clientId: string; count: number }>()
  for (const row of convertedEvents) {
    const loanId = loanIdOfConverted(row.metadata)
    const clientId = loanId ? (clientIdByLoanId.get(loanId) ?? null) : null
    // row.agentId null here stands in for the dropped `agentId: { not: null }` where-filter.
    if (!row.agentId || !clientId) continue
    const key = `${row.agentId}:${clientId}`
    const existing = pairCounts.get(key)
    if (existing) existing.count += 1
    else pairCounts.set(key, { agentId: row.agentId, clientId, count: 1 })
  }
  const repeatPairs = [...pairCounts.values()].filter((p) => p.count > 1)

  // Decided history: join the audit rows to the events they decided.
  const decidedEventIds = [...new Set(decidedAudits.map((a) => a.entityId).filter((id): id is string => id !== null))]
  const decidedEvents = decidedEventIds.length
    ? await prisma.referralEvent.findMany({
        where: { id: { in: decidedEventIds }, tenantId },
        select: {
          id: true,
          eventType: true,
          commissionCents: true,
          code: { select: { code: true, label: true, agent: { select: { displayName: true } } } },
          lead: { select: { id: true, firstName: true, lastName: true } },
        },
      })
    : []
  const decidedEventsById = new Map(decidedEvents.map((e) => [e.id, e]))
  const history = matchDecidedHistory(decidedAudits, decidedEventsById)

  const events = recentEvents.map((event) => {
    const borrower = resolveBorrower(event, loansById)
    const loan = borrower ? loansById.get(borrower.loanId) : null
    const client = loan && "client" in loan ? (loan.client as { id?: string; phone?: string }) : null
    return {
      id: event.id,
      eventType: event.eventType,
      source: event.source,
      amountCents: event.amountCents,
      commissionStatus: event.commissionStatus,
      commissionCents: event.commissionCents,
      qualityFlag: event.qualityFlag,
      attributionRaw: event.attributionRaw,
      createdAt: event.createdAt.toISOString(),
      code: event.code,
      lead: event.lead,
      borrower,
      // OWNER RULING (2026-08-07): never suppressed while the row is in the
      // queue. A prior decision does NOT take a row out of queueWhere (Block
      // sets qualityFlag LOW_QUALITY, which the filter's `qualityFlag not
      // null` arm still matches), so hiding its signals left the one-click
      // "Mark payable" path armed on a row that demonstrably raised one —
      // recording "no triage signals raised" and releasing the money. A
      // decided row therefore keeps showing WHY it was flagged, which is what
      // the second reviewer needs anyway.
      signals: detectSignals({
        borrowerClientId: client?.id ?? null,
        borrowerPhone: client?.phone ?? null,
        referringAgentId: event.agentId,
        agents,
        repeatPairs,
      }),
      // Read off the metadata already fetched above — no extra query. Parsed
      // into named fields rather than handed over raw: metadata is jsonb and
      // this crosses to a client component. It marks a row as already decided
      // ALONGSIDE its signals; it must never gate them (see the ruling above).
      lastDecision: parseLastDecision(event.metadata),
    }
  })

  const clawbacks = reversedWithLoanId.map(({ event, loanId }) => ({
    id: event.id,
    commissionCents: event.commissionCents,
    createdAt: event.createdAt.toISOString(),
    code: event.code,
    loanId,
    loanReference: loanId ? (loanRefById.get(loanId) ?? null) : null,
  }))

  return { events, clawbacks, history, page, totalPages }
}
