/**
 * The NCA documents of a loan CANCELLED by a disbursement reversal (the money
 * never reached the borrower) state that nothing is owed. Rendered through the
 * real PDF generators with the figures the routes pass (lib/loan/charges-summary.ts
 * loanSettlementFigures + documentLoanFigures). Template wording is untouched:
 * only the figures differ, and only for a CANCELLED loan.
 */
import { inflateSync } from "zlib"
import { describe, expect, it, vi } from "vitest"

const { loadChargesReplay } = vi.hoisted(() => ({ loadChargesReplay: vi.fn() }))
vi.mock("@/lib/loan/charges-replay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/loan/charges-replay")>()),
  loadChargesReplay,
}))

import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { certificatePaidToDate, certificateSettlement, documentLoanFigures, loanSettlementFigures } from "@/lib/loan/charges-summary"
import { generateCertificateOfBalancePdf } from "./certificateOfBalance"
import { generateStatementPdf } from "./statement"

function pdfText(buf: Buffer): string {
  const parts: string[] = []
  let i = 0
  while (i < buf.length - 6) {
    if (buf.subarray(i, i + 6).toString("ascii") === "stream") {
      let start = i + 6
      while (start < buf.length && (buf[start] === 13 || buf[start] === 10)) start++
      const end = buf.indexOf(Buffer.from("endstream"), start)
      if (end > start && end - start < 200_000) {
        const data = buf.subarray(start, end)
        try { parts.push(inflateSync(data).toString("latin1")) } catch { parts.push(data.toString("latin1")) }
      }
      i = end > i ? end + 9 : i + 1
    } else i++
  }
  return parts.join("\n")
}
const hex = (s: string) => Buffer.from(s, "ascii").toString("hex").toUpperCase()

// A R10,000 loan reversed before any payment: the contract said R12,569.86.
const reversed = {
  id: "loan-rev", tenantId: "t1", reference: "LN-REV-0001", status: "CANCELLED",
  principal: 1_000_000, totalInterest: 156_986, totalRepayable: 1_256_986, totalPaid: 0,
  outstandingPrincipal: 0, arrearsAmount: 0, daysInArrears: 0,
  interestRatePm: 0.03, interestModel: "REDUCING_BALANCE" as const,
  startDate: new Date("2026-10-04"), maturityDate: new Date("2027-04-04"),
  lastPaymentDate: null, lastPaymentAmount: null,
  repaymentSchedule: [{ id: "r1", installmentNo: 1, dueDate: new Date("2026-11-04"), principalDue: 1_000_000, interestDue: 256_986, feesDue: 0, totalDue: 1_256_986, totalPaid: 0, status: "WRITTEN_OFF" }],
}
const db = { payment: { aggregate: vi.fn(async () => ({ _sum: { amount: null, defaultInterestAllocated: null, chargeFeesAllocated: null } })) } }
const client = { firstName: "Thandi", lastName: "Mthembu", idNumber: "9401010000080", email: "t@example.com", addressLine1: "45 Oak Ave", city: "Soweto" }

describe("NCA documents of a reversed (CANCELLED) loan", () => {
  it("the certificate of balance states R 0.00 outstanding and repayable", async () => {
    loadChargesReplay.mockResolvedValue({ result: { postings: [], interestAccrued: 5_000, interestPaid: 0, interestOutstanding: 5_000, feesAccrued: 0, feesPaid: 0, feesOutstanding: 0, scheduleAllocated: 0, scheduleRows: [], unallocated: 0, receiptSplits: [], inDuplum: null }, goLive: new Date("2026-01-01"), accrueFrom: new Date("2026-01-01"), loan: { defaultChargesExempt: false, defaultChargesExemptReason: null } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const figures = await loanSettlementFigures(db as any, reversed, new Date("2026-10-15"))
    const own = documentLoanFigures(reversed)
    const text = pdfText(await generateCertificateOfBalancePdf({
      lender: ACME_LENDER, client,
      loan: { ...reversed, ...own, arrearsAmount: figures.arrearsIncludingCharges },
      settlement: certificateSettlement(figures), paymentsReceived: certificatePaidToDate(figures),
    } as never))
    expect(text).toContain(hex("Total Amount Repayable"))
    expect(text).not.toContain(hex("R 12,569.86"))
    expect(text).not.toContain(hex("R 50.00"))
    expect(text).toContain(hex("R 0.00"))
    expect(text).toContain(hex("Nil"))
  })

  it("the statement states R 0.00 total repayable and outstanding", async () => {
    loadChargesReplay.mockResolvedValue(null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const figures = await loanSettlementFigures(db as any, reversed, new Date("2026-10-15"))
    const text = pdfText(await generateStatementPdf({
      lender: ACME_LENDER, client, product: { name: "Personal Loan" },
      loan: { ...reversed, ...documentLoanFigures(reversed), arrearsAmount: figures.arrearsIncludingCharges },
      schedule: reversed.repaymentSchedule.map((s) => ({ installmentNo: s.installmentNo, dueDate: s.dueDate, totalDue: s.totalDue, totalPaid: s.totalPaid, status: s.status })),
      payments: [], statementDate: new Date("2026-10-15"),
    } as never))
    expect(text).toContain(hex("Outstanding Balance"))
    expect(text).toContain(hex("R 0.00"))
    expect(text).not.toMatch(new RegExp(hex("Total Repayable") + "[^\\n]*\\n[^\\n]*" + hex("R 12,569.86")))
  })
})
