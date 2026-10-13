import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { CASH_RECEIPTS, displayPaymentMethod } from "@/lib/payments/waiver"
import { getTenantFromRequest } from "@/lib/tenant"
import ExcelJS from "exceljs"
import { getFscaReturnData } from "@/lib/fsca-return"
import {
  parseQuarterParam,
  quarterBounds,
  quarterLabel,
  sastMonthBounds,
} from "@/lib/compliance/quarters"
import { getNcrReturnData, parWhere } from "@/lib/compliance/ncr-return"
import { logAuditStrict } from "@/lib/audit"
import { SAST_TIME_ZONE } from "@/lib/utils"
import { section129LogRow } from "@/lib/collections/section129-reporting"
import { arrearsBucket } from "@/lib/reports/arrears-buckets"
import { periodFilter, resolvePeriod } from "@/lib/date/sast-period"
import { COLLECTIBLE_STATUSES } from "@/lib/loan/collectible-book"
import {
  documentAccessTimelineEntries,
  mergeAuditTimeline,
  readTenantDocumentAccess,
  type AuditTimelineEntry,
  type DocumentAccessReader,
} from "@/lib/audit/document-access-timeline"
import { sastParts } from "@/lib/date/sast"
import { cashReceivedCents } from "@/lib/payments/waiver"
import { chargesLiveForTenant } from "@/lib/loan/charges-replay"
import { chargesOwing } from "@/lib/reports/charges-owing"
import { borrowerDisplayName } from "@/lib/borrower"

type ExportRow = Record<string, string | number | boolean | null | undefined>

function createWorkbook(sheets: Array<{ name: string; rows: ExportRow[] }>) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = "LMS"
  workbook.created = new Date()

  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name.slice(0, 31))
    const columns = Array.from(new Set(sheet.rows.flatMap((row) => Object.keys(row))))
    worksheet.columns = columns.map((key) => ({
      header: key,
      key,
      width: Math.max(14, Math.min(34, key.length + 4)),
    }))
    worksheet.addRows(sheet.rows)
    worksheet.getRow(1).font = { bold: true }
    worksheet.getRow(1).alignment = { vertical: "middle" }
    worksheet.views = [{ state: "frozen", ySplit: 1 }]
  }

  return workbook
}

