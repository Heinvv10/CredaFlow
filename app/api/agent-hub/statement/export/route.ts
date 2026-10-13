import { NextRequest, NextResponse } from "next/server"
import ExcelJS from "exceljs"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { prisma } from "@/lib/prisma"
import { logAuditStrict } from "@/lib/audit"
import { SAST_TIME_ZONE } from "@/lib/utils"
import { parsePeriod } from "@/lib/agent-hub/period"
import { summariseCommission } from "@/lib/agent-hub/summary"
import { loanIdsFromEvents } from "@/lib/agent-hub/borrower"
import { buildStatementRows, centsToRands, groupStatementRows, isMultiAgentStatement, statementFilename, statementScopeName, UNKNOWN_AGENT_KEY } from "@/lib/agent-hub/statement"
import { parseAgentSelection } from "@/lib/agent-hub/agent-selection"

// A per-agent commission statement — same row shape as the Statements tab
// preview (both go through buildStatementRows), rendered as a downloadable
// workbook rather than a table. LOAN_ADMIN, not the page's route-level guard:
// this is a single agent's full commission history, and exporting it is a
// POPIA-relevant access event (audited below), same posture as the Section
// 129 log and audit-log exports in app/api/reports/export/route.ts.
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  // getAll, not get: the Statements selector is a <select multiple>, so several
  // agentId params can arrive. Reading only the first would silently export one
  // agent while the filename and totals claimed to cover the selection.
  const selection = parseAgentSelection(req.nextUrl.searchParams.getAll("agentId"))
  if (selection.kind === "none") return NextResponse.json({ error: "agentId is required" }, { status: 400 })
  if (selection.kind === "too-many") {
    return NextResponse.json(
      { error: `Too many agents selected (${selection.count}). Use “All agents” instead.` },
      { status: 400 },
    )
  }

  // parsePeriod throws on a malformed or reversed range (see lib/agent-hub/period.ts).
  // That's a client error, not a server one — a route can't degrade silently the
  // way the page does, so reject explicitly instead of letting the throw 500.
  let period: ReturnType<typeof parsePeriod>
  try {
    period = parsePeriod(req.nextUrl.searchParams.get("from"), req.nextUrl.searchParams.get("to"))
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid period" }, { status: 400 })
  }

  return withTenantContext(req, async (tenant) => {
    // Resolved up front, tenant-scoped: an unknown/foreign agentId must 404
    // before anything else happens, so a garbage id neither writes a
    // POPIA access-register row for a non-existent agent nor falls back to
    // a raw cuid in the filename below.
    const agents = await prisma.referralAgent.findMany({
      where: { tenantId: tenant.id, ...(selection.kind === "some" ? { id: { in: selection.agentIds } } : {}) },
      select: { id: true, displayName: true },
      orderBy: { displayName: "asc" },
    })
    // Fail closed on a partial match. Silently dropping an id the tenant does
    // not own would hand back a workbook that looks complete but omits an agent
    // the operator asked for — and a payout run made against it would short that
    // agent with nothing on screen to say so.
    if (selection.kind === "some" && agents.length !== selection.agentIds.length) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 })
    }
    if (agents.length === 0) return NextResponse.json({ error: "Agent not found" }, { status: 404 })

    // Same eventType/field source as the Overview and Commission tabs' money
    // totals (commissionCents/commissionStatus is only ever set on CONVERTED).
    const agentEvents = await prisma.referralEvent.findMany({
      where: {
        tenantId: tenant.id,
        eventType: "CONVERTED",
        createdAt: { gte: period.fromUtc, lt: period.toUtc },
        ...(selection.kind === "some" ? { agentId: { in: selection.agentIds } } : {}),
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, createdAt: true, agentId: true, amountCents: true, commissionCents: true, commissionStatus: true, metadata: true,
      },
    })

    const loanIds = loanIdsFromEvents(agentEvents)
    const loans = loanIds.length
      ? await prisma.loan.findMany({
          where: { id: { in: loanIds }, tenantId: tenant.id },
          select: { id: true, reference: true, client: { select: { firstName: true, lastName: true } }, entity: { select: { legalName: true } }, product: { select: { name: true } } },
        })
      : []
    const loansById = new Map(loans.map((l) => [l.id, l]))

    const agentNameById = new Map(agents.map((a) => [a.id, a.displayName]))
    const rows = buildStatementRows(agentEvents, loansById, agentNameById)
    // From `rows`, the same input loadStatementData uses — not from the raw
    // events — so the two totals cannot diverge if row-building ever filters.
    const totals = summariseCommission(rows)
    const groups = groupStatementRows(rows)
    // Shared with the Statements tab preview: two separate expressions over two
    // different inputs (the roster here, the fetched groups there) disagreed for
    // the same query — a selection of two agents where only one had events in
    // the period rendered single-agent on screen and multi-agent in the file.
    const isMultiAgent = isMultiAgentStatement(agents.length, groups)

    const workbook = new ExcelJS.Workbook()
    workbook.creator = "LMS"
    workbook.created = new Date()
    const worksheet = workbook.addWorksheet("Statement")
    // The Agent column exists only on a multi-agent export, so a single-agent
    // workbook is byte-for-byte the shape finance already reconciles against.
    worksheet.columns = [
      ...(isMultiAgent ? [{ header: "Agent", key: "agent", width: 26 }] : []),
      { header: "Date", key: "date", width: 14 },
      { header: "Borrower", key: "borrower", width: 26 },
      { header: "Loan Reference", key: "loanReference", width: 18 },
      { header: "Product", key: "product", width: 20 },
      { header: "Principal (R)", key: "principal", width: 16 },
      { header: "Commission (R)", key: "commission", width: 16 },
      { header: "Status", key: "status", width: 14 },
    ]
    // Numeric rands, not formatted strings (addendum item 7) — via
    // centsToRands, the one conversion point — so Excel can sum the column.
    for (const group of groups) {
      worksheet.addRows(group.rows.map((row) => ({
        ...(isMultiAgent ? { agent: row.agentName } : {}),
        date: new Date(row.createdAt).toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }),
        borrower: row.borrower?.clientName ?? "",
        loanReference: row.borrower?.loanReference ?? "",
        product: row.borrower?.productName ?? "",
        principal: centsToRands(row.principalCents),
        commission: centsToRands(row.commissionCents),
        status: row.commissionStatus,
      })))
      if (isMultiAgent) {
        // The per-agent figure a payout is made against. Bold so it is not
        // mistaken for another referral row when the column is summed by eye.
        const subtotal = worksheet.addRow({
          borrower: `Subtotal — ${group.agentName}`,
          commission: centsToRands(group.totals.netOwedCents),
        })
        subtotal.font = { bold: true }
        worksheet.addRow({})
      }
    }
    // Also covers the multi-agent-but-no-groups case, where the loop above
    // added nothing and the grand total would otherwise abut the header.
    if (!isMultiAgent || groups.length === 0) worksheet.addRow({})
    const grandTotal = worksheet.addRow({
      borrower: isMultiAgent ? "Net owed (all selected agents)" : "Net owed (pending + payable)",
      commission: centsToRands(totals.netOwedCents),
    })
    grandTotal.font = { bold: true }
    worksheet.getRow(1).font = { bold: true }
    worksheet.getRow(1).alignment = { vertical: "middle" }
    worksheet.views = [{ state: "frozen", ySplit: 1 }]

    const buffer = await workbook.xlsx.writeBuffer()
    // Sourced from the agent lookup above, not the events: a zero-events period
    // (an agent with no referrals that month) is a legitimate statement and must
    // still get the agent's real name, not a fallback.
    const scopeName = statementScopeName(selection.kind === "all", agents.map((a) => a.displayName))
    const filename = statementFilename(scopeName, period.label)

    // Fail closed: no statement bytes leave the server unless the access event
    // is durably recorded — mirrors SECTION_129_REGISTER_EXPORTED.
    //
    // ONE ROW PER AGENT, not one per download. Exporting eight agents is eight
    // POPIA access events; a single row keyed to the first agent would leave
    // the other seven with no record that their commission history was read,
    // and a subject-access request against them would come back empty.
    // Deliberately sequential and before the response: a partial failure aborts
    // the download, which over-records access rather than under-recording it.
    const rowCountByAgent = new Map(groups.map((g) => [g.agentId, g.rows.length]))
    // The audited set is the UNION of the agents that were asked for and the
    // agents whose rows are actually in the workbook. Iterating the roster alone
    // left an agent whose rows shipped inside the file with no access record at
    // all — the exact gap this per-agent register exists to close.
    // UNKNOWN_AGENT_KEY is excluded: it is a grouping bucket for rows with no
    // agent, not a person, and must never be written as an entityId.
    const auditedAgentIds = [
      ...new Set([
        ...agents.map((a) => a.id),
        ...groups.map((g) => g.agentId).filter((id) => id !== UNKNOWN_AGENT_KEY),
      ]),
    ]
    for (const agentId of auditedAgentIds) {
      await logAuditStrict({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: "REFERRAL_AGENT_STATEMENT_EXPORTED",
        entity: "ReferralAgent",
        entityId: agentId,
        newValue: {
          period: period.label,
          // This agent's own rows, not the workbook's — the register should say
          // what was read about THIS person.
          rowCount: rowCountByAgent.get(agentId) ?? 0,
          exportScope: selection.kind === "all" ? "ALL_AGENTS" : "SELECTION",
          agentCount: auditedAgentIds.length,
        },
      })
    }

    return new NextResponse(Buffer.from(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    })
  })
}
