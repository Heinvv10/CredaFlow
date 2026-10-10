import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LIVE_DEMO_PERSONAS, getPersona } from '../personas'
import { buildKits } from './index'
import { RECORDED_DECLINE_REASON } from './stories'

const ASOF = '2026-10-10'
let root = ''
// A synthetic stand-in for the presenter photo: tests never read the real one.
let photo: Buffer = Buffer.alloc(0)

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'demo-kits-'))
  photo = await sharp({ create: { width: 1200, height: 1600, channels: 3, background: { r: 20, g: 90, b: 200 } } }).jpeg().toBuffer()
  await buildKits(LIVE_DEMO_PERSONAS, ASOF, join(root, 'kit'), photo)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('buildKits', () => {
  it('writes one private folder per live persona with the upload files and both cheat sheets', () => {
    const out = join(root, 'kit')
    expect(statSync(out).mode & 0o777).toBe(0o700)
    expect(readdirSync(out).sort()).toEqual(['README.md', ...LIVE_DEMO_PERSONAS.map((p) => p.id)].sort())
    // Each persona folder holds an ID card printed with a real face.
    for (const p of LIVE_DEMO_PERSONAS) expect([p.id, statSync(join(out, p.id)).mode & 0o777]).toEqual([p.id, 0o700])
    expect(readdirSync(join(out, 'live-clean-approve')).sort()).toEqual([
      'CHEAT-SHEET.md', 'CHEAT-SHEET.pdf', 'bank-statement-2026-09.pdf', 'id-card.png', 'manifest.json',
      'payslip-2026-07.pdf', 'payslip-2026-08.pdf', 'payslip-2026-09.pdf',
    ])
  })

  it.each(LIVE_DEMO_PERSONAS.map((p) => [p.id, p] as const))('%s: cheat sheet PDF is exactly one page', async (id) => {
    const pdf = await PDFDocument.load(readFileSync(join(root, 'kit', id, 'CHEAT-SHEET.pdf')))
    expect(pdf.getPageCount()).toBe(1)
  })

  it('puts the typed details, roles and selfie script on the sheet, and no credentials', () => {
    const p = getPersona('live-clean-approve')
    const md = readFileSync(join(root, 'kit', p.id, 'CHEAT-SHEET.md'), 'utf8')
    for (const needle of [p.idNumber, p.email, p.phone, p.bank.accountNumber, p.employment.employerName, '[CREDIT OFFICER]', '[ADMIN]', '[CLIENT]', 'At the selfie step']) {
      expect(md).toContain(needle)
    }
    expect(md).not.toMatch(/TOTP secret|password:\s*\S/i)
  })

  it.each([...LIVE_DEMO_PERSONAS.map((p) => `${p.id}/CHEAT-SHEET.md`), 'README.md'])('%s carries no credential value', (file) => {
    const text = readFileSync(join(root, 'kit', file), 'utf8')
    // A labelled value: "password: x", "TOTP secret = x", "code: 123456", …
    expect(text).not.toMatch(/\b(password|passcode|passphrase|pin|secret|token|otp|totp|code)\b\s*[:=]\s*\S/i)
    // An authenticator enrolment URI, or a bare base32 TOTP secret.
    expect(text).not.toMatch(/otpauth:\/\//i)
    expect(text).not.toMatch(/\b[A-Z2-7]{16,}\b/)
  })

  it('tells the decline story with the reason the product returns', () => {
    const md = readFileSync(join(root, 'kit', 'live-affordability-decline', 'CHEAT-SHEET.md'), 'utf8')
    expect(md).toContain(RECORDED_DECLINE_REASON)
    expect(md).not.toContain('Disburse Loan')
  })

  it('lists the three stories in running order in the README', () => {
    const readme = readFileSync(join(root, 'kit', 'README.md'), 'utf8')
    const at = LIVE_DEMO_PERSONAS.map((p) => readme.indexOf(`\`${p.id}/\``))
    expect(at.every((i) => i > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })
})