async function workbookResponse(workbook: ExcelJS.Workbook, filename: string) {
  const buffer = await workbook.xlsx.writeBuffer()
  return new NextResponse(Buffer.from(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  })
}

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  const tenant = await getTenantFromRequest(req)
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 400 })

  const type = req.nextUrl.searchParams.get("type") ?? "loans"

  let wb: ExcelJS.Workbook
  const now = new Date()

  if (type === "loans") {
    const chargesLive = await chargesLiveForTenant(prisma, tenant.id)
    const loans = await prisma.loan.findMany({
      where: { tenantId: tenant.id },
      include: {
        client: { select: { firstName: true, lastName: true, idNumber: true, phone: true, email: true } },
        entity: { select: { legalName: true } },
        product: { select: { name: true } },
        payments: { select: { amount: true, paymentMethod: true, reversed: true, allocationStatus: true } },
      },
      orderBy: { startDate: "desc" },
    })

    const rows = loans.map((l) => ({
      Reference: l.reference,
      Client: borrowerDisplayName(l),
      "ID Number": l.client?.idNumber ?? "",
      Phone: l.client?.phone ?? "",
      Email: l.client?.email ?? "",
      Product: l.product.name,
      Principal: l.principal / 100,
      "Total Interest": l.totalInterest / 100,
      "Total Repayable": l.totalRepayable / 100,
      "Outstanding Principal": l.outstandingPrincipal / 100,
      // Cash received; Loan.totalPaid is only the share applied to the instalments.
      "Total Paid": cashReceivedCents(l.payments) / 100,
      Status: l.status,
      "Days in Arrears": l.daysInArrears,
      "Arrears Amount": l.arrearsAmount / 100,
      // Beside the instalment arrears, never inside them; 0 unless charges are live.
      "Default Charges Owing (R)": chargesOwing(l, chargesLive) / 100,
      "Start Date": l.startDate.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }),
      "Maturity Date": l.maturityDate.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }),
      "Next Payment": l.nextPaymentDate?.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }) ?? "",
    }))

    wb = createWorkbook([{ name: "Active Loans", rows }])
  } else if (type === "par") {
    const chargesLive = await chargesLiveForTenant(prisma, tenant.id)
    const loans = await prisma.loan.findMany({
      where: { tenantId: tenant.id, status: { in: [...COLLECTIBLE_STATUSES] }, daysInArrears: { gt: 0 } },
      include: {
        client: { select: { firstName: true, lastName: true, idNumber: true } },
        entity: { select: { legalName: true } },
        product: { select: { name: true } },
      },
    })

    const rows = loans.map((l) => ({
      Reference: l.reference,
      Client: borrowerDisplayName(l),
      "ID Number": l.client?.idNumber ?? "",
      Product: l.product.name,
      "Days in Arrears": l.daysInArrears,
      Bucket: arrearsBucket(l.daysInArrears),
      "Arrears Amount (R)": l.arrearsAmount / 100,
      "Default Charges Owing (R)": chargesOwing(l, chargesLive) / 100,
      "Outstanding Principal (R)": l.outstandingPrincipal / 100,
      Status: l.status,
    }))

    wb = createWorkbook([{ name: "PAR Report", rows }])
  } else if (type === "payments") {
    // Scoped to the period on screen. It used to export every payment the
    // tenant had ever taken whatever was on display, which made a "last month"
    // spreadsheet quietly untrue.
    //
    // It is NOT the Allocated tab's row set, deliberately: no allocationStatus
    // or reversed filter, so the sheet is the full receipt ledger for the
    // period — allocated, unapplied, refunded and reversed alike, each labelled
    // by its own `Allocation Status` and `Reversed` columns. That is what makes
    // it useful for reconciling against a bank statement, where every receipt
    // appears regardless of how this system later classified it. The button is
    // labelled "all receipts" so the difference from the tab is stated rather
    // than discovered in Excel.
    const period = resolvePeriod(
      {
        period: req.nextUrl.searchParams.get("period"),
        from: req.nextUrl.searchParams.get("from"),
        to: req.nextUrl.searchParams.get("to"),
      },
      new Date(),
    )
    const payments = await prisma.payment.findMany({
      where: { tenantId: tenant.id, receivedAt: periodFilter(period) },
      include: {
        loan: {
          select: {
            reference: true,
            client: { select: { firstName: true, lastName: true, idNumber: true } },
            entity: { select: { legalName: true } },
          },
        },
      },
      orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
    })

    const rows = payments.map((p) => ({
      "Loan Reference": p.loan.reference,
      Client: borrowerDisplayName(p.loan),
      "ID Number": p.loan.client?.idNumber ?? "",
      "Amount (R)": p.amount / 100,
      Method: displayPaymentMethod(p.paymentMethod, (method) => method),
      Reference: p.reference ?? "",
      Notes: p.notes ?? "",
      "Allocation Status": p.allocationStatus,
      "Reconciliation Reason": p.reconciliationReason ?? "",
      "Reconciliation Reference": p.reconciliationReference ?? "",
      Reversed: p.reversed ? "Yes" : "No",
      "Captured By": p.capturedBy ?? "",
      // Value date — when the money reached us. This column was `createdAt`,
      // the keystroke date, so the spreadsheet dated receipts differently from
      // the screen it was exported from and from the client's own statement.
      Date: p.receivedAt.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }),
      // Kept, not dropped: it is the audit answer to "when did we key this in".
      "Captured At": p.createdAt.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }),
    }))

    wb = createWorkbook([{ name: `Payments — ${period.label}`, rows }])
  } else if (type === "collections") {
    const loans = await prisma.loan.findMany({
      where: { tenantId: tenant.id, daysInArrears: { gt: 0 }, status: { in: [...COLLECTIBLE_STATUSES] } },
      include: {
        client: { select: { firstName: true, lastName: true, idNumber: true, phone: true, email: true } },
        entity: { select: { legalName: true } },
        product: { select: { name: true } },
      },
      orderBy: { daysInArrears: "desc" },
    })

    const rows = loans.map((l) => ({
      Reference: l.reference,
      Client: borrowerDisplayName(l),
      "ID Number": l.client?.idNumber ?? "",
      Phone: l.client?.phone ?? "",
      Email: l.client?.email ?? "",
      Product: l.product.name,
      "Days in Arrears": l.daysInArrears,
      "Arrears Amount (R)": l.arrearsAmount / 100,
      "Outstanding (R)": l.outstandingPrincipal / 100,
      Status: l.status,
    }))

    wb = createWorkbook([{ name: "Collections Queue", rows }])
  } else if (type === "affordability") {
    const applications = await prisma.loanApplication.findMany({
      where: { tenantId: tenant.id, status: { in: ["APPROVED", "DISBURSED", "DECLINED"] } },
      include: {
        client: { select: { firstName: true, lastName: true, idNumber: true } },
        entity: { select: { legalName: true } },
        product: { select: { name: true } },
        approvedBy: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
    })

    const rows = applications.map((a) => ({
      Reference: a.reference,
      Client: borrowerDisplayName(a),
      "ID Number": a.client?.idNumber ?? "",
      Product: a.product.name,
      "Applied Amount (R)": a.appliedAmount / 100,
      "Approved Amount (R)": a.approvedAmount != null ? a.approvedAmount / 100 : "",
      "Term (Days)": a.appliedTermDays,
      "Net Disposable Income (R)": a.netDisposableIncome != null ? a.netDisposableIncome / 100 : "",
      "Affordability NDI (R)": a.affordabilityNDI != null ? a.affordabilityNDI / 100 : "",
      "Total Existing Debt (R)": a.totalExistingDebt != null ? a.totalExistingDebt / 100 : "",
      "Reckless Lending Assessed": a.recklessLendingAssessed ? "Yes" : "No",
      "Reckless Assessment Note": a.recklessLendingNote ?? "",
      "Income Verification Method": a.incomeVerificationMethod ?? "",
      "Assessed By": a.approvedBy?.name ?? "",
      Status: a.status,
      "Submitted At": a.submittedAt?.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }) ?? "",
      "Approved At": a.approvedAt?.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }) ?? "",
    }))

    wb = createWorkbook([{ name: "Affordability Register", rows }])
  } else if (type === "ncr-quarterly") {
    // Two sheets of this workbook carry client ID numbers and full names, so a
    // generic READONLY export permission is too broad — same reasoning as the
    // section129-register and audit-log branches. The audit row below was added
    // for parity with those branches; this gate is the other half of it.
    const upgraded = await requireApiRole("LOAN_ADMIN")
    if (upgraded.error) return upgraded.error

    // Every summary figure comes from lib/compliance/ncr-return.ts, the same
    // source the screen renders. This branch used to compute its own — with
    // `> 30` DPD where the screen used `>= 30`, an all-time "active loans"
    // figure derived by subtraction, and write-offs stated in original
    // principal — so the workbook and the page disagreed line by line.
    const quarter = parseQuarterParam(
      req.nextUrl.searchParams.get("quarter") ?? undefined,
      now,
    )
    const ncr = await getNcrReturnData(tenant.id, quarter, now)
    const { start: qStart, end: qEndExclusive } = quarterBounds(quarter)

    const [disbursed, arrears] = await Promise.all([
      prisma.loan.findMany({
        where: { tenantId: tenant.id, startDate: { gte: qStart, lt: qEndExclusive } },
        include: {
          client: { select: { idNumber: true, firstName: true, lastName: true } },
          entity: { select: { legalName: true } },
          product: { select: { name: true } },
        },
      }),
      prisma.loan.findMany({
        where: { ...parWhere(tenant.id, 1) },
        include: {
          client: { select: { idNumber: true, firstName: true, lastName: true } },
          entity: { select: { legalName: true } },
        },
      }),
    ])

    // A submitted quarter exports what was FILED, not the live book — the same
    // rule the screen follows. Otherwise the workbook for a closed, filed
    // quarter silently reports today's arrears under that quarter's heading.
    const exportLines = ncr.filed?.lines ?? ncr.lines
    const asFiled = ncr.filed !== null

    // Sheet 1: the return itself. Metadata lives on its own sheet rather than
    // sharing this one — `createWorkbook` derives columns from the union of all
    // row keys, so mixing {Metric, Value} header rows with the figure rows put
    // money in column B for the header block and column D for every figure,
    // leaving column B blank down the whole statutory table.
    const summaryRows = exportLines.map((l) => ({
      Line: l.label,
      Basis: l.basis === "PERIOD"
        ? "In-quarter"
        : asFiled ? "Position as filed" : "Position at export",
      Count: l.count ?? "",
      "Value (R)": l.value === null ? "" : l.value / 100,
      "% of book": l.percentOfBook === undefined ? "" : Number(l.percentOfBook.toFixed(1)),
      // Without the note an auditor reads an arrears value and a percentage
      // that cannot be derived from each other, with no explanation.
      Note: l.note ?? "",
    }))

    // Sheet 0: provenance.
    const infoRows = [
      { Field: "NCR Registration Number", Value: ncr.ncrNumber },
      { Field: "Quarter", Value: quarterLabel(quarter) },
      { Field: "Reporting Period Start", Value: ncr.periodStart.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }) },
      { Field: "Reporting Period End", Value: ncr.periodEnd.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }) },
      { Field: "Report Generated", Value: now.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }) },
      {
        Field: "Return Status",
        Value: ncr.submittedAt
          ? `Submitted ${ncr.submittedAt.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE })}`
          : "Not submitted",
      },
      {
        Field: "Position Basis",
        Value: asFiled
          ? "Position lines are the figures frozen at submission"
          : ncr.positionIsStale
            ? "Position lines reflect the book today, NOT the quarter end"
            : "Position lines reflect the book at generation",
      },
    ]

    // Sheet 2: Disbursements this quarter
    const disbursementRows = disbursed.map((l) => ({
      Reference: l.reference,
      "Client ID Number": l.client?.idNumber ?? "",
      "Client Name": borrowerDisplayName(l),
      Product: l.product.name,
      "Principal (R)": l.principal / 100,
      "Interest Rate (pm %)": l.interestRatePm,
      "Disbursement Date": l.startDate.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }),
    }))

    // Sheet 3: Arrears register
    const arrearsRows = arrears.map((l) => ({
      Reference: l.reference,
      "Client ID Number": l.client?.idNumber ?? "",
      "Client Name": borrowerDisplayName(l),
      "Days in Arrears": l.daysInArrears,
      "Arrears Amount (R)": l.arrearsAmount / 100,
      "Outstanding Principal (R)": l.outstandingPrincipal / 100,
      "Original Principal (R)": l.principal / 100,
    }))

    wb = createWorkbook([
      { name: "Return Info", rows: infoRows },
      { name: "NCR Summary", rows: summaryRows },
      { name: "Disbursements", rows: disbursementRows },
      { name: "Arrears Register", rows: arrearsRows },
    ])

    // Two sheets of this workbook carry client ID numbers and full names. Every
    // other bulk identity export in this handler writes an audit row
    // (section129-register, audit-log); this branch did not.
    await logAuditStrict({
      tenantId: tenant.id,
      // The upgraded LOAN_ADMIN principal, not the READONLY guard from the top
      // of the handler — the audit row must name who actually cleared the gate.
      userId: upgraded.user?.id,
      userEmail: upgraded.user?.email ?? undefined,
      action: "NCR_QUARTERLY_EXPORTED",
      entity: "Report",
      entityId: `ncr-quarterly:${quarter}`,
      newValue: {
        quarter,
        asFiled,
        disbursementRows: disbursementRows.length,
        arrearsRows: arrearsRows.length,
      },
    })
  } else if (type === "credit-agreements") {
    const loans = await prisma.loan.findMany({
      where: { tenantId: tenant.id, status: { in: ["ACTIVE", "COMPLETED", "DEFAULTED", "WRITTEN_OFF"] } },
      include: {
        client: { select: { firstName: true, lastName: true, idNumber: true, phone: true, email: true } },
        entity: { select: { legalName: true } },
        product: { select: { name: true } },
        application: { select: { pasqAcknowledgedAt: true, agreementSignedAt: true, appliedTermDays: true } },
      },
      orderBy: { startDate: "desc" },
    })

    const rows = loans.map((l) => ({
      "Agreement Number": l.reference,
      "Client Full Name": borrowerDisplayName(l),
      "ID / Passport Number": l.client?.idNumber ?? "",
      "Phone Number": l.client?.phone ?? "",
      "Email": l.client?.email ?? "",
      "Product Type": l.product.name,
      "Principal Amount (R)": l.principal / 100,
      "Initiation Fee (R)": l.initiationFee / 100,
      "Total Interest (R)": l.totalInterest / 100,
      "Total Repayable (R)": l.totalRepayable / 100,
      "Interest Rate (pm %)": l.interestRatePm,
      "Interest Model": l.interestModel,
      "Term (Days)": l.application.appliedTermDays,
      "Agreement Date": l.startDate.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }),
      "Maturity Date": l.maturityDate.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }),
      "PASQ Acknowledged": l.application.pasqAcknowledgedAt?.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }) ?? "Not acknowledged",
      "Agreement Signed": l.application.agreementSignedAt?.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }) ?? "Not signed",
      "Status": l.status,
    }))

    wb = createWorkbook([{ name: "Credit Agreements Register", rows }])
  } else if (type === "section129-log") {
    // The legal register contains ID numbers, addresses, recipient details and
    // financial snapshots. A generic READONLY export permission is too broad.
    const upgraded = await requireApiRole("LOAN_ADMIN")
    if (upgraded.error) return upgraded.error

    const records = await prisma.complianceRecord.findMany({
      where: { tenantId: tenant.id, type: "SECTION_129_NOTICE" },
      orderBy: { createdAt: "desc" },
    })

    const rows = records.map((record) => section129LogRow(
      record,
      (date) => date.toLocaleString("en-ZA", { timeZone: SAST_TIME_ZONE }),
    ))

    wb = createWorkbook([{ name: "Section 129 Log", rows }])
    // Fail closed: no PII-rich workbook bytes leave the server unless the
    // access event is durably recorded.
    await logAuditStrict({
      tenantId: tenant.id,
      userId: upgraded.user.id,
      userEmail: upgraded.user.email,
      action: "SECTION_129_REGISTER_EXPORTED",
      entity: "ComplianceRecord",
      newValue: { rowCount: records.length },
    })
  } else if (type === "reckless-lending") {
    const applications = await prisma.loanApplication.findMany({
      where: { tenantId: tenant.id, status: { in: ["APPROVED", "DISBURSED", "DECLINED"] } },
      include: {
        client: { select: { firstName: true, lastName: true, idNumber: true } },
        entity: { select: { legalName: true } },
        product: { select: { name: true } },
        approvedBy: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
    })

    const rows = applications.map((a) => ({
      "Application Reference": a.reference,
      "Client Full Name": borrowerDisplayName(a),
      "ID Number": a.client?.idNumber ?? "",
      "Product": a.product.name,
      "Applied Amount (R)": a.appliedAmount / 100,
      "Approved Amount (R)": a.approvedAmount != null ? a.approvedAmount / 100 : "",
      "Term (Days)": a.appliedTermDays,
      "Net Disposable Income (R)": a.netDisposableIncome != null ? a.netDisposableIncome / 100 : "",
      "Affordability NDI (R)": a.affordabilityNDI != null ? a.affordabilityNDI / 100 : "",
      "Total Existing Debt (R)": a.totalExistingDebt != null ? a.totalExistingDebt / 100 : "",
      "Income Verification Method": a.incomeVerificationMethod ?? "",
      "Reckless Lending Assessed": a.recklessLendingAssessed ? "Yes" : "No",
      "Assessment Note": a.recklessLendingNote ?? "",
      "Assessed By": a.approvedBy?.name ?? "",
      "Application Status": a.status,
      "Submitted At": a.submittedAt?.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }) ?? "",
      "Decision Date": a.approvedAt?.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }) ?? "",
    }))

    wb = createWorkbook([{ name: "Reckless Lending Audit", rows }])
  } else if (type === "reconciliation") {
    // SAST month bounds, end-EXCLUSIVE. This was the last day of the month at
    // local 23:59:59, filtered `lte` — which both resolved in UTC (two hours
    // adrift of the South African month) and dropped the final second of the
    // month, since a timestamp at 23:59:59.500 is greater than 23:59:59.000.
    const { start: mStart, end: mEndExclusive } = sastMonthBounds(now)

    const [branches, scheduleItems, payments, disbursements] = await Promise.all([
      prisma.branch.findMany({ where: { tenantId: tenant.id }, select: { id: true, name: true, code: true } }),
      prisma.repaymentSchedule.findMany({
        where: { tenantId: tenant.id, dueDate: { gte: mStart, lt: mEndExclusive } },
        include: {
          loan: {
            select: {
              application: { select: { branchId: true } },
            },
          },
        },
      }),
      prisma.payment.findMany({
        where: {
          tenantId: tenant.id,
          receivedAt: { gte: mStart, lt: mEndExclusive },
          reversed: false,
          allocationStatus: "ALLOCATED",
          // Actual collections are cash: a waived balance is not collected.
          ...CASH_RECEIPTS,
        },
        include: {
          loan: {
            select: {
              application: { select: { branchId: true } },
            },
          },
        },
      }),
      prisma.loan.findMany({
        where: { tenantId: tenant.id, startDate: { gte: mStart, lt: mEndExclusive } },
        include: {
          application: { select: { branchId: true } },
        },
      }),
    ])

    const branchMap = new Map(branches.map((b) => [b.id, b]))
    const unassigned = { id: "unassigned", name: "Unassigned / Head Office", code: "HO" }

    type BranchStats = {
      name: string; code: string
      expectedCollections: number; actualCollections: number
      disbursements: number; disbursementCount: number
      shortfall: number
    }
    const stats = new Map<string, BranchStats>()

    const getBranch = (branchId: string | null | undefined) => {
      const b = branchId ? (branchMap.get(branchId) ?? unassigned) : unassigned
      if (!stats.has(b.id)) {
        stats.set(b.id, { name: b.name, code: b.code, expectedCollections: 0, actualCollections: 0, disbursements: 0, disbursementCount: 0, shortfall: 0 })
      }
      return stats.get(b.id)!
    }

    for (const s of scheduleItems) {
      getBranch(s.loan.application?.branchId).expectedCollections += s.totalDue
    }
    for (const p of payments) {
      getBranch(p.loan.application?.branchId).actualCollections += p.amount
    }
    for (const l of disbursements) {
      const b = getBranch(l.application?.branchId)
      b.disbursements += l.principal
      b.disbursementCount += 1
    }

    const rows = Array.from(stats.values()).map((s) => ({
      Branch: s.name,
      Code: s.code,
      "Expected Collections (R)": s.expectedCollections / 100,
      "Actual Collections (R)": s.actualCollections / 100,
      "Shortfall / (Surplus) (R)": (s.expectedCollections - s.actualCollections) / 100,
      "Collection Rate (%)": s.expectedCollections > 0 ? ((s.actualCollections / s.expectedCollections) * 100).toFixed(1) : "N/A",
      "Disbursements (R)": s.disbursements / 100,
      "New Loans": s.disbursementCount,
    }))

    const month = now.toLocaleString("en-ZA", { month: "long", year: "numeric", timeZone: SAST_TIME_ZONE })
    wb = createWorkbook([{ name: `Reconciliation ${month}`, rows }])
  } else if (type === "fsca-annual") {
    // SAST year. The FSCA annual return is filed for a South African year.
    const year = sastParts(now).year

    const [policies, complaints] = await Promise.all([
      prisma.insurancePolicy.findMany({
        include: {
          client: { select: { firstName: true, lastName: true } },
          insurer_rel: { select: { name: true } },
        },
        orderBy: { startDate: "desc" },
      }),
      prisma.complaint.findMany({
        where: { tenantId: tenant.id },
        include: {
          client: { select: { firstName: true, lastName: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
    ])

    const policyRows = policies.map((p) => ({
      "Policy ID": p.policyNumber,
      "Client Name": `${p.client.firstName} ${p.client.lastName}`,
      "Policy Type": p.type,
      "Insurer Name": p.insurer_rel?.name ?? p.insurer ?? "",
      "Premium (R)": Number(p.premiumAmount),
      Status: p.status,
      "Start Date": p.startDate.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }),
      "PPR Issued At": p.pprIssuedAt ? p.pprIssuedAt.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }) : "",
    }))

    const complaintRows = complaints.map((c) => ({
      "Complaint ID": c.reference,
      "Client Name": `${c.client.firstName} ${c.client.lastName}`,
      Category: c.category,
      Status: c.status,
      "Lodged At": c.createdAt.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }),
      "Acknowledged At": c.acknowledgedAt ? new Date(c.acknowledgedAt).toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }) : "",
      "Resolved At": c.resolvedAt ? new Date(c.resolvedAt).toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }) : "",
      Resolution: c.resolution ?? "",
    }))

    const fscaWb = createWorkbook([
      { name: "Insurance Policies", rows: policyRows },
      { name: "Complaints", rows: complaintRows },
    ])
    return workbookResponse(fscaWb, `fsca-annual-return-${year}.xlsx`)
  } else if (type === "fsca-quarterly") {
    const quarter = parseQuarterParam(req.nextUrl.searchParams.get("quarter") ?? undefined, now)
    const { start, end } = quarterBounds(quarter)
    const data = await getFscaReturnData(tenant.id, quarter)

    // Summary sheet — getFscaReturnData returns insurance Decimal(12, 2)
    // sums already in rands (not cents-as-integers), so no scaling needed.
    const summaryRows: ExportRow[] = [
      { Metric: "Quarter", Value: data.quarter },
      { Metric: "FSP Number", Value: data.fspNumber },
      { Metric: "Policies in force (count)", Value: data.policiesInForce.count },
      { Metric: "Policies in force (sum assured, R)", Value: data.policiesInForce.sumAssured },
      { Metric: "GWP this quarter (R)", Value: data.gwp.total },
      { Metric: "New business (count)", Value: data.newBusiness.total },
      { Metric: "Lapses (count)", Value: data.lapses.count },
      { Metric: "Lapses (sum assured, R)", Value: data.lapses.sumAssured },
      { Metric: "Claims submitted (count)", Value: data.claims.SUBMITTED.count },
      { Metric: "Claims under review (count)", Value: data.claims.UNDER_REVIEW.count },
      { Metric: "Claims approved (count)", Value: data.claims.APPROVED.count },
      { Metric: "Claims rejected (count)", Value: data.claims.REJECTED.count },
      { Metric: "Claims paid (count)", Value: data.claims.PAID.count },
      { Metric: "Claims paid (value, R)", Value: data.claims.PAID.value },
      { Metric: "Complaints (total)", Value: data.complaints.total },
      { Metric: "Complaints open", Value: data.complaints.byStatus.OPEN },
      {
        Metric: "PPR acknowledged ratio",
        Value: data.ppr.ratio === null ? "n/a" : `${(data.ppr.ratio * 100).toFixed(1)}%`,
      },
      { Metric: "Advisor commissions (R)", Value: data.advisorCommissions.total },
      { Metric: "Submitted at", Value: data.submittedAt ? data.submittedAt.toISOString() : "" },
    ]

    const [quarterPolicies, quarterClaims, quarterComplaints] = await Promise.all([
      prisma.insurancePolicy.findMany({
        where: { tenantId: tenant.id, status: "ACTIVE", startDate: { lt: end } },
        include: {
          client: { select: { firstName: true, lastName: true } },
          insurer_rel: { select: { name: true } },
        },
        orderBy: { startDate: "desc" },
      }),
      prisma.insuranceClaim.findMany({
        where: { tenantId: tenant.id, submittedAt: { gte: start, lt: end } },
        include: { policy: { select: { policyNumber: true } } },
        orderBy: { submittedAt: "desc" },
      }),
      prisma.complaint.findMany({
        where: { tenantId: tenant.id, createdAt: { gte: start, lt: end } },
        include: { client: { select: { firstName: true, lastName: true } } },
        orderBy: { createdAt: "desc" },
      }),
    ])

    const policyRows: ExportRow[] = quarterPolicies.map((p) => ({
      "Policy Number": p.policyNumber,
      Client: `${p.client.firstName} ${p.client.lastName}`,
      Type: p.type,
      Insurer: p.insurer_rel?.name ?? p.insurer ?? "",
      Premium: Number(p.premiumAmount),
      "Sum Assured": Number(p.sumAssured),
      Status: p.status,
      "Start Date": p.startDate.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }),
    }))

    const claimRows: ExportRow[] = quarterClaims.map((c) => ({
      "Claim Number": c.claimNumber,
      "Policy Number": c.policy.policyNumber,
      Status: c.status,
      "Claim Type": c.claimType ?? "",
      "Claim Amount (R)": Number(c.claimAmount),
      "Approved Amount (R)": c.approvedAmount ? Number(c.approvedAmount) : "",
      "Submitted At": c.submittedAt.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }),
      "Resolved At": c.resolvedAt ? c.resolvedAt.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }) : "",
      "Rejection Reason": c.rejectionReason ?? "",
    }))

    const complaintRows: ExportRow[] = quarterComplaints.map((c) => ({
      Reference: c.reference,
      Client: `${c.client.firstName} ${c.client.lastName}`,
      Category: c.category,
      Status: c.status,
      Outcome: c.outcome ?? "",
      "Lodged At": c.createdAt.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }),
      "Resolved At": c.resolvedAt ? c.resolvedAt.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE }) : "",
    }))

    const wbQ = createWorkbook([
      { name: "Q-Summary", rows: summaryRows },
      { name: "Policies in force", rows: policyRows },
      { name: "Claims", rows: claimRows },
      { name: "Complaints", rows: complaintRows },
    ])
    return workbookResponse(wbQ, `fsca-quarterly-return-${quarter}.xlsx`)
  } else if (type === "audit-log") {
    // Audit log access is LOAN_ADMIN+ (mirrors /api/audit and /settings/audit-log).
    // The route-level READONLY guard isn't sufficient here.
    const upgraded = await requireApiRole("LOAN_ADMIN")
    if (upgraded.error) return upgraded.error

    const params = req.nextUrl.searchParams
    const entity = params.get("entity")
    const userId = params.get("userId")
    const fromParam = params.get("from")
    const toParam = params.get("to")
    const search = params.get("search")?.trim() ?? ""

    // YYYY-MM-DD inputs from <input type="date"> parse as UTC midnight. The
    // user means SAST, not UTC — so anchor date-only values to SAST
    // (UTC+02:00, no DST in ZA) and round `to` to end-of-day so the chosen
    // day is fully included.
    const parseDate = (raw: string | null, endOfDay: boolean) => {
      if (!raw) return null
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw)
      const iso = dateOnly
        ? `${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+02:00`
        : raw
      const d = new Date(iso)
      return Number.isNaN(d.getTime()) ? "invalid" : d
    }
    const fromDate = parseDate(fromParam, false)
    const toDate = parseDate(toParam, true)
    if (fromDate === "invalid" || toDate === "invalid") {
      return NextResponse.json({ error: "Invalid from/to date" }, { status: 400 })
    }

    // Default to last 90 days when no range is given. AuditLog is the largest
    // write-heavy table in the system; an unbounded export is a DoS risk and
    // a POPIA over-disclosure risk.
    const defaultFrom = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    const effectiveFrom = fromDate ?? defaultFrom
    const effectiveTo = toDate ?? null

    const where: Record<string, unknown> = { tenantId: tenant.id }
    if (entity) where.entity = entity
    if (userId) where.userId = userId
    const range: Record<string, Date> = { gte: effectiveFrom }
    if (effectiveTo) range.lte = effectiveTo
    where.createdAt = range
    if (search) {
      where.OR = [
        { action: { contains: search, mode: "insensitive" } },
        { entity: { contains: search, mode: "insensitive" } },
        { entityId: { contains: search, mode: "insensitive" } },
        { userEmail: { contains: search, mode: "insensitive" } },
        { ipAddress: { contains: search } },
        { user: { name: { contains: search, mode: "insensitive" } } },
      ]
    }

    // Hard cap as a safety net even when a range is provided. 50k rows is
    // generous for any reasonable compliance window and still well below the
    // ExcelJS in-memory ceiling.
    const HARD_CAP = 50_000
    const includeDocumentAccess = !entity || entity === "ClientDocument"
    const [logs, documentAccess, users] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: HARD_CAP + 1,
        include: { user: { select: { name: true, email: true } } },
      }),
      includeDocumentAccess
        ? readTenantDocumentAccess(
            prisma as unknown as DocumentAccessReader,
            tenant.id,
            {
              from: effectiveFrom,
              ...(effectiveTo ? { to: effectiveTo } : {}),
              ...(userId ? { staffUserId: userId } : {}),
              ...(search ? { search } : {}),
              limit: HARD_CAP + 1,
            },
          )
        : Promise.resolve([]),
      includeDocumentAccess
        ? prisma.user.findMany({
            where: { tenantId: tenant.id },
            select: { id: true, name: true, email: true },
          })
        : Promise.resolve([]),
    ])
    const platformTimeline: AuditTimelineEntry[] = logs.map((log) => ({
      id: log.id,
      userId: log.userId,
      userEmail: log.userEmail,
      userName: log.user?.name ?? log.user?.email ?? null,
      actorLabel: log.userEmail ?? (log.userId ? `staff ${log.userId}` : "system"),
      action: log.action,
      entity: log.entity,
      entityId: log.entityId,
      oldValue: log.oldValue as Record<string, unknown> | null,
      newValue: log.newValue as Record<string, unknown> | null,
      ipAddress: log.ipAddress,
      createdAt: log.createdAt.toISOString(),
    }))
    const documentTimeline = documentAccessTimelineEntries(documentAccess, users)
    const truncated =
      logs.length > HARD_CAP ||
      documentAccess.length > HARD_CAP ||
      logs.length + documentAccess.length > HARD_CAP
    const exportTimeline = mergeAuditTimeline(platformTimeline, documentTimeline, HARD_CAP)

    const tz = "Africa/Johannesburg"
    const fmt = new Intl.DateTimeFormat("en-ZA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    const rows: ExportRow[] = exportTimeline.map((l) => ({
      "When (SAST)": fmt.format(new Date(l.createdAt)),
      "User Name": l.userName ?? "",
      "User Email": l.userEmail ?? "",
      Actor: l.actorLabel,
      Action: l.action,
      Entity: l.entity,
      "Entity ID": l.entityId ?? "",
      "IP Address": l.ipAddress ?? "",
      "Old Value": l.oldValue ? JSON.stringify(l.oldValue) : "",
      "New Value": l.newValue ? JSON.stringify(l.newValue) : "",
    }))
    if (truncated) {
      rows.push({
        "When (SAST)": "",
        "User Name": "",
        "User Email": "",
        Actor: "",
        Action: `TRUNCATED: result exceeded ${HARD_CAP} rows; narrow the date range or filters`,
        Entity: "",
        "Entity ID": "",
        "IP Address": "",
        "Old Value": "",
        "New Value": "",
      })
    }

    const wbA = createWorkbook([{ name: "Audit Log", rows }])

    // Audit the export itself. AuditLog rows routinely contain PII
    // (KYC payloads, banking details, ID numbers) inside oldValue/newValue,
    // so the export action is itself a POPIA-relevant access event.
    await logAuditStrict({
      tenantId: tenant.id,
      userId: upgraded.user.id,
      userEmail: upgraded.user.email,
      action: "AUDIT_LOG_EXPORTED",
      entity: "AuditLog",
      newValue: {
        rowCount: exportTimeline.length,
        truncated,
        filters: { entity, userId, from: effectiveFrom.toISOString(), to: effectiveTo?.toISOString() ?? null, search: search || null },
      },
    })

    return workbookResponse(wbA, `audit-log-${now.toISOString().slice(0, 10)}.xlsx`)
  } else {
    return NextResponse.json({ error: "Unknown export type" }, { status: 400 })
  }

  const filename = `lms-${type}-${now.toISOString().slice(0, 10)}.xlsx`

  return workbookResponse(wb, filename)
}
