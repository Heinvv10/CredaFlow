import { describe, expect, it } from 'vitest'
import { assessAffordability } from '@/lib/affordability/ndi'
import { minimumLivingExpense } from '@/lib/affordability/mle'
import { calculateLoan } from '@/lib/loan-calculator'
import { canonicalBankName, SA_BANKS } from '@/lib/banks'
import { isValidSaIdChecksum } from '@/lib/ocr/saIdValidationService'
import {
  deriveDobFromSaId,
  deriveGenderFromSaId,
  isValidSaIdNumber,
  isValidSaPhone,
} from '@/lib/validation/client-wizard'
import { normaliseDebtAccountType } from '@/lib/credit/debt-account-types'
import { BACKGROUND_PLAN, LIVE_DEMO_PERSONAS, PERSONAS } from './index'
import { buildSaIdNumber } from './sa-id'
import { debtTotalCents, expenseTotalCents } from './build'
import { BANKS } from './catalog'
import type { Persona } from './types'

/** The seeded products (prisma/seed.ts), priced as the app prices them. */
function worstInstalmentCents(p: Persona): number {
  const micro = p.loanRequest.productCode === 'MICRO30'
  const result = calculateLoan({
    principal: p.loanRequest.amountCents,
    termDays: p.loanRequest.termDays,
    interestRatePm: micro ? 0.05 : 0.03,
    interestModel: micro ? 'DAILY_ACCRUAL' : 'REDUCING_BALANCE',
    initiationFeeModel: 'FLAT_PCT',
    initiationFeePct: micro ? 0.15 : 0.165,
    initiationFeeMax: micro ? 100_000 : 108_000,
    monthlyServiceFee: 6_900,
    productType: micro ? 'MICRO' : 'PERSONAL',
  }, new Date('2026-10-01T00:00:00Z'))
  return Math.max(...result.schedule.map((s) => s.totalDue))
}

function affordability(p: Persona) {
  return assessAffordability({
    monthlyIncomeCents: p.payroll.netCents,
    monthlyExpensesCents: expenseTotalCents(p.expenses),
    debts: p.debts.map((d) => ({ monthlyInstalment: d.monthlyInstalmentCents })),
    proposedInstalmentCents: worstInstalmentCents(p),
  })
}

describe('demo personas', () => {
  it('has 3 live-demo and 42 background personas covering every planned storyline', () => {
    expect(LIVE_DEMO_PERSONAS.map((p) => p.storyline)).toEqual([
      'live-clean-approve', 'live-affordability-decline', 'live-returning-client',
    ])
    expect(PERSONAS).toHaveLength(45)
    for (const [storyline, count] of BACKGROUND_PLAN) {
      expect(PERSONAS.filter((p) => p.storyline === storyline)).toHaveLength(count)
    }
  })

  it('is deterministic: a fresh import yields identical personas', async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    const again = (await import('./index')).PERSONAS
    expect(JSON.stringify(again)).toBe(JSON.stringify(PERSONAS))
  })

  it('pins the live-demo identity', () => {
    expect(LIVE_DEMO_PERSONAS.map((p) => [p.firstName, p.lastName, p.idNumber])).toEqual([
      ['Lerato', 'Mahlangu', '9008140001086'],
      ['Mxolisi', 'Ngcobo', '8402275002087'],
      ['Thembeka', 'Zwane', '7911030003082'],
    ])
  })

  it.each(PERSONAS.map((p) => [p.id, p] as const))('%s passes the app\'s own field validators', (_id, p) => {
    expect(isValidSaIdNumber(p.idNumber)).toBe(true)
    expect(isValidSaIdChecksum(p.idNumber)).toBe(true)
    expect(deriveDobFromSaId(p.idNumber)).toBe(p.dateOfBirth)
    expect(deriveGenderFromSaId(p.idNumber)).toBe(p.gender)
    expect(isValidSaPhone(p.phone)).toBe(true)
    expect(isValidSaPhone(p.nextOfKin.phone)).toBe(true)
    expect(p.email).toMatch(/^[a-z.]+@acme-lending\.invalid$/)
    expect(p.address.postalCode).toMatch(/^\d{4}$/)
    expect(p.bank.accountNumber).toMatch(/^\d{6,16}$/)
    expect(p.bank.branchCode).toMatch(/^\d{6}$/)
    expect(SA_BANKS.some((b) => b.code === p.bank.bankCode)).toBe(true)
    for (const d of p.debts) expect(normaliseDebtAccountType(d.accountType)).toBe(d.accountType)
    expect(p.payroll.grossCents - p.payroll.totalDeductionsCents).toBe(p.payroll.netCents)
    expect(expenseTotalCents(p.expenses)).toBeGreaterThanOrEqual(minimumLivingExpense(p.payroll.grossCents))
  })

  it('keeps names, emails, ID numbers, phones and account numbers unique', () => {
    for (const key of ['email', 'idNumber', 'phone'] as const) {
      expect(new Set(PERSONAS.map((p) => p[key])).size).toBe(PERSONAS.length)
    }
    expect(new Set(PERSONAS.map((p) => p.bank.accountNumber)).size).toBe(PERSONAS.length)
  })

  it('prints a bank name the app canonicalises to the stored bank code', () => {
    for (const bank of BANKS) {
      const code = SA_BANKS.find((b) => b.canonical === canonicalBankName(bank.displayName))?.code
      expect(code).toBe(bank.code)
    }
  })

  it('builds the SA ID check digit the app accepts, and rejects a flipped one', () => {
    const id = buildSaIdNumber({ dateOfBirth: '1985-03-01', gender: 'MALE', index: 1 })
    expect(isValidSaIdChecksum(id)).toBe(true)
    const flipped = `${id.slice(0, 12)}${(Number(id[12]) + 1) % 10}`
    expect(isValidSaIdChecksum(flipped)).toBe(false)
  })

  it('makes the affordability outcome the storyline needs, priced by the app\'s calculator', () => {
    for (const p of PERSONAS) {
      const wantAffordable = !['live-affordability-decline', 'declined'].includes(p.storyline)
      expect({ id: p.id, affordable: affordability(p).isAffordable }).toEqual({ id: p.id, affordable: wantAffordable })
    }
  })

  it('leaves the clean-approve persona well clear of the line', () => {
    const p = LIVE_DEMO_PERSONAS[0]!
    const a = affordability(p)
    expect(a.ndiAfterLoan).toBeGreaterThan(a.discretionaryIncome * 0.4)
    expect(debtTotalCents(p.debts)).toBeLessThan(p.payroll.netCents * 0.05)
  })
})
