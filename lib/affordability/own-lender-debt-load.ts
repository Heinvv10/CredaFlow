import type { prisma } from "@/lib/prisma"
import { recurringInstalmentDue } from "@/lib/loan/instalment"
import {
  createSubmissionAffordabilitySnapshot,
  readAffordabilityDebtInputs,
  readAffordabilitySnapshotStore,
  type AffordabilityDebtInput,
} from "@/lib/affordability/snapshot"
import {
  OWN_LOAN_STATUSES,
  ownLenderDebtEntries,
  withOwnLenderDebts,
  type OwnLenderDebts,
  type OwnLenderLoan,
} from "@/lib/affordability/own-lender-debt"

// Loading the client's obligations to this lender (lib/affordability/own-lender-debt.ts):
// open loans that still owe money, and applications APPROVED but not yet paid
// out (each is a loan about to exist; two approved at once must count each
// other). Structural db types, so both the extended client and its
// transaction client fit.

type OwnLoanDb = Pick<typeof prisma, "loan" | "loanApplication" | "tenant" | "tenantConfig">

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
    id: loan.id, reference: loan.reference, status: loan.status,
    instalmentCents: recurringInstalmentDue(loan.repaymentSchedule),
    outstandingPrincipal: loan.outstandingPrincipal, daysInArrears: loan.daysInArrears, arrearsAmount: loan.arrearsAmount,
  }
}

/** An APPROVED, not yet disbursed application: its approved instalment, credit life included. */
function toApprovedApplication(app: { id: string; reference: string; approvedAmount: number | null; affordabilityResult: unknown }): OwnLenderLoan | null {
  const instalment = readAffordabilitySnapshotStore(app.affordabilityResult).approval?.inputs.proposedInstalmentCents
  if (!Number.isSafeInteger(instalment)) return null
  return {
    id: `application:${app.id}`, reference: app.reference, status: "APPROVED",
    instalmentCents: instalment as number, outstandingPrincipal: app.approvedAmount ?? 0, daysInArrears: 0, arrearsAmount: 0,
  }
}

/**
 * The client's obligations to this tenant, and the names it lends under.
 * `excludeApplicationId`: the application being assessed, and the loan booked
 * from it, are not obligations it is assessed against.
 */
export async function loadOwnLenderDebts(
  db: OwnLoanDb,
  tenantId: string,
  clientId: string,
  excludeApplicationId?: string,
): Promise<OwnLenderDebts> {
  const exclude = excludeApplicationId ? { not: excludeApplicationId } : undefined
  const [loans, approved, lenderNames] = await Promise.all([
    db.loan.findMany({
      where: { ...OWES_MONEY, tenantId, clientId, ...(exclude ? { applicationId: exclude } : {}) },
      orderBy: { startDate: "asc" },
      select: OWN_LOAN_SELECT,
    }),
    db.loanApplication.findMany({
      where: { tenantId, clientId, status: "APPROVED", loan: null, ...(exclude ? { id: exclude } : {}) },
      orderBy: { approvedAt: "asc" },
      select: { id: true, reference: true, approvedAmount: true, affordabilityResult: true },
    }),
    lenderNamesOf(db, tenantId),
  ])
  return {
    lenderNames,
    loans: [...loans.map(toOwnLoan), ...approved.map(toApprovedApplication).filter((loan): loan is OwnLenderLoan => loan !== null)],
  }
}

type DebtSource = {
  existingDebtObligations: unknown
  client: { id: string; debtObligations: readonly AffordabilityDebtInput[] }
}

/**
 * The application's and the client's declared debts, each with the client's
 * live obligations to this lender added (assessment, approval, the locked
 * approval re-check). Throws InvalidAffordabilityDebtError as reading the
 * declaration does.
 */
export async function liveOwnAwareDebtInputs(db: OwnLoanDb, tenantId: string, applicationId: string, source: DebtSource) {
  const own = await loadOwnLenderDebts(db, tenantId, source.client.id, applicationId)
  return {
    application: withOwnLenderDebts(readAffordabilityDebtInputs(source.existingDebtObligations), own),
    client: withOwnLenderDebts(source.client.debtObligations, own),
  }
}

/**
 * The same lists for re-checking an approval on its own evidence: the declared
 * debts live, the obligations to this lender as the approval recorded them.
 */
export function recordedOwnAwareDebtInputs(source: DebtSource & { affordabilityResult: unknown }) {
  const recorded = readAffordabilitySnapshotStore(source.affordabilityResult).approval?.debts
  return {
    application: [...readAffordabilityDebtInputs(source.existingDebtObligations), ...ownLenderDebtEntries(recorded?.application ?? [])],
    client: [...source.client.debtObligations, ...ownLenderDebtEntries(recorded?.client ?? [])],
  }
}

const ownTotal = (debts: readonly AffordabilityDebtInput[]) => ownLenderDebtEntries(debts.map((debt) => ({ ...debt, sourceId: debt.sourceId ?? null })))
  .reduce((sum, debt) => sum + Number(debt.monthlyInstalmentCents ?? debt.monthlyInstalment ?? 0), 0)

/**
 * At payout: true when the client's live obligations to this lender count more
 * than the approval recorded (another loan paid out, or approved, since) —
 * the approval no longer describes the client, so the payout fails closed.
 */
export async function ownLenderDebtIncreasedSinceApproval(
  db: OwnLoanDb,
  tenantId: string,
  applicationId: string,
  source: DebtSource & { affordabilityResult: unknown },
): Promise<boolean> {
  const live = await liveOwnAwareDebtInputs(db, tenantId, applicationId, source)
  const recorded = recordedOwnAwareDebtInputs(source)
  return Math.max(ownTotal(live.application), ownTotal(live.client)) > Math.max(ownTotal(recorded.application), ownTotal(recorded.client))
}

/**
 * createSubmissionAffordabilitySnapshot with the client's obligations to this
 * lender added to both declared lists, so the NDI an application is submitted
 * on counts them as the approval will.
 */
export async function ownAwareSubmissionSnapshot(
  db: OwnLoanDb,
  tenantId: string,
  clientId: string,
  args: Parameters<typeof createSubmissionAffordabilitySnapshot>[0],
  applicationId?: string,
) {
  const own = await loadOwnLenderDebts(db, tenantId, clientId, applicationId)
  return createSubmissionAffordabilitySnapshot({
    ...args,
    applicationDebts: withOwnLenderDebts(args.applicationDebts, own),
    clientDebts: withOwnLenderDebts(args.clientDebts, own),
  })
}

/** Declared monthly instalments plus the obligations to this lender they do not declare. */
export const ownAwareDebtTotal = (debts: readonly AffordabilityDebtInput[], own: OwnLenderDebts) =>
  withOwnLenderDebts(debts, own).reduce((sum, debt) => sum + Number(debt.monthlyInstalmentCents ?? debt.monthlyInstalment ?? 0), 0)

export { withOwnLenderDebts }
