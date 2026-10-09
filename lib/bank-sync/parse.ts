import type { ParsedStatementLine } from "./types"

// Column order in the ABSA "Transaction History" CSV export. Layout confirmed
// against a real export 2026-07-14 (example values below are invented): header is `Date,Description,Amount,Balance` — there is
// NO dedicated reference column; the payer's reference is embedded in the free-
// text Description (e.g. "DIGITAL TRANSF CR 12345678-1234-0001 ABSA BANK TST to
// Acme Store"), so `rawReference` is sourced from Description below.
const COLUMNS = { date: 0, description: 1, amount: 2, balance: 3 }
const HEADER_FIRST_CELL = "date"

function parseDate(raw: string): Date {
  const s = raw.trim()
  // ABSA exports dates as YYYYMMDD (e.g. 20260707). Also accept ISO and DD/MM/YYYY.
  const ymd = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
  if (ymd) return new Date(Date.UTC(+ymd[1], +ymd[2] - 1, +ymd[3]))
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]))
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s)
  if (dmy) return new Date(Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1]))
  throw new Error(`Unparseable statement date: "${raw}"`)
}

function parseCents(raw: string): number {
  const cleaned = raw.trim().replace(/[, ]/g, "")
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error(`Unparseable statement amount: "${raw}"`)
  }
  return Math.round(parseFloat(cleaned) * 100)
}

function parseCentsOrNull(raw: string | undefined): number | null {
  if (!raw || !raw.trim()) return null
  try {
    return parseCents(raw)
  } catch {
    return null
  }
}

// Minimal CSV split honouring double-quoted cells (no embedded newlines).
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ""
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === "," && !inQuotes) { out.push(cur); cur = "" }
    else cur += ch
  }
  out.push(cur)
  return out.map((c) => c.trim())
}

export function parseStatementCsv(raw: string): ParsedStatementLine[] {
  const rows = raw.split(/\r?\n/).filter((l) => l.trim().length > 0)
  const out: ParsedStatementLine[] = []
  for (const row of rows) {
    const cells = splitCsvLine(row)
    if (cells[COLUMNS.date]?.toLowerCase() === HEADER_FIRST_CELL) continue // header
    const amountCents = parseCents(cells[COLUMNS.amount] ?? "")
    const balanceRaw = cells[COLUMNS.balance]
    out.push({
      postedDate: parseDate(cells[COLUMNS.date] ?? ""),
      valueDate: null,
      amountCents,
      direction: amountCents >= 0 ? "CREDIT" : "DEBIT",
      // No dedicated reference column in the ABSA export — the reference is
      // inside the Description free text, so the matcher searches that.
      rawReference: cells[COLUMNS.description] || null,
      counterparty: null,
      balanceCents: parseCentsOrNull(balanceRaw),
      bankTxnId: null,
    })
  }
  return out
}
