// lib/pdf/__tests__/statement-continuation.test.ts
import { describe, expect, it } from "vitest"
import { boundaryStatementInput } from "@/scripts/nca-pdf-fingerprint"
import { generateStatementPdf } from "../statement"
import { A4_HEIGHT, MARGIN } from "../helpers"
import { extractPdfTextRunsByPage, type PdfTextRun } from "./pdf-test-utils"

// The statement's payment history and repayment schedule continue onto new
// pages under their own title and column headers; nothing is dropped. Before
// this, history rows past the 38th and schedule rows past the 37th were
// silently cut, while the history TOTAL still counted every payment.

const TITLE_Y = A4_HEIGHT - MARGIN
const HISTORY_HEADER = ["Date", "Amount", "Method", "Reference", "Running Balance"]
const SCHEDULE_HEADER = ["No.", "Due Date", "Amount Due", "Paid", "Status", "Balance"]
const FOOTER = /^This statement is generated as at /

const cents = (text: string) => Math.round(Number(text.replace(/^R /, "").replace(/,/g, "")) * 100)
const at = (runs: PdfTextRun[], x: number, y: number) => runs.find((r) => r.x === x && r.y === y)?.text
const titled = (pages: PdfTextRun[][], title: string) =>
  pages.flatMap((runs, i) => (runs.some((r) => r.text === title && r.x === MARGIN && r.y === TITLE_Y) ? [i] : []))

async function render(input: ReturnType<typeof boundaryStatementInput>) {
  const pages = await extractPdfTextRunsByPage(await generateStatementPdf(input))
  const historyIdx = titled(pages, "PAYMENT HISTORY")
  const scheduleIdx = titled(pages, "REPAYMENT SCHEDULE")
  // A payment row: its reference in the Reference column.
  const payments = historyIdx.flatMap((page) => pages[page]
    .filter((r) => r.x === MARGIN + 305 && r.text.startsWith("FNB-"))
    .map((r) => ({
      page, y: r.y, reference: r.text,
      amount: cents(at(pages[page], MARGIN + 90, r.y)!), method: at(pages[page], MARGIN + 180, r.y)!,
    })))
  const scheduleRows = scheduleIdx.flatMap((page) => pages[page]
    .filter((r) => r.x === MARGIN && /^\d+$/.test(r.text))
    .map((r) => ({ page, y: r.y, no: Number(r.text) })))
  return { pages, historyIdx, scheduleIdx, payments, scheduleRows }
}

function expectPageNumbers(pages: PdfTextRun[][]) {
  pages.forEach((runs, k) => {
    expect(runs.filter((r) => /^Page \d+ of \d+$/.test(r.text)).map((r) => r.text)).toEqual([`Page ${k + 1} of ${pages.length}`])
  })
}

describe("statement with a 60-row schedule and 60 payments", () => {
  it("prints every row on continuation pages, with one TOTAL and one footer", async () => {
    const { pages, historyIdx, scheduleIdx, payments, scheduleRows } = await render(boundaryStatementInput(60, 60))

    // Summary, two history pages, two schedule pages — in that order.
    expect(pages).toHaveLength(5)
    expect(historyIdx).toEqual([1, 2])
    expect(scheduleIdx).toEqual([3, 4])
    expectPageNumbers(pages)

    for (const page of historyIdx) {
      for (const label of HISTORY_HEADER) expect(pages[page].some((r) => r.text === label && r.y === TITLE_Y - 28)).toBe(true)
    }
    for (const page of scheduleIdx) {
      for (const label of SCHEDULE_HEADER) expect(pages[page].some((r) => r.text === label && r.y === TITLE_Y - 28)).toBe(true)
    }

    // Every payment once, chronologically, 38 on the first history page.
    expect(payments.map((p) => p.reference)).toEqual(Array.from({ length: 60 }, (_, i) => `FNB-${1000 + i}`))
    expect(payments.filter((p) => p.page === 1)).toHaveLength(38)
    expect(payments.every((p) => p.y >= MARGIN + 40)).toBe(true)

    // The TOTAL foots to the printed allocated payments, after the last one.
    const totals = pages.flatMap((runs, page) => runs.filter((r) => r.text === "TOTAL").map((r) => ({ page, y: r.y })))
    expect(totals).toHaveLength(1)
    const last = payments[payments.length - 1]
    expect(totals[0]).toEqual({ page: last.page, y: last.y - 22 })
    const printed = payments.filter((p) => p.method === "EFT").reduce((sum, p) => sum + p.amount, 0)
    expect(cents(at(pages[last.page], MARGIN + 90, totals[0].y)!)).toBe(printed)
    expect(printed).toBe(boundaryStatementInput(60, 60).payments.reduce((sum, p) => sum + p.amount, 0))

    // Every instalment once, 37 on the first schedule page.
    expect(scheduleRows.map((r) => r.no)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1))
    expect(scheduleRows.filter((r) => r.page === 3)).toHaveLength(37)
    expect(scheduleRows.every((r) => r.y >= MARGIN + 60)).toBe(true)

    // The footer once, under the last instalment, on the last page.
    const footers = pages.flatMap((runs, page) => runs.filter((r) => FOOTER.test(r.text)).map((r) => ({ page, y: r.y })))
    expect(footers).toEqual([{ page: 4, y: scheduleRows[59].y - 38 }])
  })

  it("keeps each payment with the line that says what part paid default charges", async () => {
    const input = boundaryStatementInput(3, 45)
    input.payments = input.payments.map((p) => ({ ...p, defaultInterestAllocated: 1_000 }))
    const { pages, historyIdx, payments } = await render(input)

    expect(historyIdx).toEqual([1, 2, 3])
    expect(payments).toHaveLength(45)
    const subLines = pages.flatMap((runs, page) =>
      runs.filter((r) => r.text === "of which R 10.00 default charges").map((r) => ({ page, y: r.y })))
    expect(subLines).toHaveLength(45)
    payments.forEach((p, i) => expect(subLines[i]).toEqual({ page: p.page, y: p.y - 18 }))
    expectPageNumbers(pages)
  })
})

