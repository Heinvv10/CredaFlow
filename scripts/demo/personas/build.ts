/**
 * Builds one persona deterministically from a spec.
 *
 * Everything not pinned in `spec.fixed` is drawn from a PRNG seeded by the
 * persona id, so the same spec yields byte-identical output on every run.
 */
import { minimumLivingExpense } from '@/lib/affordability/mle'
import { demoLender, type DemoLender } from '@/prisma/demo-lender'
import { BANKS, CREDITORS, EMPLOYERS, FEMALE_FIRST_NAMES, MALE_FIRST_NAMES, STREETS, SURNAMES, TOWNS, bankDef } from './catalog'
import { buildPayroll } from './payroll'
import { createRng, roundRand, type Rng } from './prng'
import { buildSaIdNumber } from './sa-id'
import type {
  DebtAccountType, DebtObligation, ExpenseBreakdown, LoanRequest, Persona, PersonaBankCode,
  PersonaKind, Storyline,
} from './types'

/**
 * `affordable` personas pass NDI with room to spare; `over-indebted` ones carry
 * enough existing debt that a new instalment pushes NDI below zero.
 */
export type AffordabilityProfile = 'affordable' | 'over-indebted'

export interface PersonaSpec {
  index: number
  id: string
  kind: PersonaKind
  storyline: Storyline
  summary: string
  profile: AffordabilityProfile
  /** Bumped by the roster to redraw a name that collided; 0 by default. */
  nameSalt?: number
  fixed?: {
    firstName?: string
    lastName?: string
    gender?: 'MALE' | 'FEMALE'
    dateOfBirth?: string
    employerName?: string
    occupation?: string
    city?: string
    grossRands?: number
    allowanceRands?: number
    hasPension?: boolean
    medicalAidRands?: number
    salaryPaymentDay?: number
    bankCode?: PersonaBankCode
    accountType?: 'CHEQUE' | 'SAVINGS'
    debts?: ReadonlyArray<{ accountType: DebtAccountType; instalmentRands: number; months: number }>
    expensesRands?: number
    loanRequest?: LoanRequest
  }
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0')

function digits(rng: Rng, count: number): string {
  let out = ''
  for (let i = 0; i < count; i++) out += String(rng.int(0, 9))
  return out
}

const EXPENSE_WEIGHTS: Readonly<Record<keyof ExpenseBreakdown, number>> = {
  housing: 0.35, transport: 0.15, food: 0.28, education: 0.05, insurance: 0.05,
  clothing: 0.04, entertainment: 0.03, medical: 0.02, other: 0.03,
}

function splitExpenses(totalCents: number): ExpenseBreakdown {
  const out = {} as ExpenseBreakdown
  for (const key of Object.keys(EXPENSE_WEIGHTS) as Array<keyof ExpenseBreakdown>) {
    out[key] = roundRand(totalCents * EXPENSE_WEIGHTS[key], 10)
  }
  return out
}

export function expenseTotalCents(e: ExpenseBreakdown): number {
  return e.housing + e.transport + e.food + e.education + e.insurance + e.clothing
    + e.entertainment + e.medical + e.other
}

export function debtTotalCents(debts: readonly DebtObligation[]): number {
  return debts.reduce((sum, d) => sum + d.monthlyInstalmentCents, 0)
}

function randomDebts(rng: Rng, profile: AffordabilityProfile, netCents: number): Array<{ accountType: DebtAccountType; instalmentRands: number; months: number }> {
  if (profile === 'over-indebted') {
    const types: DebtAccountType[] = ['VEHICLE_FINANCE', 'PERSONAL_LOAN', 'CREDIT_CARD', 'STORE_ACCOUNT', 'MICROFINANCE']
    const target = netCents * (0.6 + rng.next() * 0.06)
    const weights = [0.4, 0.25, 0.13, 0.1, 0.12]
    return types.map((accountType, i) => ({
      accountType,
      instalmentRands: Math.round((target * weights[i]!) / 1000) * 10,
      months: rng.int(8, 48),
    }))
  }
  const pool: DebtAccountType[] = ['CLOTHING_ACCOUNT', 'STORE_ACCOUNT', 'CREDIT_CARD']
  const count = rng.int(0, 2)
  return pool.slice(0, count).map((accountType) => ({
    accountType,
    instalmentRands: Math.round((netCents * (0.03 + rng.next() * 0.04)) / 1000) * 10,
    months: rng.int(6, 24),
  }))
}

function defaultLoanRequest(rng: Rng, ndiCents: number, profile: AffordabilityProfile): LoanRequest {
  if (profile === 'over-indebted') {
    // Ask for an instalment well above what is left, so NDI after the loan is
    // negative whatever the exact pricing: principal/6 + 3% pm ≈ 1.6×NDI + R500.
    const instalment = Math.max(0, ndiCents) * 1.6 + 500_00
    const amountCents = Math.min(100_000_00, Math.max(5_000_00, roundRand(instalment / (1 / 6 + 0.03), 500)))
    return { productCode: 'PERSONAL', amountCents, termDays: 180 }
  }
  if (rng.chance(0.2)) {
    return { productCode: 'MICRO30', amountCents: rng.int(5, 20) * 100_00, termDays: 30 }
  }
  const months = rng.pick([6, 12, 18, 24] as const)
  // Rough instalment: principal/months plus ~3% pm interest and the R69 fee.
  // Kept to ~35% of NDI so the persona is comfortably affordable; the scenario
  // re-checks with the app's real calculator.
  const maxInstalment = Math.max(0, ndiCents * 0.35 - 69_00)
  const maxPrincipal = maxInstalment / (1 / months + 0.03)
  const amountCents = Math.min(100_000_00, Math.max(5_000_00, roundRand(maxPrincipal * (0.5 + rng.next() * 0.4), 500)))
  return { productCode: 'PERSONAL', amountCents, termDays: months * 30 }
}

export function buildPersona(spec: PersonaSpec, lender: DemoLender = demoLender()): Persona {
  const rng = createRng(`credaflow-demo-persona:${spec.id}`)
  const f = spec.fixed ?? {}

  const gender = f.gender ?? (rng.chance(0.55) ? 'FEMALE' : 'MALE')
  // Names come from their own stream so a collision can be redrawn without
  // disturbing any other value of the persona.
  const nameRng = createRng(`credaflow-demo-persona:${spec.id}:name:${spec.nameSalt ?? 0}`)
  const firstName = f.firstName ?? nameRng.pick(gender === 'FEMALE' ? FEMALE_FIRST_NAMES : MALE_FIRST_NAMES)
  const lastName = f.lastName ?? nameRng.pick(SURNAMES)
  const dateOfBirth = f.dateOfBirth ?? `${rng.int(1968, 2001)}-${pad(rng.int(1, 12), 2)}-${pad(rng.int(1, 28), 2)}`
  const idNumber = buildSaIdNumber({ dateOfBirth, gender, index: spec.index })

  const town = f.city ? TOWNS.find((t) => t.city === f.city) : rng.pick(TOWNS)
  if (!town) throw new Error(`unknown town ${f.city}`)
  const employer = f.employerName ? EMPLOYERS.find((e) => e.name === f.employerName) : rng.pick(EMPLOYERS)
  if (!employer) throw new Error(`unknown employer ${f.employerName}`)

  const grossRands = f.grossRands ?? Math.round(rng.int(employer.grossBand[0], employer.grossBand[1]) / 50) * 50
  const allowanceRands = f.allowanceRands ?? (rng.chance(0.4) ? Math.round((grossRands * 0.1) / 50) * 50 : 0)
  const payroll = buildPayroll({
    basicCents: (grossRands - allowanceRands) * 100,
    allowanceCents: allowanceRands * 100,
    hasPension: f.hasPension ?? rng.chance(0.5),
    medicalAidCents: (f.medicalAidRands ?? (rng.chance(0.4) ? rng.int(12, 28) * 100 : 0)) * 100,
    taxReference: `0${digits(rng, 9)}`,
  })

  const bankCode = f.bankCode ?? rng.pick(BANKS).code
  const bank = bankDef(bankCode)
  const accountNumber = `${bank.accountPrefix}${pad(spec.index, 3)}${digits(rng, bank.accountLength - 6)}`

  const debtSpecs = f.debts ?? randomDebts(rng, spec.profile, payroll.netCents)
  const debts: DebtObligation[] = debtSpecs.map((d, i) => {
    const providers = CREDITORS[d.accountType]
    const instalment = d.instalmentRands * 100
    return {
      creditProvider: providers[i % providers.length]!,
      accountType: d.accountType,
      monthlyInstalmentCents: instalment,
      outstandingBalanceCents: instalment * d.months,
      debitDay: rng.int(1, 7),
    }
  })

  const mle = minimumLivingExpense(payroll.grossCents)
  const expenseTarget = f.expensesRands !== undefined
    ? f.expensesRands * 100
    : Math.max(mle * 1.15, payroll.netCents * (spec.profile === 'affordable' ? 0.36 + rng.next() * 0.1 : 0.3))
  const expenses = splitExpenses(expenseTarget)
  const ndi = payroll.netCents - expenseTotalCents(expenses) - debtTotalCents(debts)

  const salaryPaymentDay = f.salaryPaymentDay ?? rng.pick([25, 25, 25, 20, 15, 26] as const)
  const startYear = rng.int(2012, 2023)
  const emailLocal = `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z.]/g, '')
  const nokGender = rng.chance(0.5)

  return {
    id: spec.id,
    index: spec.index,
    kind: spec.kind,
    storyline: spec.storyline,
    summary: spec.summary,
    firstName,
    lastName,
    idNumber,
    dateOfBirth,
    gender,
    email: `${emailLocal}@${lender.clientDomain}`,
    phone: `+2760000${pad(spec.index, 4)}`,
    address: {
      addressLine1: `${rng.int(2, 199)} ${rng.pick(STREETS)}`,
      suburb: rng.pick(town.suburbs),
      city: town.city,
      province: town.province,
      postalCode: town.postalCode,
    },
    employment: {
      employmentStatus: 'EMPLOYED',
      incomeSourceType: 'SALARY',
      employerName: employer.name,
      employerAddress: `${employer.street}, ${town.city}, ${town.postalCode}`,
      occupation: f.occupation ?? rng.pick(employer.occupations),
      employeeNumber: `E${digits(rng, 5)}`,
      employmentStartDate: `${startYear}-${pad(rng.int(1, 12), 2)}-01`,
      salaryPaymentDay,
    },
    payroll,
    bank: {
      bankCode,
      branchCode: bank.universalBranchCode,
      accountNumber,
      accountType: f.accountType ?? (rng.chance(0.85) ? 'CHEQUE' : 'SAVINGS'),
    },
    expenses,
    debts,
    loanRequest: f.loanRequest ?? defaultLoanRequest(rng, ndi, spec.profile),
    nextOfKin: {
      name: `${rng.pick(nokGender ? FEMALE_FIRST_NAMES : MALE_FIRST_NAMES)} ${lastName}`,
      phone: `+2760001${pad(spec.index, 4)}`,
      relationship: rng.pick(['Spouse', 'Parent', 'Sibling'] as const),
    },
  }
}
