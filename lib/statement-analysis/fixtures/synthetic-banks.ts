/**
 * Synthetic Nedbank, ABSA (both layouts), Standard Bank and Discovery
 * statements, laid out as the text readers expect: the labels, column order,
 * date and money formats learned from masked corpus shapes. Every value is
 * invented ("T TESTER", zero account numbers, made-up merchants).
 */
import { formatCents } from "../money"
import type { SynthBank } from "./dataset"
import {
  balances, buildCapitecStatement, buildFnbStatement, lpad, MON, pad, paginate, render,
  type BuildOptions, type SynthStatement,
} from "./synthetic"

type NewBank = Exclude<SynthBank, "CAPITEC" | "FNB">

export const NEW_BANK_PRODUCERS: Record<NewBank, { producer: string; creator: string }> = {
  NEDBANK: { producer: "", creator: "OpenText Exstream Version 16.6.60 64-bit" },
  ABSA: { producer: "iText 2.1.7 by 1T3XT", creator: "BIRT Report Engine /synthetic/birt-runtime-4.6.0.jar." },
  ABSA_ESTATEMENT: { producer: "TargetStream StreamEDS rv1.7.83 for For Absa Group Limited", creator: "TargetStream Technologies" },
  STANDARD_BANK: { producer: "PDFlib+PDI 9.0.7 (Linux)", creator: "Designer 16.0.12 Build: 215" },
  DISCOVERY: { producer: "", creator: "" },
}

