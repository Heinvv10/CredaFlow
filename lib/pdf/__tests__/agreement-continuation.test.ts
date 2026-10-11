// lib/pdf/__tests__/agreement-continuation.test.ts
import { describe, expect, it } from "vitest"
import { calculateLoan } from "@/lib/loan-calculator"
import { boundaryAgreementInput, boundaryLoanInput, boundaryStartDate } from "@/scripts/nca-pdf-fingerprint"
import { generateCreditAgreementPdf, generateCreditAgreementPdfWithAnchors } from "../creditAgreement"
import { stampExecutedAgreement } from "../executed-agreement"
import { A4_HEIGHT, MARGIN } from "../helpers"
import { extractPdfTextRunsByPage, pdfPageContents, type PdfTextRun } from "./pdf-test-utils"

// A repayment schedule longer than one page continues onto the next, under the
// same title and column headers, with one TOTAL after the last row. Before
// this, rows past the 38th were silently dropped while the TOTAL still summed
// them, so the printed rows did not foot to the printed total.

const TITLE_Y = A4_HEIGHT - MARGIN
const HEADER = ["No.", "Due Date", "Principal", "Interest", "Fees", "Total Due", "Balance"]
const COL_X = { no: 40, principal: 160, interest: 240, fees: 320, totalDue: 385 }
const ROWS_PER_PAGE = 38

const cents = (text: string) => Math.round(Number(text.replace(/^R /, "").replace(/,/g, "")) * 100)
const at = (runs: PdfTextRun[], x: number, y: number) => runs.find((r) => r.x === x && r.y === y)?.text

async function render(instalments: number, variant: "agreement" | "pasq") {
  const calc = calculateLoan(boundaryLoanInput(instalments), boundaryStartDate)
  expect(calc.schedule).toHaveLength(instalments)
  const pdf = await generateCreditAgreementPdf(boundaryAgreementInput(variant, calc))
  const pages = await extractPdfTextRunsByPage(pdf)
  const isSchedulePage = (runs: PdfTextRun[]) =>
    runs.some((r) => r.text === "REPAYMENT SCHEDULE" && r.x === MARGIN && r.y === TITLE_Y)
  const scheduleIdx = pages.flatMap((runs, i) => (isSchedulePage(runs) ? [i] : []))
  const rows = scheduleIdx.flatMap((page) => pages[page]
    .filter((r) => r.x === COL_X.no && /^\d+$/.test(r.text))
    .map((r) => ({
      page, y: r.y, no: Number(r.text),
      principal: cents(at(pages[page], COL_X.principal, r.y)!),
      interest: cents(at(pages[page], COL_X.interest, r.y)!),
      fees: cents(at(pages[page], COL_X.fees, r.y)!),
      totalDue: cents(at(pages[page], COL_X.totalDue, r.y)!),
    })))
  const totals = pages.flatMap((runs, page) =>
    runs.filter((r) => r.text === "TOTAL" && r.x === COL_X.no).map((r) => ({ page, y: r.y, runs })))
  return { calc, pages, scheduleIdx, rows, totals }
}

describe.each(["agreement", "pasq"] as const)("%s repayment schedule continuation", (variant) => {
  it.each([38, 39, 60, 76, 77, 120])("prints every one of %i instalments, footed by one TOTAL", async (n) => {
    const base = await render(38, variant)
    const { calc, pages, scheduleIdx, rows, totals } = await render(n, variant)
    const schedulePages = Math.ceil(n / ROWS_PER_PAGE)

    // One page more per 38 rows, and nothing else moved.
    expect(pages).toHaveLength(base.pages.length + schedulePages - 1)
    expect(scheduleIdx).toEqual(Array.from({ length: schedulePages }, (_, k) => base.scheduleIdx[0] + k))

    // Every instalment exactly once, in order, 38 to a page.
    expect(rows.map((r) => r.no)).toEqual(Array.from({ length: n }, (_, i) => i + 1))
    for (const row of rows) {
      expect(row.page).toBe(scheduleIdx[Math.floor((row.no - 1) / ROWS_PER_PAGE)])
      expect(row.y).toBeGreaterThan(MARGIN)
    }

    // The column header row heads every schedule page.
    for (const page of scheduleIdx) {
      const headerY = pages[page].find((r) => r.text === "No.")?.y
      expect(headerY).toBe(TITLE_Y - 24)
      for (const label of HEADER) {
        expect(pages[page].some((r) => r.text === label && r.y === headerY), `${label} on page ${page + 1}`).toBe(true)
      }
    }

    // Exactly one TOTAL: on the page of the last row, below it, above the margin.
    expect(totals).toHaveLength(1)
    const [total] = totals
    const last = rows[rows.length - 1]
    expect(total.page).toBe(last.page)
    expect(total.y).toBe(last.y - 22)
    expect(total.y).toBeGreaterThan(MARGIN)

    // Each money column foots: printed rows = printed TOTAL = the schedule.
    const cols = ["principal", "interest", "fees", "totalDue"] as const
    const due = { principal: "principalDue", interest: "interestDue", fees: "feesDue", totalDue: "totalDue" } as const
    for (const col of cols) {
      const printed = rows.reduce((sum, r) => sum + r[col], 0)
      expect(cents(at(total.runs, COL_X[col], total.y)!), col).toBe(printed)
      expect(printed, col).toBe(calc.schedule.reduce((sum, item) => sum + item[due[col]], 0))
    }

    // Every page carries "Page k of n" and the ceremony reference.
    pages.forEach((runs, k) => {
      expect(runs.filter((r) => r.text === `Page ${k + 1} of ${pages.length}`)).toHaveLength(1)
    })
    expect(pages.flat().filter((r) => r.text === "Ref 0123456789ab")).toHaveLength(pages.length)

    // Order: the schedule pages, then the terms, then the declaration.
    const after = scheduleIdx[scheduleIdx.length - 1]
    expect(pages[after + 1].some((r) => r.text === "TERMS AND CONDITIONS")).toBe(true)
    const declaration = variant === "pasq" ? "CONSUMER ACKNOWLEDGEMENT OF RECEIPT" : "CONSUMER DECLARATION"
    expect(pages[after + 2].some((r) => r.text === declaration)).toBe(true)
    expect(pages).toHaveLength(after + 3)
  })

  it("puts instalment 39 and the TOTAL alone on the continuation page", async () => {
    const { pages, scheduleIdx, rows, totals } = await render(39, variant)
    const continuation = scheduleIdx[1]
    expect(rows.filter((r) => r.page === continuation).map((r) => r.no)).toEqual([39])
    expect(totals[0].page).toBe(continuation)
    expect(pages[continuation].filter((r) => r.text === "REPAYMENT SCHEDULE")).toHaveLength(1)
  })
})

