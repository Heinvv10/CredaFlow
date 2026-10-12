import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, describe, expect, it } from 'vitest'
import { PERSONAS, getPersona } from '../personas'
import { fitIdPhoto, idCardSvg, renderIdCard } from './id-card'
import { generateSpecimens } from './index'
import { presenterPhotoFor } from './presenter-photo'
import { lastThreePayDates, parseIsoDate, payDateIn, statementPeriod } from './pay-schedule'
import { buildStatement, employerShortName } from './statement-lines'

const dirs: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'demo-specimens-'))
  dirs.push(dir)
  return dir
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('pay schedule', () => {
  it('moves a weekend pay date back to the Friday', () => {
    // 25 Jul 2026 is a Saturday, 25 Oct 2026 a Sunday.
    expect(payDateIn(2026, 7, 25)).toEqual({ year: 2026, month: 7, day: 24 })
    expect(payDateIn(2026, 10, 25)).toEqual({ year: 2026, month: 10, day: 23 })
    expect(payDateIn(2026, 2, 31)).toEqual({ year: 2026, month: 2, day: 27 })
  })

  it('takes the three most recent pay dates on or before as-of', () => {
    const asOf = parseIsoDate('2026-10-10')
    expect(lastThreePayDates(asOf, 25).map((d) => d.month)).toEqual([7, 8, 9])
    expect(lastThreePayDates(parseIsoDate('2026-10-23'), 25).map((d) => d.month)).toEqual([8, 9, 10])
  })
})

describe('bank statement lines', () => {
  it.each(PERSONAS.map((p) => [p.id, p] as const))('%s: salary, debit orders and balance reconcile', (_id, p) => {
    const asOf = parseIsoDate('2026-10-10')
    const pays = lastThreePayDates(asOf, p.employment.salaryPaymentDay)
    const period = statementPeriod(pays, asOf)
    const s = buildStatement(p, pays, period.end)

    const salaries = s.lines.filter((l) => l.description.startsWith('SALARY '))
    expect(salaries.map((l) => l.amountCents)).toEqual([p.payroll.netCents, p.payroll.netCents, p.payroll.netCents])
    expect(salaries[0]!.description).toBe(`SALARY ${employerShortName(p)}`)
    for (const d of p.debts) {
      const orders = s.lines.filter((l) => l.description === `DEBIT ORDER ${d.creditProvider.toUpperCase()}`)
      expect(orders.map((l) => -l.amountCents)).toEqual([d.monthlyInstalmentCents, d.monthlyInstalmentCents, d.monthlyInstalmentCents])
    }
    const sum = s.lines.reduce((acc, l) => acc + l.amountCents, 0)
    expect(s.closingBalanceCents).toBe(s.openingBalanceCents + sum)
    expect(s.totalCreditsCents - s.totalDebitsCents).toBe(sum)
    expect(Math.min(...s.lines.map((l) => l.balanceCents))).toBeGreaterThan(0)
  })
})

describe('generateSpecimens', () => {
  it('writes byte-identical files for the same persona and as-of date', async () => {
    const p = getPersona('live-clean-approve')
    const a = await generateSpecimens(p, '2026-10-10', scratch())
    const b = await generateSpecimens(p, '2026-10-10', scratch())
    expect(a.documents.map((d) => d.sha256)).toEqual(b.documents.map((d) => d.sha256))
  })

  it('writes an ID card, three payslips and a statement with a manifest describing them', async () => {
    const out = scratch()
    const p = getPersona('live-affordability-decline')
    const m = await generateSpecimens(p, '2026-10-10', out)
    expect(m.documents.map((d) => d.docType)).toEqual(['ID_COPY', 'PAYSLIP', 'PAYSLIP', 'PAYSLIP', 'BANK_STATEMENT'])
    expect(m.documents.map((d) => d.file)).toEqual([
      'id-card.png', 'payslip-2026-07.pdf', 'payslip-2026-08.pdf', 'payslip-2026-09.pdf', 'bank-statement-2026-09.pdf',
    ])
    const png = readFileSync(join(out, p.id, 'id-card.png'))
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(readFileSync(join(out, p.id, 'payslip-2026-09.pdf')).subarray(0, 4).toString()).toBe('%PDF')
    const onDisk = JSON.parse(readFileSync(join(out, p.id, 'manifest.json'), 'utf8')) as typeof m
    expect(onDisk.documents[3]!.expected).toMatchObject({
      employeeIdNumber: p.idNumber,
      netIncome: p.payroll.netCents,
      grossIncome: p.payroll.grossCents,
      payDate: '2026-09-25',
    })
    expect(onDisk.documents[4]!.expected).toMatchObject({ accountNumber: p.bank.accountNumber, statementDate: '2026-09-30' })
  })
})

// A synthetic stand-in for the presenter photo: tests never read the real one.
const fakePhoto = (): Promise<Buffer> =>
  sharp({ create: { width: 1200, height: 1600, channels: 3, background: { r: 0, g: 0, b: 255 } } }).jpeg().toBuffer()

describe('ID card photo', () => {
  it('draws the photo into the photo box, under both SPECIMEN watermarks', async () => {
    const p = getPersona('live-clean-approve')
    const png = await renderIdCard(p, await fakePhoto())
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
    const at = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3))
    expect(at(150, 260)).toEqual([0, 0, 254])
    expect(at(1500, 900)).not.toEqual([0, 0, 254])

    const svg = idCardSvg(p, await fitIdPhoto(await fakePhoto()))
    const image = svg.indexOf('<image ')
    expect(image).toBeGreaterThan(0)
    expect(svg.indexOf('rotate(-52', image)).toBeGreaterThan(image)
    expect(svg.indexOf('NOT A VALID DOCUMENT', image)).toBeGreaterThan(image)
    expect(svg).not.toContain('NO PHOTOGRAPH')
  })

  // Renders four full specimen sets (ID card, three payslips, a statement
  // each): ~5 s on an idle box, so the 5 s default fails it under any load.
  it('prints the photo on live-demo personas only', { timeout: 60_000 }, async () => {
    const photo = await fakePhoto()
    const sha = async (id: string, withPhoto: boolean) =>
      (await generateSpecimens(getPersona(id), '2026-10-10', scratch(), withPhoto ? { presenterPhoto: photo } : {})).documents[0]!.sha256
    expect(await sha('live-returning-client', true)).not.toBe(await sha('live-returning-client', false))
    expect(await sha('bg-04', true)).toBe(await sha('bg-04', false))
  })

  it('fails clearly when a live persona is requested and the photo file is missing', () => {
    const missing = join(scratch(), 'presenter.jpg')
    expect(() => presenterPhotoFor([getPersona('live-clean-approve')], missing)).toThrow(/live-clean-approve need the presenter photo at .*presenter\.jpg, and it is missing/)
    expect(presenterPhotoFor([getPersona('bg-04')], missing)).toBeUndefined()
  })
})
