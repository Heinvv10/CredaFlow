import type { prisma } from "@/lib/prisma"
import { recurringInstalmentDue } from "@/lib/loan/instalment"
import type { AffordabilityDebtInput } from "@/lib/affordability/snapshot"

// The client's own loans with THIS lender, in the affordability assessment.
//
// Affordability counted only what the consumer declared (and what a bureau
// reported). A lender's own active loan is not on the bureau until the lender
// reports it, and consumers do not declare a loan from the lender they are
// applying to: the Fair Score audit (2026-10-16) found Elize's R2,541 a month
// instalment, 27 days in arrears, missing from her existing obligations — the
// assessment showed R870. NCA s81(2)(a)(ii) requires the consumer's existing
// obligations to be assessed, and the lender cannot claim not to know its own.
//
// Each ACTIVE / DEFAULTED loan of the client is appended to BOTH declared
// lists (application and client record), so `max(application, client)` counts
// it whichever list is larger, unless that list already declares it: by its
// loan id or reference as the debt's sourceId, or by a debt whose provider is
// this lender, whose instalments are credited against the own loans first.

export const OWN_LOAN_SOURCE_PREFIX = "own-loan:"
export const OWN_LOAN_DEBT_TYPE = "LOAN_WITH_THIS_LENDER"
export const OWN_LOAN_STATUSES = ["ACTIVE", "DEFAULTED"] as const

export interface OwnLenderLoan {
  id: string
  reference: string
  status: string
  /** recurring instalment (lib/loan/instalment.ts), cents */
  instalmentCents: number
  outstandingPrincipal: number
  daysInArrears: number
  arrearsAmount: number
}

export interface OwnLenderDebts {
  /** names this lender trades under, for recognising a declared debt */
  lenderNames: string[]
  loans: OwnLenderLoan[]
}

const norm = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")

function declaresLoan(debt: AffordabilityDebtInput, loan: OwnLenderLoan): boolean {
  const ref = norm(debt.sourceId ?? debt.id)
  return ref !== "" && [loan.id, loan.reference, `${OWN_LOAN_SOURCE_PREFIX}${loan.id}`].some((v) => norm(v) === ref)
}

function namesLender(debt: AffordabilityDebtInput, lenderNames: string[]): boolean {
  const provider = norm(debt.provider ?? debt.creditor ?? debt.creditProvider)
  if (provider.length < 3) return false
  return lenderNames.some((name) => {
    const lender = norm(name)
    return lender.length >= 3 && (provider.includes(lender) || lender.includes(provider))
  })
}

