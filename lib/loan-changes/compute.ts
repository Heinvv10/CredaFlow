/**
 * What a proposal would do to the loans as they stand: read, refuse, plan. The preview, the checks on submit and approval and
 * the apply (under the loan locks) all run this, so the checker's screen and the money come from one calculation.
 */
import type { Prisma } from "@prisma/client"
import { recomputeLoanBalances } from "@/lib/loan/balances"
import { loanSettlementFigures } from "@/lib/loan/charges-summary"
import { readBorrowerScreening } from "@/lib/screening/gate"
import { PERIOD_DAYS, type EngineInterestModel, type Frequency, type RepaymentStructure } from "@/lib/product-engine/types"
import type { Tx } from "@/lib/maker-checker/types"
import { changeRefusal, type ChangeScope, type LoanChangeFacts } from "./eligibility"
import { LoanChangeRefused, planInPlace, planNewLoan, type InPlacePlan, type NewLoanPlan, type PlanRow } from "./plan"
import { isNewLoanType, type LoanChangePayload } from "./types"

const LOAN_INCLUDE = {
  application: { select: { disclosureRegime: true, repaymentMethod: true, branchId: true, purpose: true } },
  assetFinanceDeal: { select: { id: true } },
  client: { select: { id: true, deceasedAt: true, bankName: true, bankAccountNumber: true, bankBranchCode: true, accountType: true } },
  product: { select: { maxAmount: true, maxTermDays: true } },
  paymentArrangement: { select: { status: true } },
  paymentPlan: { select: { active: true } },
  repaymentSchedule: { orderBy: [{ dueDate: "asc" }, { installmentNo: "asc" }] },
  terms: { orderBy: { sequence: "desc" }, take: 1, select: { sequence: true, productVersionId: true, frequency: true, structure: true } },
  _count: { select: { debitMandates: { where: { status: { in: ["CREATED", "SUBMITTING", "PENDING_REGISTRATION", "PENDING_AUTH", "ACTIVE", "SUSPENDED"] } } }, collectionInstructions: true } },
} satisfies Prisma.LoanInclude

export type ChangeLoan = Prisma.LoanGetPayload<{ include: typeof LOAN_INCLUDE }>

type Reader = Pick<Tx, "loan" | "clientDocument" | "payment" | "loanCharge" | "repaymentSchedule" | "tenantConfig" | "auditLog" | "$queryRaw">

export async function loadChangeLoan(db: Pick<Tx, "loan">, tenantId: string, loanId: string): Promise<ChangeLoan | null> {
  return db.loan.findFirst({ where: { id: loanId, tenantId }, include: LOAN_INCLUDE })
}

export function factsOf(loan: ChangeLoan): LoanChangeFacts {
  const rows = loan.repaymentSchedule
  return {
    status: loan.status, disclosureRegime: loan.application.disclosureRegime, contractType: loan.contractType, assetFinance: loan.assetId !== null || loan.assetFinanceDeal !== null,
    hasClient: loan.client !== null, deceased: loan.client?.deceasedAt != null, interestModel: loan.interestModel, creditLifePremiums: loan.creditLifePremiums,
    repaymentMethod: loan.application.repaymentMethod, debtReview: loan.debtReviewNoticeAt !== null, collectionsStage: loan.collectionsStage,
    arrangementActive: loan.paymentArrangement?.status === "ACTIVE", paymentPlanActive: loan.paymentPlan?.active === true,
    mandates: loan._count.debitMandates, collectionInstructions: loan._count.collectionInstructions,
    chargesAccrued: loan.chargesAccrued, chargesOutstanding: loan.chargesOutstanding,
    scheduleTies: rows.reduce((sum, r) => sum + r.principalDue, 0) === loan.principal && rows.reduce((sum, r) => sum + r.totalPaid, 0) === loan.totalPaid,
  }
}

const engineModel = (loan: ChangeLoan) => loan.interestModel as EngineInterestModel
const frequencyOf = (loan: ChangeLoan): Frequency => loan.terms[0]?.frequency ?? "MONTHLY"
const structureOf = (loan: ChangeLoan): RepaymentStructure => loan.terms[0]?.structure ?? "AMORTISING"

/** The loan has an instalment past due as at `asOf`, whatever the nightly job last wrote. */
export function inArrears(loan: ChangeLoan, asOf: Date): boolean {
  return loan.status === "DEFAULTED" || recomputeLoanBalances(loan.principal, loan.repaymentSchedule, asOf).daysInArrears > 0
}

function refuseIneligible(loan: ChangeLoan, scope: ChangeScope): void {
  const refusal = changeRefusal(factsOf(loan), scope)
  if (refusal) throw new LoanChangeRefused(`${loan.reference}: ${refusal}`)
}

