/**
 * The statement workbook a credit officer downloads (goal 2026-10-14 §5):
 * Summary (one row per statement: bank, period, balances, balance check,
 * authenticity signals), Transactions (every read row with its category) and
 * Monthly (money in and out, spend per category). Values are invented in
 * tests; in use they are client data, so only the export route builds it.
 */
import ExcelJS from "exceljs"
import { categorise, CATEGORISER_VERSION } from "@/lib/statement-analysis/categorise"
import { LIVING_CATEGORIES, OTHER_CATEGORIES, type Category } from "@/lib/statement-analysis/categories"
import { documentAuthenticity } from "./document-authenticity"
import type { ApplicationInsights } from "./statement-insights"

const rand = (cents: number | null) => (cents === null ? null : cents / 100)
const MONEY = "#,##0.00"
/** Money-out categories: the Monthly sheet splits money out, and income categories never hold a debit. */
const CATEGORIES: Category[] = [...LIVING_CATEGORIES, ...OTHER_CATEGORIES].filter((c) => c !== "SALARY_INCOME" && c !== "OTHER_INCOME")

export function statementWorkbook(a: ApplicationInsights, reference: string, exportedOn: string): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  const signals = new Map<string, string[]>()
  for (const c of documentAuthenticity(a.facts)) {
    const id = String(c.evidence.documentId)
    signals.set(id, [...(signals.get(id) ?? []), c.code])
  }

  const summary = wb.addWorksheet("Summary")
  summary.addRows([
    ["Application", reference],
    ["Exported", exportedOn],
    ["Categoriser", CATEGORISER_VERSION],
    ["Note", "From statement — estimate. Categories are computed by rules and are not verified."],
    [],
  ])
  summary.addRow(["Statement", "Bank", "Period start", "Period end", "Opening (R)", "Closing (R)", "Balance check", "Read by", "Authenticity signals", "In the figures"]).font = { bold: true }
  a.read.forEach((s, i) => {
    const r = s.read!
    summary.addRow([
      i + 1, s.bank ?? "", r.periodStart ?? "", r.periodEnd ?? "", rand(r.openingBalanceCents), rand(r.closingBalanceCents), s.balanceCheck ?? "",
      s.method ?? "", [...(signals.get(s.documentId) ?? []), ...(s.authenticity?.signals ?? [])].join(", "), s.balanceCheck === "PASS" ? "yes" : "no — does not reconcile",
    ])
  })
  summary.getColumn(5).numFmt = MONEY
  summary.getColumn(6).numFmt = MONEY

  const txs = wb.addWorksheet("Transactions")
  txs.addRow(["Statement", "Date", "Description", "Amount (R)", "Balance (R)", "Category", "Page", "Moved money"]).font = { bold: true }
  a.read.forEach((s, i) => {
    for (const t of s.read!.transactions) {
      txs.addRow([i + 1, t.date, t.description, rand(t.amountCents), rand(t.balanceCents), categorise(t, { clientName: a.facts.clientName }).category, t.page, t.nonPosting ? "no" : "yes"])
    }
  })
  txs.getColumn(4).numFmt = MONEY
  txs.getColumn(5).numFmt = MONEY

  const monthly = wb.addWorksheet("Monthly")
  monthly.addRow(["Month", "Money in (R)", "Money out (R)", ...CATEGORIES.map((c) => `${c} (R)`)]).font = { bold: true }
  for (const m of a.insights.months) {
    monthly.addRow([m.month, rand(m.inCents), rand(m.outCents), ...CATEGORIES.map((c) => rand(m.byCategory[c] ?? 0))])
  }
  for (let c = 2; c <= CATEGORIES.length + 3; c++) monthly.getColumn(c).numFmt = MONEY
  return wb
}
