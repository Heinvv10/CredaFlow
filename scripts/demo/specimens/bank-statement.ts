/**
 * Specimen 3-month bank statement PDF.
 *
 * Page 1 carries everything the VLM reads (the app renders only page 1 for
 * extraction): bank name, account holder, account number, account type and
 * statement date, above the first transactions. The bank's name appears as
 * text only — no logo, no brand artwork — and the page says it was not issued
 * by that bank.
 */
import type { Persona } from '../personas/types'
import { bankDef } from '../personas/catalog'
import { type CalendarDate, isoDate, printDate } from './pay-schedule'
import { A4, MARGIN, SPECIMEN_FOOTER, drawFooter, drawWatermark, money, newDocument, rule, shade, text, textRight } from './pdf-kit'
import type { StatementData } from './statement-lines'

export interface BankStatementExpectation {
  bankName: string
  accountHolder: string
  accountNumber: string
  accountType: 'CHEQUE' | 'SAVINGS'
  statementDate: string
}

export function accountTypePrinted(p: Persona): string {
  return p.bank.accountType === 'CHEQUE' ? 'Cheque Account' : 'Savings Account'
}

export function bankStatementExpectation(p: Persona, period: { end: CalendarDate }): BankStatementExpectation {
  return {
    bankName: bankDef(p.bank.bankCode).displayName,
    accountHolder: `${p.firstName} ${p.lastName}`,
    accountNumber: p.bank.accountNumber,
    accountType: p.bank.accountType,
    statementDate: isoDate(period.end),
  }
}

const ROW = 14
const FIRST_PAGE_ROWS = 34
const LATER_PAGE_ROWS = 50

export async function renderBankStatement(
  p: Persona,
  period: { start: CalendarDate; end: CalendarDate },
  data: StatementData,
): Promise<Uint8Array> {
  const bank = bankDef(p.bank.bankCode)
  const { doc, fonts } = await newDocument(`${bank.displayName} statement ${isoDate(period.end)} — SPECIMEN`)
  const right = A4[0] - MARGIN
  const pageCount = Math.max(1, 1 + Math.ceil(Math.max(0, data.lines.length - FIRST_PAGE_ROWS) / LATER_PAGE_ROWS))
  const cols = { date: MARGIN + 4, desc: MARGIN + 74, debit: 390, credit: 465, balance: right - 4 }

  const tableHeader = (page: ReturnType<typeof doc.addPage>, y: number): number => {
    shade(page, MARGIN, y - 5, right - MARGIN, 18)
    text(page, fonts, 'Date', cols.date, y, { bold: true })
    text(page, fonts, 'Description', cols.desc, y, { bold: true })
    textRight(page, fonts, 'Debit', cols.debit, y, { bold: true })
    textRight(page, fonts, 'Credit', cols.credit, y, { bold: true })
    textRight(page, fonts, 'Balance', cols.balance, y, { bold: true })
    return y - ROW - 4
  }

  let lineIndex = 0
  for (let pageNo = 1; pageNo <= pageCount; pageNo++) {
    const page = doc.addPage([...A4])
    await drawWatermark(doc, page)
    let y = A4[1] - 56
    if (pageNo === 1) {
      text(page, fonts, bank.displayName, MARGIN, y, { size: 20, bold: true })
      textRight(page, fonts, 'Account Statement', right, y, { size: 14, bold: true })
      y -= 15
      text(page, fonts, `SPECIMEN — NOT ISSUED BY ${bank.displayName.toUpperCase()} — NOT A VALID DOCUMENT`, MARGIN, y, { size: 8, bold: true, color: [0.75, 0.15, 0.15] })
      y -= 26
      const holder = [
        // Title Case for the same reason as the ID card (see id-card.ts): the
        // VLM read "KAVITHA ABRAMHS" off the upper-case form of this line.
        `${p.firstName} ${p.lastName}`,
        p.address.addressLine1.toUpperCase(),
        p.address.suburb.toUpperCase(),
        `${p.address.city.toUpperCase()} ${p.address.postalCode}`,
      ]
      const facts: ReadonlyArray<readonly [string, string]> = [
        ['Account Holder', `${p.firstName} ${p.lastName}`],
        ['Account Number', p.bank.accountNumber],
        ['Account Type', accountTypePrinted(p)],
        ['Branch Code', p.bank.branchCode],
        ['Statement Date', printDate(period.end)],
        ['Statement Period', `${printDate(period.start)} to ${printDate(period.end)}`],
      ]
      const top = y
      holder.forEach((line, i) => text(page, fonts, line, MARGIN, top - i * 14, { size: 10, bold: i === 0 }))
      facts.forEach(([label, value], i) => {
        text(page, fonts, label, 300, top - i * 15, { size: 9, color: [0.4, 0.4, 0.4] })
        text(page, fonts, value, 400, top - i * 15, { size: 10, bold: true })
      })
      y = top - facts.length * 15 - 12
      rule(page, y)
      y -= 18
      const summary: ReadonlyArray<readonly [string, number]> = [
        ['Opening Balance', data.openingBalanceCents],
        ['Total Credits', data.totalCreditsCents],
        ['Total Debits', data.totalDebitsCents],
        ['Closing Balance', data.closingBalanceCents],
      ]
      const colW = (right - MARGIN) / 4
      summary.forEach(([label, cents], i) => {
        text(page, fonts, label, MARGIN + i * colW, y, { size: 8, color: [0.4, 0.4, 0.4] })
        text(page, fonts, `R ${money(cents)}`, MARGIN + i * colW, y - 13, { size: 11, bold: true })
      })
      y -= 36
    } else {
      text(page, fonts, `${bank.displayName} — ${p.bank.accountNumber} — continued`, MARGIN, y, { size: 10, bold: true })
      y -= 24
    }
    y = tableHeader(page, y)
    if (pageNo === 1) {
      text(page, fonts, printDate(period.start), cols.date, y)
      text(page, fonts, 'OPENING BALANCE', cols.desc, y)
      textRight(page, fonts, money(data.openingBalanceCents), cols.balance, y)
      y -= ROW
    }
    const rows = pageNo === 1 ? FIRST_PAGE_ROWS : LATER_PAGE_ROWS
    for (let r = 0; r < rows && lineIndex < data.lines.length; r++, lineIndex++) {
      const line = data.lines[lineIndex]!
      text(page, fonts, printDate(line.date), cols.date, y)
      text(page, fonts, line.description, cols.desc, y)
      if (line.amountCents < 0) textRight(page, fonts, money(-line.amountCents), cols.debit, y)
      else textRight(page, fonts, money(line.amountCents), cols.credit, y)
      textRight(page, fonts, money(line.balanceCents), cols.balance, y)
      y -= ROW
    }
    if (lineIndex >= data.lines.length) {
      rule(page, y + 8)
      text(page, fonts, 'CLOSING BALANCE', cols.desc, y - 6, { bold: true })
      textRight(page, fonts, money(data.closingBalanceCents), cols.balance, y - 6, { bold: true })
    }
    textRight(page, fonts, `Page ${pageNo} of ${pageCount}`, right, 22, { size: 7 })
    drawFooter(page, fonts, SPECIMEN_FOOTER)
  }
  return doc.save({ useObjectStreams: false })
}
