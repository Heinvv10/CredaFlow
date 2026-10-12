/**
 * Specimen payslip PDF: one page, Current + YTD columns.
 *
 * The two-column layout is deliberate — it is the SA norm and the shape
 * lib/vlm-extract.ts is hardened against (it must read "Current", never YTD).
 * The current column is headed exactly "Current", a heading on that code's
 * allow-list, so a correct read passes applyPayslipPostProcessing.
 */
import type { Persona } from '../personas/types'
import { bankDef } from '../personas/catalog'
import { type CalendarDate, isoDate, parseIsoDate, payPeriod, printDate, taxYearMonthsTo } from './pay-schedule'
import { A4, MARGIN, SPECIMEN_FOOTER, drawFooter, drawWatermark, money, newDocument, rule, shade, text, textRight } from './pdf-kit'

export interface PayslipExpectation {
  employerName: string
  employeeName: string
  employeeIdNumber: string
  grossIncome: number
  netIncome: number
  totalDeductions: number
  payPeriod: string
  payDate: string
}

export function payslipExpectation(p: Persona, pay: CalendarDate): PayslipExpectation {
  return {
    employerName: p.employment.employerName,
    employeeName: `${p.firstName} ${p.lastName}`,
    employeeIdNumber: p.idNumber,
    grossIncome: p.payroll.grossCents,
    netIncome: p.payroll.netCents,
    totalDeductions: p.payroll.totalDeductionsCents,
    payPeriod: isoDate(pay).slice(0, 7),
    payDate: isoDate(pay),
  }
}

export async function renderPayslip(p: Persona, pay: CalendarDate): Promise<Uint8Array> {
  const { doc, fonts } = await newDocument(`Payslip ${isoDate(pay).slice(0, 7)} — SPECIMEN`)
  const page = doc.addPage([...A4])
  await drawWatermark(doc, page)
  const right = A4[0] - MARGIN
  const pr = p.payroll
  const ytdMonths = taxYearMonthsTo(pay, parseIsoDate(p.employment.employmentStartDate))
  const period = payPeriod(pay)
  let y = A4[1] - 56

  text(page, fonts, p.employment.employerName, MARGIN, y, { size: 16, bold: true })
  textRight(page, fonts, 'PAYSLIP', right, y, { size: 16, bold: true })
  y -= 16
  text(page, fonts, p.employment.employerAddress, MARGIN, y, { size: 9 })
  textRight(page, fonts, 'SPECIMEN — NOT A VALID DOCUMENT', right, y, { size: 8, bold: true, color: [0.75, 0.15, 0.15] })
  y -= 22
  rule(page, y)
  y -= 18

  const details: ReadonlyArray<readonly [string, string, string, string]> = [
    ['Employee', `${p.firstName} ${p.lastName}`, 'Employee No', p.employment.employeeNumber],
    ['ID Number', p.idNumber, 'Tax Reference', pr.taxReference],
    ['Job Title', p.employment.occupation, 'Engagement Date', printDate(parseIsoDate(p.employment.employmentStartDate))],
    ['Period', `${printDate(period.start)} to ${printDate(period.end)}`, 'Pay Date', printDate(pay)],
    ['Bank', bankDef(p.bank.bankCode).displayName, 'Account', `****${p.bank.accountNumber.slice(-4)}`],
  ]
  for (const [l1, v1, l2, v2] of details) {
    text(page, fonts, l1, MARGIN, y, { size: 9, color: [0.4, 0.4, 0.4] })
    text(page, fonts, v1, MARGIN + 80, y, { size: 10, bold: true })
    text(page, fonts, l2, 330, y, { size: 9, color: [0.4, 0.4, 0.4] })
    text(page, fonts, v2, 420, y, { size: 10, bold: true })
    y -= 17
  }
  y -= 10

  const colCurrent = 400
  const colYtd = right
  const section = (heading: string, rows: ReadonlyArray<readonly [string, number]>, totalLabel: string, total: number): void => {
    shade(page, MARGIN, y - 5, right - MARGIN, 18)
    text(page, fonts, heading, MARGIN + 6, y, { size: 10, bold: true })
    textRight(page, fonts, 'Current', colCurrent, y, { size: 10, bold: true })
    textRight(page, fonts, 'YTD', colYtd - 6, y, { size: 10, bold: true })
    y -= 20
    for (const [label, cents] of rows) {
      text(page, fonts, label, MARGIN + 6, y, { size: 10 })
      textRight(page, fonts, money(cents), colCurrent, y, { size: 10 })
      textRight(page, fonts, money(cents * ytdMonths), colYtd - 6, y, { size: 10 })
      y -= 16
    }
    rule(page, y + 10, colCurrent - 90, right)
    text(page, fonts, totalLabel, MARGIN + 6, y - 2, { size: 10, bold: true })
    textRight(page, fonts, money(total), colCurrent, y - 2, { size: 10, bold: true })
    textRight(page, fonts, money(total * ytdMonths), colYtd - 6, y - 2, { size: 10, bold: true })
    y -= 30
  }

  const earnings: Array<readonly [string, number]> = [['Basic Salary', pr.basicCents]]
  if (pr.allowanceCents > 0) earnings.push(['Travel Allowance', pr.allowanceCents])
  section('Earnings', earnings, 'Total Earnings', pr.grossCents)

  const deductions: Array<readonly [string, number]> = [['PAYE', pr.payeCents], ['UIF', pr.uifCents]]
  if (pr.pensionCents > 0) deductions.push(['Pension Fund', pr.pensionCents])
  if (pr.medicalAidCents > 0) deductions.push(['Medical Aid', pr.medicalAidCents])
  section('Deductions', deductions, 'Total Deductions', pr.totalDeductionsCents)

  shade(page, MARGIN, y - 8, right - MARGIN, 26, 0.86)
  text(page, fonts, 'NET PAY', MARGIN + 6, y, { size: 13, bold: true })
  textRight(page, fonts, `R ${money(pr.netCents)}`, colCurrent, y, { size: 13, bold: true })
  y -= 40
  text(page, fonts, `Paid by EFT on ${printDate(pay)}. Year-to-date figures cover ${ytdMonths} month(s) of the tax year.`, MARGIN, y, { size: 8, color: [0.4, 0.4, 0.4] })

  drawFooter(page, fonts, SPECIMEN_FOOTER)
  return doc.save({ useObjectStreams: false })
}