const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
const dMonY = (iso: string) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`
const ddMonYy = (iso: string) => `${iso.slice(8, 10)} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(2, 4)}`
/** 1,234.56 with no sign. */
const plain = (c: number) => formatCents(Math.abs(c)).replace("R", "").replace(/ /g, ",")
/** 1 234,56 with a trailing minus for a debit (ABSA eStatement). */
const comma = (c: number) => `${formatCents(Math.abs(c)).replace("R", "").replace(".", ",")}${c < 0 ? "-" : ""}`

interface Printed { amounts: number[]; bal: number[]; closing: number }
function printed(s: SynthStatement, opts: BuildOptions): Printed {
  const bal = balances(s)
  const amounts = s.transactions.map((t, i) => (opts.misprint?.index === i ? opts.misprint.amountCents : t.amountCents))
  return { amounts, bal, closing: bal.length ? bal[bal.length - 1] : s.openingCents }
}

export function nedbankLines(s: SynthStatement, opts: BuildOptions = {}): string[][] {
  const { amounts, bal, closing } = printed(s, opts)
  const signed = (c: number) => `${c < 0 ? "-" : ""}${plain(c)}`
  const head = [
    pad("", 120) + "nedbank.co.za",
    `MR ${s.holder}`,
    "1 Synthetic Street",
    "",
    "  Account summary",
    `  ${pad("Account type", 60)}Account number`,
    `  ${pad("Current account", 60)}${s.accountNumber}`,
    `  ${pad("Statement period:", 25)}${dmy(s.periodStart)} – ${dmy(s.periodEnd)}`,
    `  ${pad("Opening balance", 25)}${signed(s.openingCents).replace(/^(-?)/, "$1R")}`,
    `  ${pad("Closing balance", 25)}${signed(closing).replace(/^(-?)/, "$1R")}`,
  ]
  const header = [`${pad("Tran list no", 14)}${pad("Date", 12)}${pad("Description", 50)}${lpad("Fees (R)", 14)}${lpad("Debits (R)", 16)}${lpad("Credits (R)", 16)}${lpad("Balance (R)", 16)}`]
  const rows = [
    `${pad("", 14)}${pad(dmy(s.periodStart), 12)}${pad("Opening balance", 50)}${lpad("", 46)}${lpad(signed(s.openingCents), 16)}`,
    ...s.transactions.map((t, i) => `${pad("", 14)}${pad(dmy(t.date), 12)}${pad(t.description, 50)}${lpad(t.accruedFeeCents ? plain(t.accruedFeeCents) : "", 14)}` +
      `${lpad(amounts[i] < 0 ? plain(amounts[i]) : "", 16)}${lpad(amounts[i] > 0 ? plain(amounts[i]) : "", 16)}${lpad(signed(bal[i]), 16)}`),
  ]
  const footer = ["", "Balance carried forward", "Nedbank Ltd Reg No 1951/000009/06. Synthetic fixture, not a real statement"]
  return paginate(head, header, rows, footer)
}

export function absaLines(s: SynthStatement, opts: BuildOptions = {}): string[][] {
  const { amounts, bal, closing } = printed(s, opts)
  const r = (c: number) => `${c < 0 ? "-" : ""}R${formatCents(Math.abs(c)).replace("R", "")}`
  const head = [
    pad("", 70) + "eStamp",
    "Transaction History (2026-10-01 08:00:00)",
    `${pad(s.holder, 50)}ABSA`,
    `${pad("1 Synthetic Street", 50)}${s.accountNumber}`,
    `${pad("Current Balance", 50)}${r(closing)}`,
    `Statement for the Period ${s.periodStart} - ${s.periodEnd}`,
  ]
  const header = [`${pad("Date", 13)}${pad("Transaction Description", 52)}${lpad("Amount", 14)}${lpad("Balance", 16)}`]
  const rows = [
    "Balance Brought Forward",
    ...s.transactions.map((t, i) => `${pad(t.date, 13)}${pad(t.description, 52)}${lpad(r(amounts[i]), 14)}${lpad(r(bal[i]), 16)}`),
    `${pad("Balance Carried Forward", 79)}${lpad(r(closing), 16)}`,
  ]
  return paginate(head, header, rows, ["", "2026-10-01 08:00:00   Page 1 of 1", "www.absa.co.za   Synthetic fixture, not a real statement"])
}

/** ABSA's eStatement: d Mon yyyy dates, comma decimals, a trailing minus on debits, charges on sub-lines. */
export function absaEstatementLines(s: SynthStatement, opts: BuildOptions = {}): string[][] {
  const { amounts, bal, closing } = printed(s, opts)
  const head = [
    pad("", 70) + "eStamp",
    "",
    "Account statement",
    `${dMonY(s.periodStart)} to ${dMonY(s.periodEnd)}`,
    `Account number   ${s.accountNumber.replace(/^(\d{2})(\d{4})(\d{4})$/, "$1 $2 $3")}`,
    `${pad("Balance on " + dMonY(s.periodEnd), 80)}${lpad(comma(closing), 16)}`,
    "Transaction history",
  ]
  const header = [`${pad("date", 13)}${pad("description", 50)}${lpad("transaction amount R", 22)}${lpad("balance R", 16)}`]
  const rows = [`${pad(dMonY(s.periodStart), 13)}${pad("Balance Brought Forward", 72)}${lpad(comma(s.openingCents), 16)}`]
  s.transactions.forEach((t, i) => {
    // Every other row prints its title on the dated line and its money on the line below, as the bank does.
    if (i % 2) {
      rows.push(`${pad(dMonY(t.date), 13)}${t.description}`)
      rows.push(`${pad("", 13)}${pad(t.description, 50)}${lpad(comma(amounts[i]), 22)}${lpad(comma(bal[i]), 16)}`)
    } else {
      rows.push(`${pad(dMonY(t.date), 13)}${pad(t.description, 50)}${lpad(comma(amounts[i]), 22)}${lpad(comma(bal[i]), 16)}`)
    }
  })
  return paginate(head, header, rows, ["", "Page 1   www.absa.co.za   Synthetic fixture, not a real statement"])
}

export function standardBankLines(s: SynthStatement, opts: BuildOptions = {}): string[][] {
  const { amounts, bal } = printed(s, opts)
  const signed = (c: number) => `${c < 0 ? "-" : ""}${plain(c)}`
  const head = [
    pad("", 110) + "Website: www.standardbank.co.za",
    pad("STANDARD BANK", 110) + `From: ${ddMonYy(s.periodStart)}`,
    pad("", 110) + `To: ${ddMonYy(s.periodEnd)}`,
    `Account number: ${s.accountNumber.replace(/^(\d{2})(\d{2})(\d{3})(\d{3})$/, "$1 $2 $3 $4")}`,
    `Account holder:          Mr. ${s.holder}`,
    "Transaction details",
  ]
  const header = [`  ${pad("Date", 14)}${pad("Description", 54)}${lpad("Payments", 16)}${lpad("Deposits", 16)}${lpad("Balance", 16)}`]
  const rows = [`  ${pad("", 14)}${pad("STATEMENT OPENING BALANCE", 54)}${lpad("", 32)}${lpad(signed(s.openingCents), 16)}`, ""]
  s.transactions.forEach((t, i) => {
    rows.push(`  ${pad(ddMonYy(t.date), 14)}${pad(t.description, 54)}${lpad(amounts[i] < 0 ? signed(amounts[i]) : "", 16)}` +
      `${lpad(amounts[i] > 0 ? signed(amounts[i]) : "", 16)}${lpad(signed(bal[i]), 16)}`)
    rows.push(`  ${pad("", 14)}${amounts[i] < 0 ? "SYNTH PURCHASE" : "SYNTH PAYMENT FROM"}`, "")
  })
  // The bank prints totals, not a closing balance (the misprint is in the rows, not the totals).
  const total = (sign: number) => s.transactions.reduce((sum, t) => sum + (Math.sign(t.amountCents) === sign ? t.amountCents : 0), 0)
  rows.push("Statement Summary", `   ${pad("Payments", 30)}-R${plain(total(-1))}`, `   ${pad("Deposits", 30)}R${plain(total(1))}`)
  return paginate(head, header, rows, ["", "The Standard Bank of South Africa Limited. Synthetic fixture, not a real statement"])
}

export function discoveryLines(s: SynthStatement, opts: BuildOptions = {}): string[][] {
  const { amounts, bal } = printed(s, opts)
  const r = (c: number) => `R ${plain(c)}${c < 0 ? "-" : ""}`
  const head = [
    `   ${pad("Account holder: " + s.holder, 80)}From: ${s.periodStart} To: ${s.periodEnd}`,
    `   ${pad("Account type: Transaction Account", 80)}Account number: ${s.accountNumber}`,
  ]
  const header = [`      ${pad("Date", 14)}${pad("Description", 58)}${lpad("Debit", 14)}${lpad("Credit", 14)}${lpad("Balance", 16)}`]
  const rows = s.transactions.map((t, i) => `      ${pad(t.date, 14)}${pad(t.description, 58)}` +
    `${lpad(amounts[i] < 0 ? r(-amounts[i]) : "", 14)}${lpad(amounts[i] > 0 ? r(amounts[i]) : "", 14)}${lpad(r(bal[i]), 16)}`)
  return paginate(head, header, rows, ["", "Discovery Bank Limited. discovery.co.za. Synthetic fixture, not a real statement"])
}

const LINES: Record<NewBank, (s: SynthStatement, opts?: BuildOptions) => string[][]> = {
  NEDBANK: nedbankLines,
  ABSA: absaLines,
  ABSA_ESTATEMENT: absaEstatementLines,
  STANDARD_BANK: standardBankLines,
  DISCOVERY: discoveryLines,
}

/** Builds any fixture bank's statement. */
export function buildStatement(bank: SynthBank, s: SynthStatement, opts: BuildOptions = {}): Promise<Uint8Array> {
  if (bank === "CAPITEC") return buildCapitecStatement(s, opts)
  if (bank === "FNB") return buildFnbStatement(s, opts)
  return render(LINES[bank](s, opts), opts, NEW_BANK_PRODUCERS[bank])
}

/**
 * Where the doctored fixtures edit each bank's statement: the row, and that
 * row's amount as printed before and after the edit. ABSA and Discovery print
 * no opening balance, so their first row cannot be checked by arithmetic
 * (the opening is derived from it): their edits land on the second row.
 */
export const TAMPER_TARGET: Record<SynthBank, { row: number; printed: [string, string] }> = {
  CAPITEC: { row: 0, printed: ["-845.50", "-945.50"] },
  FNB: { row: 0, printed: ["845.50", "945.50"] },
  NEDBANK: { row: 0, printed: ["845.50", "945.50"] },
  ABSA: { row: 1, printed: ["-R99.00", "-R98.00"] },
  ABSA_ESTATEMENT: { row: 0, printed: ["845,50-", "945,50-"] },
  STANDARD_BANK: { row: 0, printed: ["-845.50", "-945.50"] },
  DISCOVERY: { row: 1, printed: ["R 99.00", "R 98.00"] },
}

/** The detected bank a fixture bank reads as. */
export const DETECTED_AS: Record<SynthBank, string> = {
  CAPITEC: "CAPITEC", FNB: "FNB", NEDBANK: "NEDBANK", ABSA: "ABSA", ABSA_ESTATEMENT: "ABSA", STANDARD_BANK: "STANDARD_BANK", DISCOVERY: "DISCOVERY",
}