function instalmentOf(debt: AffordabilityDebtInput): number {
  const value = Number(debt.monthlyInstalmentCents ?? debt.monthlyInstalment ?? 0)
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

/**
 * `debts` plus one entry per own loan the list does not already declare. Pure:
 * the same list and loans give the same entries, so a fingerprint over them is
 * reproducible.
 */
export function withOwnLenderDebts(
  debts: readonly AffordabilityDebtInput[] | null | undefined,
  own: OwnLenderDebts,
): AffordabilityDebtInput[] {
  const list = [...(debts ?? [])]
  const undeclared = own.loans.filter((loan) => !list.some((debt) => declaresLoan(debt, loan)))
  // A debt the client declared against this lender's name covers own loans
  // first, so a declared "Fair Score R2,541" is not counted twice.
  let declaredToLender = list
    .filter((debt) => namesLender(debt, own.lenderNames) && !own.loans.some((loan) => declaresLoan(debt, loan)))
    .reduce((sum, debt) => sum + instalmentOf(debt), 0)
  const lender = own.lenderNames[0] ?? "This lender"
  for (const loan of undeclared) {
    const covered = Math.min(declaredToLender, loan.instalmentCents)
    declaredToLender -= covered
    const instalment = loan.instalmentCents - covered
    if (instalment <= 0) continue
    list.push({
      sourceId: `${OWN_LOAN_SOURCE_PREFIX}${loan.id}`,
      provider: lender,
      type: OWN_LOAN_DEBT_TYPE,
      balanceCents: loan.outstandingPrincipal,
      monthlyInstalmentCents: instalment,
      notes: `${loan.reference} with this lender, counted automatically`,
    })
  }
  return list
}

/** The own-loan entries a stored snapshot list carries (to re-check it later on the same evidence). */
export function ownLenderDebtEntries<T extends { sourceId: string | null }>(debts: readonly T[]): T[] {
  return debts.filter((debt) => debt.sourceId?.startsWith(OWN_LOAN_SOURCE_PREFIX))
}

// Structural, so both the extended client and its transaction client fit.
type OwnLoanDb = Pick<typeof prisma, "loan" | "tenant" | "tenantConfig">

const OWN_LOAN_SELECT = {
  id: true, clientId: true, reference: true, status: true, outstandingPrincipal: true, daysInArrears: true, arrearsAmount: true,
  repaymentSchedule: { orderBy: { installmentNo: "asc" as const }, select: { totalDue: true } },
}

async function lenderNamesOf(db: OwnLoanDb, tenantId: string): Promise<string[]> {
  const [tenant, config] = await Promise.all([
    db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    db.tenantConfig.findUnique({ where: { tenantId }, select: { brandName: true, legalName: true } }),
  ])
  return [config?.brandName, tenant?.name, config?.legalName]
    .filter((name): name is string => typeof name === "string" && name.trim() !== "")
}

function toOwnLoan(loan: {
  id: string; reference: string; status: string; outstandingPrincipal: number; daysInArrears: number; arrearsAmount: number
  repaymentSchedule: { totalDue: number }[]
}): OwnLenderLoan {
  return {
    id: loan.id,
    reference: loan.reference,
    status: loan.status,
    instalmentCents: recurringInstalmentDue(loan.repaymentSchedule),
    outstandingPrincipal: loan.outstandingPrincipal,
    daysInArrears: loan.daysInArrears,
    arrearsAmount: loan.arrearsAmount,
  }
}

/**
 * The client's ACTIVE / DEFAULTED loans with this tenant, and the names it
 * lends under. `excludeApplicationId`: the loan booked from the application
 * being viewed is not an obligation it was assessed against.
 */
export async function loadOwnLenderDebts(
  db: OwnLoanDb,
  tenantId: string,
  clientId: string,
  excludeApplicationId?: string,
): Promise<OwnLenderDebts> {
  const [loans, lenderNames] = await Promise.all([
    db.loan.findMany({
      where: {
        tenantId, clientId, status: { in: [...OWN_LOAN_STATUSES] },
        ...(excludeApplicationId ? { applicationId: { not: excludeApplicationId } } : {}),
      },
      orderBy: { startDate: "asc" },
      select: OWN_LOAN_SELECT,
    }),
    lenderNamesOf(db, tenantId),
  ])
  return { lenderNames, loans: loans.map(toOwnLoan) }
}

/** loadOwnLenderDebts for every client of the tenant at once (the new-application client picker). */
export async function loadOwnLenderDebtsByClient(db: OwnLoanDb, tenantId: string): Promise<Map<string, OwnLenderDebts>> {
  const [loans, lenderNames] = await Promise.all([
    db.loan.findMany({
      where: { tenantId, clientId: { not: null }, status: { in: [...OWN_LOAN_STATUSES] } },
      orderBy: { startDate: "asc" },
      select: OWN_LOAN_SELECT,
    }),
    lenderNamesOf(db, tenantId),
  ])
  const byClient = new Map<string, OwnLenderDebts>()
  for (const loan of loans) {
    if (!loan.clientId) continue
    const own = byClient.get(loan.clientId) ?? { lenderNames, loans: [] }
    own.loans.push(toOwnLoan(loan))
    byClient.set(loan.clientId, own)
  }
  return byClient
}

/** "In arrears with us" across the client's own loans: the worst DPD and the total overdue. */
export function ownLenderArrears(own: OwnLenderDebts): { days: number; amountCents: number } | null {
  const late = own.loans.filter((loan) => loan.daysInArrears > 0 && loan.arrearsAmount > 0)
  if (late.length === 0) return null
  return {
    days: Math.max(...late.map((loan) => loan.daysInArrears)),
    amountCents: late.reduce((sum, loan) => sum + loan.arrearsAmount, 0),
  }
}