describe("statement table boundaries", () => {
  // The history TOTAL: one, after the last payment, equal to the printed sum.
  function expectTotal(pages: PdfTextRun[][], payments: Array<{ page: number; y: number; amount: number }>) {
    const totals = pages.flatMap((runs, page) => runs.filter((r) => r.text === "TOTAL").map((r) => ({ page, y: r.y })))
    const last = payments[payments.length - 1]
    expect(totals).toEqual([{ page: last.page, y: last.y - 22 }])
    expect(cents(at(pages[last.page], MARGIN + 90, last.y - 22)!)).toBe(payments.reduce((sum, p) => sum + p.amount, 0))
  }

  it.each([37, 38, 74, 75, 120])("prints all %i schedule rows, 37 to a page", async (n) => {
    const { pages, scheduleIdx, payments, scheduleRows } = await render(boundaryStatementInput(n, 3))
    expect(scheduleIdx).toHaveLength(Math.ceil(n / 37))
    expect(pages).toHaveLength(2 + scheduleIdx.length)
    expect(scheduleRows.map((r) => r.no)).toEqual(Array.from({ length: n }, (_, i) => i + 1))
    for (const boundary of [37, 38, 74, 75, 111, 112, n].filter((b) => b <= n)) {
      expect(scheduleRows[boundary - 1].page, `row ${boundary}`).toBe(scheduleIdx[Math.floor((boundary - 1) / 37)])
    }
    const footers = pages.flatMap((runs, page) => runs.filter((r) => FOOTER.test(r.text)).map(() => page))
    expect(footers).toEqual([pages.length - 1])
    expectTotal(pages, payments)
    expectPageNumbers(pages)
  })

  it.each([38, 39, 76, 77, 120])("prints all %i payments, 38 to a page", async (n) => {
    const input = boundaryStatementInput(3, n)
    const { pages, historyIdx, scheduleIdx, payments } = await render(input)
    expect(historyIdx).toEqual(Array.from({ length: Math.ceil(n / 38) }, (_, k) => 1 + k))
    expect(scheduleIdx).toEqual([historyIdx[historyIdx.length - 1] + 1])
    expect(payments.map((p) => p.reference)).toEqual(input.payments.map((p) => p.reference))
    for (const boundary of [38, 39, 76, 77, 114, 115, n].filter((b) => b <= n)) {
      expect(payments[boundary - 1].page, `payment ${boundary}`).toBe(historyIdx[Math.floor((boundary - 1) / 38)])
    }
    expectTotal(pages, payments)
    expect(payments.reduce((sum, p) => sum + p.amount, 0)).toBe(input.payments.reduce((sum, p) => sum + p.amount, 0))
    expectPageNumbers(pages)
  })
})

describe("statement history page break", () => {
  it("starts a new page for a row that would begin below MARGIN + 40, as the one-page history stopped", async () => {
    // One payment with a charges line, then plain ones: the 38th row would
    // start at y = 73.89, between MARGIN + 30 and MARGIN + 40.
    const input = boundaryStatementInput(3, 40)
    input.payments = input.payments.map((p, i) => (i === 0 ? { ...p, defaultInterestAllocated: 1_000 } : p))
    const { payments } = await render(input)
    expect(payments.filter((p) => p.page === 1)).toHaveLength(37)
    expect(Math.min(...payments.filter((p) => p.page === 1).map((p) => p.y))).toBeGreaterThanOrEqual(MARGIN + 40)
  })
})

describe("statement reversed-payment notes", () => {
  const reversed = (paid: number, reversedCount: number) => {
    const input = boundaryStatementInput(3, paid)
    input.payments = input.payments.map((p, i) => (i < reversedCount
      ? { ...p, reversed: true, reversedAt: new Date("2029-12-01T08:00:00.000Z"), reversalReason: `Bank recall ${i}` }
      : p))
    return input
  }

  it.each([
    ["notes that overflow the last history page", 80, 70],
    ["a note whose heading would land at the foot of the page", 38, 1],
  ])("prints every note, under its heading, for %s", async (_label, paid, reversedCount) => {
    const { pages, historyIdx, scheduleIdx } = await render(reversed(paid, reversedCount))

    const notes = pages.flatMap((runs, page) =>
      runs.filter((r) => /Bank recall \d+$/.test(r.text)).map((r) => ({ page, y: r.y, text: r.text })))
    expect(notes.map((n) => n.text.match(/Bank recall (\d+)$/)![1])).toEqual(
      Array.from({ length: reversedCount }, (_, i) => String(i)))
    expect(notes.every((n) => n.y >= MARGIN + 20)).toBe(true)

    // Each page carrying notes heads them, above the first; no heading is
    // left at the foot of a page without its notes.
    const notePages = new Set(notes.map((n) => n.page))
    expect(pages.flat().filter((r) => r.text === "REVERSED PAYMENTS")).toHaveLength(notePages.size)
    for (const page of notePages) {
      const heading = pages[page].filter((r) => r.text === "REVERSED PAYMENTS")
      expect(heading).toHaveLength(1)
      expect(heading[0].y).toBe(Math.max(...notes.filter((n) => n.page === page).map((n) => n.y)) + 14)
      expect(historyIdx).toContain(page)
    }
    expect(scheduleIdx[0]).toBe(historyIdx[historyIdx.length - 1] + 1)
    expectPageNumbers(pages)
  })
})
