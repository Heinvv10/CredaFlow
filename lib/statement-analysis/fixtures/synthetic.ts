/**
 * Synthetic bank statements for tests, fixtures and the browser acceptance.
 *
 * Laid out like Capitec's and FNB's own statements, as far as the text
 * readers care: the same labels, column order, sign conventions and footers.
 * Every value is invented — the holder is "T TESTER", the account numbers are
 * runs of zeros, the merchants are made up. Nothing here comes from the
 * corpus; only its layout was learned from masked shapes.
 */
import { PDFDocument, StandardFonts } from "pdf-lib"
import { formatCents } from "../money"

export interface SynthTx {
  date: string
  description: string
  category?: string
  amountCents: number
  feeCents?: number
}

export interface SynthStatement {
  holder: string
  accountNumber: string
  periodStart: string
  periodEnd: string
  openingCents: number
  transactions: SynthTx[]
}

export interface BuildOptions {
  producer?: string
  creator?: string
  createdAt?: Date
  modifiedAt?: Date
  /** Print a different amount on one row while keeping the true balances. */
  misprint?: { index: number; amountCents: number }
}

export const GENUINE_PRODUCERS = {
  CAPITEC: { producer: "OpenPDF 2.0.2", creator: "" },
  FNB: { producer: "Compart MFFPDF I/O Filter 2023-09-19 11:31:13", creator: "Compart Docponent API (202310-STABLE)" },
} as const

const FONT_SIZE = 6
const ROWS_PER_PAGE = 45

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length))
const lpad = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s)
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const longDate = (iso: string) =>
  `${Number(iso.slice(8, 10))} ${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`

/** Capitec prints "1 234.56" with a minus for money out; FNB "1,234.56" with Cr for money in. */
const capitecNum = (c: number) => formatCents(c).replace("R", "")
const fnbNum = (c: number) => `${formatCents(Math.abs(c)).replace("R", "").replace(/ /g, ",")}${c > 0 ? "Cr" : ""}`

export function balances(s: SynthStatement): number[] {
  let running = s.openingCents
  return s.transactions.map((t) => (running += t.amountCents + (t.feeCents ?? 0)))
}

async function render(lines: string[][], opts: BuildOptions, fallback: { producer: string; creator: string }): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Courier)
  for (const pageLines of lines) {
    const page = doc.addPage([595.28, 841.89])
    pageLines.forEach((line, i) => page.drawText(line, { x: 12, y: 810 - i * (FONT_SIZE + 4), size: FONT_SIZE, font }))
  }
  const created = opts.createdAt ?? new Date("2026-10-01T08:00:00Z")
  doc.setProducer(opts.producer ?? fallback.producer)
  doc.setCreator(opts.creator ?? fallback.creator)
  doc.setCreationDate(created)
  doc.setModificationDate(opts.modifiedAt ?? created)
  // Classic xref tables, so a doctored variant can append a real incremental update.
  return doc.save({ useObjectStreams: false })
}

function paginate(head: string[], header: string[], rows: string[], footer: string[]): string[][] {
  const pages: string[][] = []
  for (let i = 0; i < rows.length || pages.length === 0; i += ROWS_PER_PAGE) {
    pages.push([...(pages.length === 0 ? head : []), ...header, ...rows.slice(i, i + ROWS_PER_PAGE), ...footer, `Page ${pages.length + 1}`])
  }
  return pages
}

export function capitecLines(s: SynthStatement, opts: BuildOptions = {}): string[][] {
  const bal = balances(s)
  const closing = bal.length ? bal[bal.length - 1] : s.openingCents
  const head = [
    "Main Account Statement",
    pad(s.holder, 140) + "Capitec Bank Limited",
    pad("1 Synthetic Street", 140) + "1 Example Road",
    "",
    " Account" + " ".repeat(30) + s.accountNumber + "     VAT Registration Number 0000000000",
    "Statement Information",
    `From Date:          ${dmy(s.periodStart)}       Opening Balance:            R${capitecNum(s.openingCents)}`,
    `To Date:            ${dmy(s.periodEnd)}       Closing Balance:            R${capitecNum(closing)}`,
    " Transaction History",
  ]
  const header = [`${pad("Date", 13)}${pad("Description", 60)}${pad("Category", 22)}${lpad("Money In", 14)}${lpad("Money Out", 14)}${lpad("Fee*", 12)}${lpad("Balance", 14)}`]
  const rows = s.transactions.map((t, i) => {
    const amount = opts.misprint?.index === i ? opts.misprint.amountCents : t.amountCents
    return `${pad(dmy(t.date), 13)}${pad(t.description, 60)}${pad(t.category ?? "Other", 22)}` +
      `${lpad(amount > 0 ? capitecNum(amount) : "", 14)}${lpad(amount < 0 ? capitecNum(amount) : "", 14)}` +
      `${lpad(t.feeCents ? capitecNum(t.feeCents) : "", 12)}${lpad(capitecNum(bal[i]), 14)}`
  })
  const footer = ["", lpad("* Includes VAT at 15%", 150), "24hr Client Care Centre | capitecbank.co.za | Synthetic fixture, not a real statement"]
  return paginate(head, header, rows, footer)
}

export function fnbLines(s: SynthStatement, opts: BuildOptions = {}): string[][] {
  const bal = balances(s)
  const closing = bal.length ? bal[bal.length - 1] : s.openingCents
  const head = [
    pad("First National Bank", 120) + "fnb.co.za",
    "",
    `MR ${s.holder}`,
    "1 Synthetic Street",
    "",
    pad("", 90) + `Gold Cheque Account : ${s.accountNumber}`,
    pad("", 90) + `Statement Period : ${longDate(s.periodStart)} to ${longDate(s.periodEnd)}`,
    "  Statement Balances",
    `  Opening Balance            ${lpad(fnbNum(s.openingCents), 14)}`,
    `  Closing Balance            ${lpad(fnbNum(closing), 14)}`,
    "Transactions in RAND (ZAR)",
  ]
  const header = [
    `${pad("Date", 8)}${pad("Description", 70)}${lpad("Amount", 16)}${lpad("Balance", 18)}${lpad("Bank", 12)}`,
    `${pad("", 8)}${pad("", 70)}${lpad("", 16)}${lpad("", 18)}${lpad("Charges", 12)}`,
  ]
  const rows = s.transactions.map((t, i) => {
    const amount = opts.misprint?.index === i ? opts.misprint.amountCents : t.amountCents
    const d = `${t.date.slice(8, 10)} ${MON[Number(t.date.slice(5, 7)) - 1]}`
    return `${pad(d, 8)}${pad(t.description, 70)}${lpad(fnbNum(amount), 16)}${lpad(fnbNum(bal[i]), 18)}`
  })
  return paginate(head, header, rows, ["", "Synthetic fixture, not a real statement"])
}

export function buildCapitecStatement(s: SynthStatement, opts: BuildOptions = {}): Promise<Uint8Array> {
  return render(capitecLines(s, opts), opts, GENUINE_PRODUCERS.CAPITEC)
}

export function buildFnbStatement(s: SynthStatement, opts: BuildOptions = {}): Promise<Uint8Array> {
  return render(fnbLines(s, opts), opts, GENUINE_PRODUCERS.FNB)
}

