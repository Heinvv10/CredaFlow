import { PDFDocument, StandardFonts, rgb, type PDFPage } from "pdf-lib"
import {
  A4_WIDTH, A4_HEIGHT, MARGIN, CONTENT_WIDTH,
  DARK, ACCENT, GRAY, WHITE,
  formatZarPdf, formatDatePdf,
  drawText, drawTableRow, drawLabelValueTable,
  drawPageNumber, drawSectionTitle, drawRowsWithContinuation,
  embedLogo, fitLogo,
} from "./helpers"
import { annualisedInterestRate } from "@/lib/loan/annualised-rate"
import { methodLabelWithReversal, reversalDetailLine } from "@/lib/payments/reversal-label"
import { cashReceivedCents, displayPaymentMethod } from "@/lib/payments/waiver"
import { requireLenderIdentityFields, type LenderIdentity } from "@/lib/config/identity-schema"
import { CHARGE_TYPE_LABELS } from "@/lib/loan/charge-labels"
import type { ChargePosting } from "@/lib/loan/default-charges"

/**
 * Sum of allocated, non-reversed payment amounts (cents). A reversed/voided,
 * unapplied or refunded receipt must never count toward the statement's payment
 * total or running balance — it is still shown for transparency with its state.
 */
/**
 * The date a receipt appears under on the NCA statement. Drives BOTH the printed
 * column and the running-balance ordering, so the two can never disagree.
 * Falls back to capture time for a caller that has not been migrated.
 */
function statementPaymentDate(p: { createdAt: Date; receivedAt?: Date | null }): Date {
  return new Date(p.receivedAt ?? p.createdAt)
}

export function activePaymentTotalCents(
  payments: Parameters<typeof cashReceivedCents>[0],
): number {
  // A waived balance reduces what is owed but is not a payment received.
  return cashReceivedCents(payments)
}

interface StatementOpts {
  lender: Pick<LenderIdentity, "legalName" | "ncrNumber">
  /** Letterhead logo, PNG bytes. Absent → text header. */
  logo?: Uint8Array
  client: {
    firstName: string
    lastName: string
    idNumber: string
    email: string
    addressLine1?: string
    city?: string
  }
  loan: {
    id: string
    reference: string
    principal: number
    totalRepayable: number
    totalPaid: number
    outstandingPrincipal: number
    interestRatePm: number
    interestModel: string
    status: string
    startDate: Date
    maturityDate: Date
    daysInArrears: number
    arrearsAmount: number
  }
  product: { name: string }
  schedule: Array<{
    installmentNo: number
    dueDate: Date
    totalDue: number
    totalPaid: number
    status: string
  }>
  payments: Array<{
    createdAt: Date
    /** Value date — when the money reached us. Interest accrues to this, so the
     *  statement must present it, or the document contradicts its own maths. */
    receivedAt?: Date | null
    amount: number
    paymentMethod: string
    reference?: string | null
    reversed?: boolean
    reversedAt?: Date | null
    reversalReason?: string | null
    allocationStatus?: "ALLOCATED" | "UNAPPLIED" | "REFUNDED"
    reconciliationReason?: string | null
    /** the part of `amount` that paid default charges (0 when none) */
    defaultInterestAllocated?: number
    chargeFeesAllocated?: number
  }>
  statementDate?: Date
  /**
   * Default charges (lib/loan/charges-summary.ts), absent while they are off
   * for the tenant — the statement then renders exactly as before.
   */
  charges?: {
    postings: ChargePosting[]
    /** charges owing today */
    outstanding: number
    /** charge-inclusive settlement today */
    settlement: number
  }
}

export async function generateStatementPdf(opts: StatementOpts): Promise<Buffer> {
  const dated = { ...opts, statementDate: opts.statementDate ?? new Date() }
  // "Page x of y" is drawn as each page is finished, so the total must be known
  // up front: three pages unless a table continued, then once more with the
  // real count. A layout never depends on the total, so the count holds.
  let doc = await renderStatement(dated, 3)
  if (doc.getPageCount() !== 3) doc = await renderStatement(dated, doc.getPageCount())
  const bytes = await doc.save()
  return Buffer.from(bytes)
}