async function refuseUnsignedDocument(db: Pick<Tx, "clientDocument">, tenantId: string, clientId: string, documentId: string): Promise<void> {
  const document = await db.clientDocument.findFirst({ where: { id: documentId, tenantId, clientId, deletedAt: null }, select: { id: true } })
  if (!document) throw new LoanChangeRefused("The signed document is not one of this borrower's documents")
}

export interface InPlaceComputed {
  scope: "IN_PLACE"
  loan: ChangeLoan
  plan: InPlacePlan
}

export interface SettledLoan {
  loan: ChangeLoan
  settlementCents: number
}

export interface NewLoanComputed {
  scope: "NEW_LOAN"
  primary: ChangeLoan
  settled: SettledLoan[]
  settledCents: number
  newMoneyCents: number
  interestRatePm: number
  plan: NewLoanPlan
}

export type Computed = InPlaceComputed | NewLoanComputed

export const involvedLoanIds = (payload: LoanChangePayload): string[] =>
  [payload.loanId, ...(payload.type === "CONSOLIDATION" ? payload.otherLoanIds : [])]

async function computeNewLoan(db: Reader, tenantId: string, primary: ChangeLoan, payload: LoanChangePayload & { instalments: number; interestRatePm?: number }, asOf: Date): Promise<NewLoanComputed> {
  const others = payload.type === "CONSOLIDATION" ? await Promise.all(payload.otherLoanIds.map((id) => loadChangeLoan(db, tenantId, id))) : []
  const loans = [primary, ...others].map((loan) => {
    if (!loan) throw new LoanChangeRefused("A loan to consolidate does not exist")
    refuseIneligible(loan, "NEW_LOAN")
    if (loan.clientId !== primary.clientId) throw new LoanChangeRefused("Only loans of one borrower can be consolidated")
    return loan
  })
  const screening = await readBorrowerScreening(tenantId, { clientId: primary.clientId, entityId: null })
  if (!screening.allowed) throw new LoanChangeRefused(screening.message)

  const settled: SettledLoan[] = []
  for (const loan of loans) {
    // What the loan page, the certificate and the receipt path say settles it: lib/loan/settlement.ts, default charges included.
    const figures = await loanSettlementFigures(db as never, { ...loan, repaymentSchedule: loan.repaymentSchedule }, asOf)
    if (figures.totalToSettle <= 0) throw new LoanChangeRefused(`${loan.reference}: nothing is owed on this loan`)
    settled.push({ loan, settlementCents: figures.totalToSettle })
  }
  const settledCents = settled.reduce((sum, s) => sum + s.settlementCents, 0)
  const newMoneyCents = payload.type === "TOP_UP" ? payload.newMoneyCents : 0
  const interestRatePm = payload.interestRatePm ?? primary.interestRatePm
  const plan = planNewLoan({
    settledCents, newMoneyCents, interestRatePm, interestModel: engineModel(primary), monthlyServiceFee: primary.monthlyServiceFee ?? 0,
    frequency: frequencyOf(primary), instalments: payload.instalments, asOf,
  })
  if (plan.principal > primary.product.maxAmount) throw new LoanChangeRefused("The new loan would be above the product's maximum amount")
  if (payload.instalments * PERIOD_DAYS[frequencyOf(primary)] > primary.product.maxTermDays) throw new LoanChangeRefused("The new loan would be longer than the product's maximum term")
  return { scope: "NEW_LOAN", primary, settled, settledCents, newMoneyCents, interestRatePm, plan }
}

export async function computeChange(db: Reader, tenantId: string, payload: LoanChangePayload, asOf: Date): Promise<Computed> {
  const loan = await loadChangeLoan(db, tenantId, payload.loanId)
  if (!loan) throw new LoanChangeRefused("That loan does not exist")
  refuseIneligible(loan, isNewLoanType(payload.type) ? "NEW_LOAN" : "IN_PLACE")
  await refuseUnsignedDocument(db, tenantId, loan.clientId!, payload.signedDocumentId)
  if (payload.type === "TOP_UP" || payload.type === "REFINANCE" || payload.type === "CONSOLIDATION") return computeNewLoan(db, tenantId, loan, payload, asOf)
  const rows: PlanRow[] = loan.repaymentSchedule
  const plan = planInPlace({
    loan: { principal: loan.principal, interestRatePm: loan.interestRatePm, interestModel: engineModel(loan), monthlyServiceFee: loan.monthlyServiceFee ?? 0, startDate: loan.startDate },
    rows, frequency: frequencyOf(loan), structure: structureOf(loan), change: payload, asOf,
  })
  return { scope: "IN_PLACE", loan, plan }
}