describe("signatures on a continued agreement", () => {
  it("anchors and stamps both signatures on the declaration page, the last page", async () => {
    const calc = calculateLoan(boundaryLoanInput(60), boundaryStartDate)
    const { bytes, signatureAnchors } = await generateCreditAgreementPdfWithAnchors(boundaryAgreementInput("agreement", calc))
    const pages = await extractPdfTextRunsByPage(bytes)
    const lastIndex = pages.length - 1
    expect(signatureAnchors?.pageIndex).toBe(lastIndex)
    const anchors = signatureAnchors!
    const consumerRule = pages[lastIndex].find((r) => r.text.startsWith("Consumer Signature:"))
    expect(consumerRule?.y).toBe(anchors.consumer.baselineY)

    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    const executed = await stampExecutedAgreement({
      agreementBytes: bytes,
      anchors,
      execution: {
        consumerSignature: png, consumerSignedAt: new Date("2026-07-23T09:30:00.000Z"),
        providerSignature: png, providerName: "Synthetic Representative", countersignedAt: new Date("2026-07-24T14:00:00.000Z"),
      },
    })
    expect(executed.method).toBe("stamped")
    const contents = await pdfPageContents(executed.bytes)
    expect(contents).toHaveLength(pages.length)
    const draws = contents.map((c) => c.match(/\/Image-?\d+\s+Do/g)?.length ?? 0)
    expect(draws[lastIndex]).toBe(2)
    expect(draws.reduce((a, b) => a + b, 0)).toBe(2)
    for (const rule of [anchors.consumer, anchors.provider]) {
      expect(contents[lastIndex]).toMatch(new RegExp(`1 0 0 1 ${rule.signatureX} [\\d.]+ cm`))
    }
  })
})

describe("terms page", () => {
  // The clause loop stops drawing at MARGIN + 20 without a continuation page.
  // These clauses never reach it; a clause added later that would must fail
  // here rather than be dropped from the agreement.
  const HEADINGS = [
    "1. LATE PAYMENT:", "2. DEFAULT:", "3. SECTION 129 NOTICE:", "4. COLLECTION COSTS:", "5. CREDIT BUREAU:",
    "6. POPIA:", "7. JURISDICTION:", "8. ENTIRE AGREEMENT:", "9. VARIATION:", "10. CONSUMER RIGHTS:",
  ]

  it.each(["agreement", "pasq"] as const)("prints every clause of the %s in full, with room to spare", async (variant) => {
    const calc = calculateLoan(boundaryLoanInput(120), boundaryStartDate)
    const pdf = await generateCreditAgreementPdf({ ...boundaryAgreementInput(variant, calc), willAutoBundleCl: true })
    const pages = await extractPdfTextRunsByPage(pdf)
    const termsPages = pages.filter((runs) => runs.some((r) => r.text === "TERMS AND CONDITIONS"))
    expect(termsPages).toHaveLength(1)
    const lines = termsPages[0].filter((r) => r.x === MARGIN + 4)
    for (const heading of HEADINGS) {
      expect(lines.filter((r) => r.text.startsWith(heading)), heading).toHaveLength(1)
    }
    expect(lines[lines.length - 1].text.endsWith("periodic statements of account.")).toBe(true)
    // After the last line the loop steps down 13 + 6 and only then checks.
    expect(Math.min(...lines.map((r) => r.y)) - 19).toBeGreaterThanOrEqual(MARGIN + 20)
  })
})
