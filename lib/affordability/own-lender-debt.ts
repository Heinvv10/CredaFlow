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
// Each open loan of the client that still owes money is appended to BOTH
// declared lists (application and client record), so `max(application,
// client)` counts it whichever list is larger. A list may already declare it —
// by its loan id or reference as the debt's sourceId, or by a debt whose
// provider IS this lender's trading or legal name (exact, normalised). A
// declaration never lowers what is counted: the loan and the debts declaring it
// together count max(declared, the lender's own instalment). Only the lender
// writes `own-loan:` sourceIds; one supplied in a declaration is stripped.

export const OWN_LOAN_SOURCE_PREFIX = "own-loan:"
export const OWN_LOAN_DEBT_TYPE = "LOAN_WITH_THIS_LENDER"
/** Every LoanStatus that is not closed (COMPLETED, WRITTEN_OFF, CANCELLED). */
export const OWN_LOAN_STATUSES = ["ACTIVE", "DEFAULTED", "PENDING_WRITE_OFF", "RESTRUCTURED"] as const

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
  /** this lender's trading and legal names, for recognising a declared debt */
  lenderNames: string[]
  loans: OwnLenderLoan[]
}

const norm = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")

/** A sourceId only the lender may write. */
export function isOwnLoanSourceId(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase().startsWith(OWN_LOAN_SOURCE_PREFIX)
}

function declaresLoan(debt: AffordabilityDebtInput, loan: OwnLenderLoan): boolean {
  const ref = norm(debt.sourceId ?? debt.id)
  return ref !== "" && (ref === norm(loan.id) || ref === norm(loan.reference))
}

function namesLender(debt: AffordabilityDebtInput, lenderNames: string[]): boolean {
  const provider = norm(debt.provider ?? debt.creditor ?? debt.creditProvider)
  return provider !== "" && lenderNames.some((name) => norm(name) === provider)
}

function instalmentOf(debt: AffordabilityDebtInput): number {
  const value = Number(debt.monthlyInstalmentCents ?? debt.monthlyInstalment ?? 0)
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

/**
 * `debts` plus, per own loan, the part of its instalment the list's
 * declarations do not already count. Pure: the same list and loans give the
 * same entries, so a fingerprint over them is reproducible.
 */
export function withOwnLenderDebts(
  debts: readonly AffordabilityDebtInput[] | null | undefined,
  own: OwnLenderDebts,
): AffordabilityDebtInput[] {
  const list = (debts ?? []).map((debt) => (isOwnLoanSourceId(debt.sourceId) ? { ...debt, sourceId: null } : debt))
  // Declarations of this lender by name, not tied to one loan: credited across
  // the own loans, oldest first.
  let declaredToLender = list
    .filter((debt) => namesLender(debt, own.lenderNames) && !own.loans.some((loan) => declaresLoan(debt, loan)))
    .reduce((sum, debt) => sum + instalmentOf(debt), 0)
  const lender = own.lenderNames[0] ?? "This lender"
  for (const loan of own.loans) {
    const byReference = list
      .filter((debt) => declaresLoan(debt, loan))
      .reduce((sum, debt) => sum + instalmentOf(debt), 0)
    const byName = Math.min(declaredToLender, Math.max(0, loan.instalmentCents - byReference))
    declaredToLender -= byName
    const instalment = loan.instalmentCents - byReference - byName
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

// Open, and still owing: principal outstanding, or instalments overdue.
const OWES_MONEY = {
  status: { in: [...OWN_LOAN_STATUSES] },
  OR: [{ outstandingPrincipal: { gt: 0 } }, { arrearsAmount: { gt: 0 } }],
}

const OWN_LOAN_SELECT = {
  id: true, clientId: true, reference: true, status: true, outstandingPrincipal: true, daysInArrears: true, arrearsAmount: true,
  repaymentSchedule: { orderBy: { installmentNo: "asc" as const }, select: { totalDue: true } },
}

async function lenderNamesOf(db: OwnLoanDb, tenantId: string): Promise<string[]> {
  const [tenant, config] = await Promise.all([
    db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    db.tenantConfig.findUnique({ where: { tenantId }, select: { brandName: true, legalName: true } }),
  ])
  const names = [config?.brandName, config?.legalName]
    .filter((name): name is string => typeof name === "string" && name.trim() !== "")
  // A lender with no configured identity is known by its tenant name only.
  return names.length > 0 ? names : [tenant?.name].filter((name): name is string => !!name?.trim())
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
        ...OWES_MONEY,
        tenantId, clientId,
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
      where: { ...OWES_MONEY, tenantId, clientId: { not: null } },
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