async function renderStatement(opts: StatementOpts & { statementDate: Date }, totalPages: number): Promise<PDFDocument> {
  const { client, loan, product, schedule, payments, statementDate } = opts
  const lender = requireLenderIdentityFields(opts.lender, ["legalName", "ncrNumber"])
  const doc = await PDFDocument.create()
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const pageNumber = (page: PDFPage) => doc.getPages().indexOf(page) + 1
  // A continuation page: number the page being left, then open the next with
  // its table's title and header row repeated.
  const continuePage = (from: PDFPage, head: (page: PDFPage) => number) => {
    drawPageNumber(from, pageNumber(from), totalPages, regular)
    const page = doc.addPage([A4_WIDTH, A4_HEIGHT])
    return { page, y: head(page) }
  }

  // Model-aware annualisation — see lib/loan/annualised-rate.
  const annual = annualisedInterestRate({
    interestRatePm: loan.interestRatePm,
    interestModel: loan.interestModel,
  })
  const paidPct = loan.totalRepayable > 0
    ? Math.round((loan.totalPaid / loan.totalRepayable) * 100)
    : 0

  // ── PAGE 1: ACCOUNT SUMMARY ─────────────────────────────────────────
  const p1 = doc.addPage([A4_WIDTH, A4_HEIGHT])
  let y = A4_HEIGHT - MARGIN

  // Header
  const logo = await embedLogo(doc, opts.logo)
  if (logo) {
    const { width: targetWidth, height: targetHeight } = fitLogo(logo, 36, CONTENT_WIDTH)
    p1.drawImage(logo, { x: MARGIN, y: y - targetHeight + 4, width: targetWidth, height: targetHeight })
    y -= targetHeight + 4
  } else {
    drawText(p1, lender.legalName, MARGIN, y, bold, 16, ACCENT)
    y -= 16
  }
  drawText(p1, `NCR Registration: ${lender.ncrNumber}`, MARGIN, y, regular, 8, GRAY)
  y -= 12
  y -= 12

  // Title
  const title = "LOAN ACCOUNT STATEMENT"
  const titleWidth = bold.widthOfTextAtSize(title, 14)
  drawText(p1, title, (A4_WIDTH - titleWidth) / 2, y, bold, 14, DARK)
  y -= 18

  // Statement date right-aligned
  const dateStr = `Statement Date: ${formatDatePdf(statementDate)}`
  const dateWidth = regular.widthOfTextAtSize(dateStr, 9)
  drawText(p1, dateStr, A4_WIDTH - MARGIN - dateWidth, y, regular, 9, GRAY)
  y -= 24

  y = drawSectionTitle(p1, y, "CLIENT DETAILS", bold)
  const clientRows: [string, string][] = [
    ["Name", `${client.firstName} ${client.lastName}`],
    ["ID Number", client.idNumber],
    ["Email", client.email],
  ]
  if (client.addressLine1) {
    clientRows.push(["Address", `${client.addressLine1}${client.city ? `, ${client.city}` : ""}`])
  }
  y = drawLabelValueTable(p1, y, clientRows, regular, bold)
  y -= 12

  y = drawSectionTitle(p1, y, "ACCOUNT DETAILS", bold)
  const acctRows: [string, string][] = [
    ["Loan Reference", loan.reference],
    ["Product", product.name],
    ["Status", loan.status.replace(/_/g, " ")],
    ["Start Date", formatDatePdf(new Date(loan.startDate))],
    ["Maturity Date", formatDatePdf(new Date(loan.maturityDate))],
  ]
  y = drawLabelValueTable(p1, y, acctRows, regular, bold)
  y -= 12

  // Summary table
  y = drawSectionTitle(p1, y, "ACCOUNT SUMMARY", bold)
  const summaryRows: [string, string][] = [
    ["Principal Debt", formatZarPdf(loan.principal)],
    ["Total Repayable", formatZarPdf(loan.totalRepayable)],
    // Cash received. With default charges Loan.totalPaid is only the share
    // applied to the instalments, shown on its own line below.
    ["Total Paid to Date", formatZarPdf(activePaymentTotalCents(payments))],
    ["Outstanding Balance", formatZarPdf(loan.outstandingPrincipal)],
    ...(opts.charges
      ? [
          ["Applied to Instalments", formatZarPdf(loan.totalPaid)],
          ["Default Charges Owing", formatZarPdf(opts.charges.outstanding)],
          ["Amount to Settle Today", formatZarPdf(opts.charges.settlement)],
        ] as [string, string][]
      : []),
    ["Interest Rate", `${(loan.interestRatePm * 100).toFixed(2)}% per month (${annual.percent.toFixed(1)}% ${annual.basisLabel})`],
    ["Loan Status", loan.status.replace(/_/g, " ")],
    ["Days in Arrears", `${loan.daysInArrears} days`],
    ["Arrears Amount", formatZarPdf(loan.arrearsAmount)],
  ]
  y = drawLabelValueTable(p1, y, summaryRows, regular, bold)
  y -= 16

  // Progress bar (text)
  const filled = Math.round(paidPct / 5)
  const empty = 20 - filled
  const bar = `[${"=".repeat(filled)}>${".".repeat(empty)}]`
  drawText(p1, `REPAYMENT PROGRESS: ${bar} ${paidPct}%`, MARGIN + 4, y, bold, 9, DARK)
  y -= 28

  // Payment reference — the loan reference is what a client must quote on any
  // EFT/deposit so the bank-sync reconciler makes an EXACT match. Placed
  // on page 1 (fixed, bounded layout) rather than the variable-height page-3
  // footer, so it can never collide with the page-number line.
  drawText(p1, `PAYMENT REFERENCE: ${loan.reference}`, MARGIN + 4, y, bold, 10, ACCENT)
  y -= 14
  drawText(
    p1,
    "Quote this reference on every payment or deposit so it is allocated to this loan.",
    MARGIN + 4, y, regular, 8, GRAY,
  )

  drawPageNumber(p1, 1, totalPages, regular)

  // ── PAGE 2: PAYMENT HISTORY ─────────────────────────────────────────
  const p2 = doc.addPage([A4_WIDTH, A4_HEIGHT])
  const historyTitle = (page: PDFPage): number => {
    drawText(page, "PAYMENT HISTORY", MARGIN, A4_HEIGHT - MARGIN, bold, 14, ACCENT)
    return A4_HEIGHT - MARGIN - 28
  }

  // Method column widened to fit "<method> / Reversed" (the longest being
  // "DEBIT ORDER / Reversed" ≈ 95px @ 8pt) without touching the Reference column.
  const payCols = [
    { label: "Date", x: MARGIN, width: 85 },
    { label: "Amount", x: MARGIN + 90, width: 85 },
    { label: "Method", x: MARGIN + 180, width: 120 },
    { label: "Reference", x: MARGIN + 305, width: 95 },
    { label: "Running Balance", x: MARGIN + 405, width: 105 },
  ]

  const historyHead = (page: PDFPage): number => {
    const headY = historyTitle(page)
    drawTableRow(page, headY, payCols.map(c => ({ text: c.label, x: c.x, width: c.width })), bold, 8, WHITE, ACCENT)
    return headY - 20
  }
  y = historyHead(p2)

  // Sort payments chronologically for running balance
  const sortedPayments = [...payments].sort(
    (a, b) => statementPaymentDate(a).getTime() - statementPaymentDate(b).getTime()
  )
  const totalPayments = activePaymentTotalCents(sortedPayments)
  // Default charges are debits in the same timeline: each raises the running
  // balance on the day it was posted. Without charges this is exactly the
  // payments-only timeline and contractualRunningBalances.
  type Payment = (typeof sortedPayments)[number]
  const chargeDate = (posting: ChargePosting) => new Date(`${posting.day}T00:00:00.000Z`)
  const entries: Array<{ payment: Payment } | { charge: ChargePosting }> = [
    ...(opts.charges?.postings ?? []).map((charge) => ({ charge })),
    ...sortedPayments.map((payment) => ({ payment })),
  ].sort((a, b) => {
    const date = (e: typeof a) => ("charge" in e ? chargeDate(e.charge) : statementPaymentDate(e.payment)).getTime()
    return date(a) - date(b)
  })
  // The same rule as contractualRunningBalances (only an allocated, live
  // receipt reduces the balance, never below zero), with charges added in.
  let remaining = Math.max(0, loan.totalRepayable)

  // A payment and its "of which … default charges" line are one row here, so
  // they never split across pages.
  const history = drawRowsWithContinuation({
    page: p2, y, rows: entries, floor: MARGIN + 40,
    openContinuation: (from) => continuePage(from, historyHead),
    drawRow: (page, rowY, entry, i) => {
      const bg = i % 2 === 0 ? undefined : rgb(0.98, 0.98, 0.98)
      if ("charge" in entry) {
        remaining += entry.charge.amount
        drawTableRow(page, rowY, [
          { text: formatDatePdf(chargeDate(entry.charge)), x: payCols[0].x, width: payCols[0].width },
          { text: formatZarPdf(entry.charge.amount), x: payCols[1].x, width: payCols[1].width },
          { text: CHARGE_TYPE_LABELS[entry.charge.type], x: payCols[2].x, width: payCols[2].width },
          { text: "Charge", x: payCols[3].x, width: payCols[3].width },
          { text: formatZarPdf(remaining), x: payCols[4].x, width: payCols[4].width },
        ], regular, 8, DARK, bg)
        return rowY - 18
      }
      const p = entry.payment
      const isAllocated =
        p.allocationStatus === undefined || p.allocationStatus === "ALLOCATED"
      const allocationLabel =
        p.allocationStatus === "UNAPPLIED"
          ? "Unapplied"
          : p.allocationStatus === "REFUNDED"
            ? "Refunded"
            : null
      const baseMethod = displayPaymentMethod(p.paymentMethod, (method) => method.replace(/_/g, " "))
      const methodLabel = p.reversed
        ? methodLabelWithReversal(baseMethod, true)
        : allocationLabel
          ? `${baseMethod} / ${allocationLabel}`
          : baseMethod
      // Every receipt remains visible, but only an allocated, non-reversed
      // receipt can reduce the loan balance or count toward the total. While
      // charges are shown as debits the whole receipt offsets them; otherwise
      // (never live, or stopped) only its schedule share reduces the balance
      // and the part that paid charges is shown under it, so the row reconciles.
      const reducesBalance = !p.reversed && isAllocated
      const paidCharges = opts.charges ? 0 : (p.defaultInterestAllocated ?? 0) + (p.chargeFeesAllocated ?? 0)
      if (reducesBalance) remaining = Math.max(0, remaining - (p.amount - paidCharges))
      drawTableRow(page, rowY, [
        { text: formatDatePdf(statementPaymentDate(p)), x: payCols[0].x, width: payCols[0].width },
        { text: formatZarPdf(p.amount), x: payCols[1].x, width: payCols[1].width },
        { text: methodLabel, x: payCols[2].x, width: payCols[2].width },
        { text: p.reference || "—", x: payCols[3].x, width: payCols[3].width },
        { text: reducesBalance ? formatZarPdf(remaining) : "—", x: payCols[4].x, width: payCols[4].width },
      ], regular, 8, p.reversed || !isAllocated ? GRAY : DARK, bg)
      rowY -= 18
      if (reducesBalance && paidCharges > 0) {
        drawTableRow(page, rowY, [
          { text: `of which ${formatZarPdf(paidCharges)} default charges`, x: payCols[2].x, width: payCols[2].width + payCols[3].width },
        ], regular, 7, GRAY, bg)
        rowY -= 14
      }
      return rowY
    },
  })
  let historyPage = history.page
  y = history.y

  // Total rows: payments (cash only — a waived balance is not a payment) and,
  // when there are any, charges, so neither total is read as the other.
  const totalRows: Array<[string, number]> = opts.charges
    ? [
        ["TOTAL PAID", totalPayments],
        ["TOTAL CHARGES", opts.charges.postings.reduce((sum, posting) => sum + posting.amount, 0)],
      ]
    : [["TOTAL", totalPayments]]
  for (const [index, [label, amount]] of totalRows.entries()) {
    y -= index === 0 ? 4 : 18
    drawTableRow(historyPage, y, [
      { text: label, x: payCols[0].x, width: payCols[0].width },
      { text: formatZarPdf(amount), x: payCols[1].x, width: payCols[1].width },
      { text: "", x: payCols[2].x, width: payCols[2].width },
      { text: "", x: payCols[3].x, width: payCols[3].width },
      { text: "", x: payCols[4].x, width: payCols[4].width },
    ], bold, 8, DARK, ACCENT)
  }

  if (sortedPayments.length === 0) {
    y -= 20
    drawText(historyPage, "No payments recorded.", MARGIN + 4, y, regular, 9, GRAY)
  }

  // Reversed-payment footnotes — a reversed row shows "<method> / Reversed" and is
  // excluded from the total/running balance; list when it was reversed and why so
  // the statement stays transparent about the voided entry.
  const reversedPayments = sortedPayments.filter((p) => p.reversed)
  if (reversedPayments.length > 0) {
    // The heading stays with its first line; lines that do not fit continue
    // on a page headed by the page's title and this heading again.
    const notesHead = (page: PDFPage): number => {
      const headY = historyTitle(page)
      drawText(page, "REVERSED PAYMENTS", MARGIN, headY, bold, 8, GRAY)
      return headY - 14
    }
    y -= 24
    if (y - 14 < MARGIN + 20) {
      ({ page: historyPage, y } = continuePage(historyPage, notesHead))
    } else {
      drawText(historyPage, "REVERSED PAYMENTS", MARGIN, y, bold, 8, GRAY)
      y -= 14
    }
    ({ page: historyPage, y } = drawRowsWithContinuation({
      page: historyPage, y, rows: reversedPayments, floor: MARGIN + 20,
      openContinuation: (from) => continuePage(from, notesHead),
      drawRow: (page, lineY, p) => {
        const detail = reversalDetailLine(p, formatDatePdf) ?? "Reversed"
        const line = `${formatDatePdf(statementPaymentDate(p))}  ${formatZarPdf(p.amount)}  —  ${detail}`
        drawText(page, line, MARGIN + 4, lineY, regular, 8, GRAY)
        return lineY - 12
      },
    }))
  }

  drawPageNumber(historyPage, pageNumber(historyPage), totalPages, regular)

  // ── PAGE 3: REPAYMENT SCHEDULE ──────────────────────────────────────
  const p3 = doc.addPage([A4_WIDTH, A4_HEIGHT])
  const schCols = [
    { label: "No.", x: MARGIN, width: 30 },
    { label: "Due Date", x: MARGIN + 35, width: 90 },
    { label: "Amount Due", x: MARGIN + 130, width: 90 },
    { label: "Paid", x: MARGIN + 225, width: 90 },
    { label: "Status", x: MARGIN + 320, width: 70 },
    { label: "Balance", x: MARGIN + 395, width: 110 },
  ]

  const scheduleHead = (page: PDFPage): number => {
    let headY = A4_HEIGHT - MARGIN
    drawText(page, "REPAYMENT SCHEDULE", MARGIN, headY, bold, 14, ACCENT)
    headY -= 28
    drawTableRow(page, headY, schCols.map(c => ({ text: c.label, x: c.x, width: c.width })), bold, 8, WHITE, ACCENT)
    return headY - 20
  }
  y = scheduleHead(p3)

  let scheduleBalance = loan.totalRepayable
  const scheduleEnd = drawRowsWithContinuation({
    page: p3, y, rows: schedule, floor: MARGIN + 60,
    openContinuation: (from) => continuePage(from, scheduleHead),
    drawRow: (page, rowY, s, i) => {
      scheduleBalance = Math.max(0, scheduleBalance - s.totalPaid)
      const isOverdue = s.status === "OVERDUE"
      // Overdue rows get a light gray border indicator
      const bg = isOverdue
        ? rgb(0.98, 0.93, 0.93)
        : i % 2 === 0 ? undefined : rgb(0.98, 0.98, 0.98)
      drawTableRow(page, rowY, [
        { text: String(s.installmentNo), x: schCols[0].x, width: schCols[0].width },
        { text: formatDatePdf(new Date(s.dueDate)), x: schCols[1].x, width: schCols[1].width },
        { text: formatZarPdf(s.totalDue), x: schCols[2].x, width: schCols[2].width },
        { text: formatZarPdf(s.totalPaid), x: schCols[3].x, width: schCols[3].width },
        { text: s.status, x: schCols[4].x, width: schCols[4].width },
        { text: formatZarPdf(scheduleBalance), x: schCols[5].x, width: schCols[5].width },
      ], regular, 8, DARK, bg)
      return rowY - 18
    },
  })
  y = scheduleEnd.y

  // Footer
  y -= 20
  const contactLine = `This statement is generated as at ${formatDatePdf(statementDate)}.`
  drawText(scheduleEnd.page, contactLine, MARGIN + 4, y, regular, 8, GRAY)
  y -= 14

  drawPageNumber(scheduleEnd.page, pageNumber(scheduleEnd.page), totalPages, regular)

  return doc
}
