import { isNcaJurisdiction } from "@/lib/jurisdiction/active"
import { createHash } from "node:crypto"
import { isSimulatedBureauCheck } from "@/lib/decision/bureau-simulated"
import { assessAffordability } from "@/lib/affordability/ndi"
import { calculateLoan, type LoanCalcResult } from "@/lib/loan-calculator"
import { minimumLivingExpense, MLE_FORMULA_VERSION } from "@/lib/affordability/mle"
import {
  calculateCreditLifePremiumPeriodsForSchedule,
  creditLifePremiumPaymentLoadCents,
} from "@/lib/insurance/credit-life-billing"
import {
  quotationIsBindingThroughDate,
  quotationIsBindingAt,
  quotationValidUntilDate,
  southAfricanCalendarDate,
} from "@/lib/compliance/sa-business-days"

export const AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION = 3 as const
export const SUBMISSION_AFFORDABILITY_POLICY_VERSION = "submission-ndi-v3" as const
export const ASSESSMENT_AFFORDABILITY_POLICY_VERSION = "assessment-ndi-v3" as const
export const APPROVAL_AFFORDABILITY_POLICY_VERSION = "approval-ndi-v3" as const
export const AFFORDABILITY_CALCULATOR_VERSION = "loan-calculator-v3" as const
export const LEGACY_AFFORDABILITY_CONTRACT_VERSION =
  "affordability-contract-v1" as const
export const AFFORDABILITY_CONTRACT_VERSION = "affordability-contract-v2" as const

const EXPENSE_KEYS = [
  "housing",
  "transport",
  "food",
  "education",
  "insurance",
  "clothing",
  "entertainment",
  "medical",
  "other",
] as const

type ExpenseKey = (typeof EXPENSE_KEYS)[number]

export interface AffordabilityExpenseInput {
  grossMonthlyIncome?: number | null
  monthlyIncome: number
  monthlyExpenses: number
  expenseBreakdown?: ({
    id?: string | null
    updatedAt?: Date | string | null
    belowMleJustification?: string | null
  } & Partial<Record<ExpenseKey, number | null>>) | null
}

export interface AffordabilityExpenseEvidence {
  source: "CLIENT_BREAKDOWN" | "DECLARED_TOTAL"
  sourceId: string | null
  sourceUpdatedAt: string | null
  grossMonthlyIncomeCents: number | null
  monthlyIncomeCents: number
  statedMonthlyExpensesCents: number
  breakdown: Record<ExpenseKey, number>
  breakdownTotalCents: number
  mle: {
    formulaVersion: typeof MLE_FORMULA_VERSION
    basisIncomeCents: number
    minimumExpenseCents: number
    belowMinimum: boolean
    justification: string | null
  }
  fingerprint: string
}

export interface AffordabilityDebtEvidence {
  sourceId: string | null
  provider: string
  type: string
  balanceCents: number
  monthlyInstalmentCents: number
  notes: string | null
}

export interface AffordabilityDebtInput {
  id?: string | null
  sourceId?: string | null
  provider?: string | null
  creditor?: string | null
  creditProvider?: string | null
  type?: string | null
  accountType?: string | null
  balance?: number | null
  balanceCents?: number | null
  outstandingBalance?: number | null
  monthlyInstalment?: number | null
  monthlyInstalmentCents?: number | null
  notes?: string | null
}

export interface BureauDecisionCheckEvidence {
  id: string
  clientId: string
  subjectFingerprint: string
  provider: string
  createdAt: string
  score: number | null
  riskGrade: string | null
  unscoreable: boolean
  hasAdverse: boolean
  deceased: boolean
  underDebtReview: boolean
  hasJudgement: boolean
  hasNotice: boolean
  obligationsCents: number
  /** Present only when the stored check was a simulated provider response. */
  simulated?: true
}

export interface BureauDecisionEvidence {
  mode: "CHECK" | "OVERRIDE"
  check: BureauDecisionCheckEvidence | null
  policy: {
    minimumScore: number
    blockAdverse: boolean
  }
  override: {
    reason: string
    reasonSha256: string
    byId: string
    at: string
  } | null
}

export interface BureauDecisionCheckInput {
  id: string
  clientId: string
  subjectFingerprint?: string | null
  provider: string
  createdAt: Date | string
  score?: number | null
  riskGrade?: string | null
  unscoreable?: boolean | null
  hasAdverse?: boolean | null
  deceased?: boolean | null
  underDebtReview?: boolean | null
  hasJudgement?: boolean | null
  hasNotice?: boolean | null
  obligations?: unknown
}

export interface AffordabilityDecisionInputs {
  monthlyIncomeCents: number
  monthlyExpensesCents: number
  applicationDebtCents: number
  clientDebtCents: number
  declaredDebtCents: number
  bureauObligationsCents: number
  proposedInstalmentCents: number
  /** Accepted monthly credit-life premium collected with the instalment.
   * Optional only so pre-PASQ-v3 historical snapshots remain verifiable. */
  creditLifePremiumCents?: number
  principalCents: number
  termDays: number
  productId: string
  interestRatePm: number
  interestModel: "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL"
  /** How the fee was PRICED at capture time. Optional so snapshots taken before
   *  this field existed still parse; absent means FLAT_PCT, which is what every
   *  product was priced on then — so historical recomputation is unchanged. */
  initiationFeeModel?: "FLAT_PCT" | "NCA_REG42"
  initiationFeePct: number
  initiationFeeMaxCents: number
  monthlyServiceFeeCents: number
  /** Product category at approval time — decides the NCA fee-cap regime.
   *  Optional so snapshots taken before this field existed still parse; absent
   *  is treated as consumer credit, which is the capped (safe) default. */
  productType?: string | null
  initiationFeePayment: "DEFERRED" | "UPFRONT"
  ndiBufferPct: number
}

export interface AffordabilityDecisionOutcome {
  netDisposableIncomeCents: number
  ndiAfterLoanCents: number
  requiredNdiCents: number
  isAffordable: boolean
  reason: string | null
}

export interface AffordabilityCalculatorEvidence {
  version: typeof AFFORDABILITY_CALCULATOR_VERSION
  startDate: string
  principalCents: number
  totalInterestCents: number
  initiationFeeCents: number
  serviceFeesCents: number
  totalRepayableCents: number
  disbursementAmountCents: number
  recurringInstalmentCents: number
  schedule: {
    installmentNo: number
    dueDate: string
    principalDueCents: number
    interestDueCents: number
    feesDueCents: number
    totalDueCents: number
    openingBalanceCents: number
    closingBalanceCents: number
  }[]
  pricingFingerprint: string
  contractFingerprint: string
}

export interface AffordabilityDecisionSnapshot {
  stage: "SUBMISSION" | "ASSESSMENT" | "APPROVAL"
  policyVersion: string
  capturedAt: string
  capturedById: string | null
  inputs: AffordabilityDecisionInputs
  debts: {
    application: AffordabilityDebtEvidence[]
    client: AffordabilityDebtEvidence[]
    applicationFingerprint: string
    clientFingerprint: string
  }
  expenses: AffordabilityExpenseEvidence
  bureauEvidence: BureauDecisionEvidence | null
  calculator: AffordabilityCalculatorEvidence
  outcome: AffordabilityDecisionOutcome
  inputFingerprint: string
  decisionFingerprint: string
}

export interface AffordabilityContractEvidence {
  version:
    | typeof LEGACY_AFFORDABILITY_CONTRACT_VERSION
    | typeof AFFORDABILITY_CONTRACT_VERSION
  /** Actual time the final agreement artifact was established. */
  establishedAt: string
  /** Exact client-acknowledged Form 20 bytes accepted for this agreement. */
  acceptedPasqDocumentSha256: string
  /** Exact quote calculator before the agreement schedule was date-rebased. */
  acceptedPasqContractFingerprint?: string
  /** Presentation instant and statutory last binding SAST date of the quote. */
  quotePresentedAt?: string
  quoteValidUntilDate?: string
  approvalDecisionFingerprint: string
  /** Money-identical schedule rebased to the agreement establishment instant. */
  calculator: AffordabilityCalculatorEvidence
  fingerprint: string
}

export interface AffordabilitySnapshotStore {
  schemaVersion: typeof AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION
  submission?: AffordabilityDecisionSnapshot
  submissionHistory?: AffordabilityDecisionSnapshot[]
  assessment?: AffordabilityDecisionSnapshot
  approval?: AffordabilityDecisionSnapshot
  approvalHistory?: AffordabilityDecisionSnapshot[]
  contract?: AffordabilityContractEvidence
  contractHistory?: AffordabilityContractEvidence[]
  legacy?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false
  return new Date(value).toISOString() === value
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0
}

const PRISMA_INT_MAX = 2_147_483_647

function isPrismaIntCents(value: unknown): value is number {
  return isNonNegativeInteger(value) && Number(value) <= PRISMA_INT_MAX
}

export class InvalidAffordabilityDebtError extends Error {
  constructor(
    readonly field: string,
    requirement = "must be a non-negative integer amount in cents",
  ) {
    super(`${field} ${requirement}`)
    this.name = "InvalidAffordabilityDebtError"
  }
}

function cents(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0
}

function strictDebtCents(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > PRISMA_INT_MAX
  ) {
    throw new InvalidAffordabilityDebtError(field)
  }
  return value
}

export function readAffordabilityDebtInputs(value: unknown): AffordabilityDebtInput[] {
  if (!Array.isArray(value)) {
    throw new InvalidAffordabilityDebtError("existingDebtObligations")
  }
  if (!value.every(isRecord)) {
    throw new InvalidAffordabilityDebtError("existingDebtObligations")
  }
  return value as AffordabilityDebtInput[]
}

export function normaliseAffordabilityDebts(
  debts: readonly AffordabilityDebtInput[] | null | undefined,
): AffordabilityDebtEvidence[] {
  const seenSourceIds = new Set<string>()
  return (debts ?? []).map((debt, index) => {
    if (!isRecord(debt)) {
      throw new InvalidAffordabilityDebtError(
        `existingDebtObligations.${index}`,
        "must be an object",
      )
    }
    const sourceId = String(debt.sourceId ?? debt.id ?? "").trim() || null
    const provider = String(
      debt.provider ?? debt.creditor ?? debt.creditProvider ?? "",
    ).trim()
    const type = String(debt.type ?? debt.accountType ?? "").trim()
    if (!provider) {
      throw new InvalidAffordabilityDebtError(
        `existingDebtObligations.${index}.provider`,
        "must identify a credit provider",
      )
    }
    if (!type) {
      throw new InvalidAffordabilityDebtError(
        `existingDebtObligations.${index}.type`,
        "must identify an account type",
      )
    }
    if (sourceId && seenSourceIds.has(sourceId)) {
      throw new InvalidAffordabilityDebtError(
        `existingDebtObligations.${index}.sourceId`,
        "must be unique within the debt declaration",
      )
    }
    if (sourceId) seenSourceIds.add(sourceId)
    return {
      sourceId,
      provider,
      type,
      balanceCents: strictDebtCents(
        debt.balanceCents ?? debt.balance ?? debt.outstandingBalance,
        `existingDebtObligations.${index}.balance`,
      ),
      monthlyInstalmentCents: strictDebtCents(
        debt.monthlyInstalmentCents ?? debt.monthlyInstalment,
        `existingDebtObligations.${index}.monthlyInstalment`,
      ),
      notes: String(debt.notes ?? "").trim() || null,
    }
  })
}

function affordabilityDebtPayload(debt: AffordabilityDebtEvidence): unknown[] {
  return [
    debt.sourceId,
    debt.provider,
    debt.type,
    debt.balanceCents,
    debt.monthlyInstalmentCents,
    debt.notes,
  ]
}

export function affordabilityDebtFingerprint(debts: readonly AffordabilityDebtEvidence[]): string {
  const canonical = debts
    .map(affordabilityDebtPayload)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
}

export function totalAffordabilityDebt(debts: readonly AffordabilityDebtEvidence[]): number {
  const total = debts.reduce((sum, debt) => sum + debt.monthlyInstalmentCents, 0)
  if (!Number.isSafeInteger(total) || total > PRISMA_INT_MAX) {
    throw new InvalidAffordabilityDebtError(
      "existingDebtObligations.totalMonthlyInstalments",
    )
  }
  return total
}

function affordabilityExpensePayload(
  evidence: Omit<AffordabilityExpenseEvidence, "fingerprint">,
): unknown[] {
  return [
    evidence.source,
    evidence.sourceId,
    evidence.sourceUpdatedAt,
    evidence.grossMonthlyIncomeCents,
    evidence.monthlyIncomeCents,
    evidence.statedMonthlyExpensesCents,
    EXPENSE_KEYS.map((key) => evidence.breakdown[key]),
    evidence.breakdownTotalCents,
    evidence.mle.formulaVersion,
    evidence.mle.basisIncomeCents,
    evidence.mle.minimumExpenseCents,
    evidence.mle.belowMinimum,
    evidence.mle.justification,
  ]
}

export function affordabilityExpenseFingerprint(
  evidence: Omit<AffordabilityExpenseEvidence, "fingerprint">,
): string {
  return createHash("sha256")
    .update(JSON.stringify(affordabilityExpensePayload(evidence)))
    .digest("hex")
}

export function affordabilityExpenseEvidenceNeedsMleJustification(
  evidence: Pick<AffordabilityExpenseEvidence, "mle">,
): boolean {
  // Regulation 23A is South African; a lender outside the NCA is not held to it.
  return isNcaJurisdiction() && evidence.mle.belowMinimum && !evidence.mle.justification?.trim()
}

export function createAffordabilityExpenseEvidence(
  input: AffordabilityExpenseInput,
): AffordabilityExpenseEvidence {
  const sourceBreakdown = input.expenseBreakdown ?? null
  const breakdown = Object.fromEntries(
    EXPENSE_KEYS.map((key) => [key, sourceBreakdown ? cents(sourceBreakdown[key]) : 0]),
  ) as Record<ExpenseKey, number>
  if (!sourceBreakdown) breakdown.other = cents(input.monthlyExpenses)
  const grossMonthlyIncomeCents = input.grossMonthlyIncome == null
    ? null
    : cents(input.grossMonthlyIncome)
  const monthlyIncomeCents = cents(input.monthlyIncome)
  const statedMonthlyExpensesCents = cents(input.monthlyExpenses)
  // A legacy 0 in the nullable gross-income field means "not captured", not
  // that an applicant with positive net income earns nothing. Only a positive
  // gross value is authoritative for the Regulation 23A floor; otherwise use
  // net monthly income.
  const basisIncomeCents = grossMonthlyIncomeCents !== null && grossMonthlyIncomeCents > 0
    ? grossMonthlyIncomeCents
    : monthlyIncomeCents
  const minimumExpenseCents = minimumLivingExpense(basisIncomeCents)
  const evidenceWithoutFingerprint: Omit<AffordabilityExpenseEvidence, "fingerprint"> = {
    source: sourceBreakdown ? "CLIENT_BREAKDOWN" as const : "DECLARED_TOTAL" as const,
    sourceId: sourceBreakdown?.id?.trim() || null,
    sourceUpdatedAt: sourceBreakdown?.updatedAt
      ? new Date(sourceBreakdown.updatedAt).toISOString()
      : null,
    grossMonthlyIncomeCents,
    monthlyIncomeCents,
    statedMonthlyExpensesCents,
    breakdown,
    breakdownTotalCents: EXPENSE_KEYS.reduce((sum, key) => sum + breakdown[key], 0),
    mle: {
      formulaVersion: MLE_FORMULA_VERSION,
      basisIncomeCents,
      minimumExpenseCents,
      belowMinimum: statedMonthlyExpensesCents < minimumExpenseCents,
      justification: String(sourceBreakdown?.belowMleJustification ?? "").trim() || null,
    },
  }
  return {
    ...evidenceWithoutFingerprint,
    fingerprint: affordabilityExpenseFingerprint(evidenceWithoutFingerprint),
  }
}

export function affordabilityExpenseEvidenceIsIntact(
  evidence: AffordabilityExpenseEvidence,
): boolean {
  if (
    !isRecord(evidence) ||
    !isRecord(evidence.breakdown) ||
    !isRecord(evidence.mle) ||
    (evidence.source !== "CLIENT_BREAKDOWN" && evidence.source !== "DECLARED_TOTAL") ||
    (evidence.sourceId !== null && typeof evidence.sourceId !== "string") ||
    (evidence.sourceUpdatedAt !== null && !isIsoInstant(evidence.sourceUpdatedAt)) ||
    (evidence.grossMonthlyIncomeCents !== null &&
      !isNonNegativeInteger(evidence.grossMonthlyIncomeCents)) ||
    !isNonNegativeInteger(evidence.monthlyIncomeCents) ||
    !isNonNegativeInteger(evidence.statedMonthlyExpensesCents) ||
    !EXPENSE_KEYS.every((key) => isNonNegativeInteger(evidence.breakdown[key])) ||
    !isNonNegativeInteger(evidence.breakdownTotalCents) ||
    evidence.breakdownTotalCents !== EXPENSE_KEYS.reduce(
      (sum, key) => sum + evidence.breakdown[key],
      0,
    ) ||
    evidence.breakdownTotalCents !== evidence.statedMonthlyExpensesCents ||
    evidence.mle.formulaVersion !== MLE_FORMULA_VERSION ||
    !isNonNegativeInteger(evidence.mle.basisIncomeCents) ||
    !isNonNegativeInteger(evidence.mle.minimumExpenseCents) ||
    typeof evidence.mle.belowMinimum !== "boolean" ||
    (evidence.mle.justification !== null && (
      typeof evidence.mle.justification !== "string" ||
      evidence.mle.justification.trim().length === 0
    ))
  ) {
    return false
  }
  const expectedBasis = evidence.grossMonthlyIncomeCents !== null &&
    evidence.grossMonthlyIncomeCents > 0
    ? evidence.grossMonthlyIncomeCents
    : evidence.monthlyIncomeCents
  if (
    evidence.mle.basisIncomeCents !== expectedBasis ||
    evidence.mle.minimumExpenseCents !== minimumLivingExpense(expectedBasis) ||
    evidence.mle.belowMinimum !==
      (evidence.statedMonthlyExpensesCents < evidence.mle.minimumExpenseCents) ||
    affordabilityExpenseEvidenceNeedsMleJustification(evidence) ||
    (evidence.source === "DECLARED_TOTAL" && (
      evidence.sourceId !== null ||
      evidence.sourceUpdatedAt !== null ||
      evidence.breakdown.other !== evidence.statedMonthlyExpensesCents ||
      EXPENSE_KEYS.some((key) => key !== "other" && evidence.breakdown[key] !== 0)
    ))
  ) {
    return false
  }
  const { fingerprint, ...payload } = evidence
  return fingerprint === affordabilityExpenseFingerprint(payload)
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export function bureauMonthlyObligations(value: unknown): number {
  return isRecord(value) ? cents(value.totalMonthly) : 0
}

/**
 * Whether the stored check states the consumer's bureau debt. A check with
 * no numeric `totalMonthly` (the report carried no accounts and no total, or a
 * row from before the bureau framework) would read as zero debt above, so the
 * bureau gate refuses it without an audited override (lib/decision/bureau-gate.ts).
 */
export function bureauObligationsKnown(value: unknown): boolean {
  return isRecord(value) && typeof value.totalMonthly === "number" && Number.isFinite(value.totalMonthly)
}

export function createBureauDecisionEvidence(args: {
  check: BureauDecisionCheckInput | null
  minimumScore: number
  blockAdverse: boolean
  override: {
    reason: string
    byId: string
    at: Date | string
  } | null
}): BureauDecisionEvidence {
  const check = args.check
    ? {
        id: args.check.id,
        clientId: args.check.clientId,
        subjectFingerprint: args.check.subjectFingerprint ?? "",
        provider: args.check.provider,
        createdAt: new Date(args.check.createdAt).toISOString(),
        score: args.check.score ?? null,
        riskGrade: args.check.riskGrade ?? null,
        unscoreable: args.check.unscoreable === true,
        hasAdverse: args.check.hasAdverse === true,
        deceased: args.check.deceased === true,
        underDebtReview: args.check.underDebtReview === true,
        hasJudgement: args.check.hasJudgement === true,
        hasNotice: args.check.hasNotice === true,
        obligationsCents: bureauMonthlyObligations(args.check.obligations),
        ...(isSimulatedBureauCheck(args.check.obligations) ? { simulated: true as const } : {}),
      }
    : null
  const override = args.override
    ? {
        reason: args.override.reason,
        reasonSha256: sha256Text(args.override.reason),
        byId: args.override.byId,
        at: new Date(args.override.at).toISOString(),
      }
    : null

  return {
    mode: override ? "OVERRIDE" : "CHECK",
    check,
    policy: {
      minimumScore: args.minimumScore,
      blockAdverse: args.blockAdverse,
    },
    override,
  }
}

export function bureauDecisionFingerprint(evidence: BureauDecisionEvidence | null): string {
  const check = evidence === null ? null : evidence.check
  const override = evidence === null ? null : evidence.override
  const canonical = evidence === null
    ? null
    : [
        evidence.mode,
        check === null
          ? null
          : [
              check.id,
              check.clientId,
              check.subjectFingerprint,
              check.provider,
              check.createdAt,
              check.score,
              check.riskGrade,
              check.unscoreable,
              check.hasAdverse,
              check.deceased,
              check.underDebtReview,
              check.hasJudgement,
              check.hasNotice,
              check.obligationsCents,
              // Only when true, so every non-simulated fingerprint is unchanged.
              ...(check.simulated === true ? [true] : []),
            ],
        [evidence.policy.minimumScore, evidence.policy.blockAdverse],
        override === null
          ? null
          : [
              override.reason,
              override.reasonSha256,
              override.byId,
              override.at,
            ],
      ]
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
}

/** Hash every scalar input that can change either the lending decision or repayment calculation. */
export function affordabilityInputFingerprint(inputs: AffordabilityDecisionInputs): string {
  const canonical = [
    inputs.monthlyIncomeCents,
    inputs.monthlyExpensesCents,
    inputs.applicationDebtCents,
    inputs.clientDebtCents,
    inputs.declaredDebtCents,
    inputs.bureauObligationsCents,
    inputs.proposedInstalmentCents,
    inputs.principalCents,
    inputs.termDays,
    inputs.productId,
    inputs.interestRatePm,
    inputs.interestModel,
    inputs.initiationFeePct,
    inputs.initiationFeeMaxCents,
    inputs.monthlyServiceFeeCents,
    inputs.initiationFeePayment,
    inputs.ndiBufferPct,
  ]
  if (inputs.creditLifePremiumCents !== undefined) {
    canonical.push(inputs.creditLifePremiumCents)
  }
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
}

function calculatorPricingPayload(
  calculator: Omit<AffordabilityCalculatorEvidence, "pricingFingerprint" | "contractFingerprint">,
): unknown[] {
  return [
    calculator.version,
    calculator.principalCents,
    calculator.totalInterestCents,
    calculator.initiationFeeCents,
    calculator.serviceFeesCents,
    calculator.totalRepayableCents,
    calculator.disbursementAmountCents,
    calculator.recurringInstalmentCents,
    calculator.schedule.map((item) => [
      item.installmentNo,
      item.principalDueCents,
      item.interestDueCents,
      item.feesDueCents,
      item.totalDueCents,
      item.openingBalanceCents,
      item.closingBalanceCents,
    ]),
  ]
}

export function affordabilityCalculatorFingerprint(
  calculator: Omit<AffordabilityCalculatorEvidence, "pricingFingerprint" | "contractFingerprint">,
): string {
  return createHash("sha256")
    .update(JSON.stringify(calculatorPricingPayload(calculator)))
    .digest("hex")
}

export function affordabilityContractFingerprint(
  calculator: Omit<AffordabilityCalculatorEvidence, "pricingFingerprint" | "contractFingerprint">,
): string {
  return createHash("sha256").update(JSON.stringify([
    calculatorPricingPayload(calculator),
    calculator.startDate,
    calculator.schedule.map((item) => [item.installmentNo, item.dueDate]),
  ])).digest("hex")
}

export function createAffordabilityCalculatorEvidence(
  calculation: LoanCalcResult,
  startDate: Date,
): AffordabilityCalculatorEvidence {
  const evidenceWithoutFingerprint = {
    version: AFFORDABILITY_CALCULATOR_VERSION,
    startDate: startDate.toISOString(),
    principalCents: calculation.principal,
    totalInterestCents: calculation.totalInterest,
    initiationFeeCents: calculation.initiationFee,
    serviceFeesCents: calculation.serviceFees,
    totalRepayableCents: calculation.totalRepayable,
    disbursementAmountCents: calculation.disbursementAmount,
    recurringInstalmentCents: calculation.monthlyInstalment,
    schedule: calculation.schedule.map((item) => ({
      installmentNo: item.installmentNo,
      dueDate: item.dueDate.toISOString(),
      principalDueCents: item.principalDue,
      interestDueCents: item.interestDue,
      feesDueCents: item.feesDue,
      totalDueCents: item.totalDue,
      openingBalanceCents: item.openingBalance,
      closingBalanceCents: item.closingBalance,
    })),
  }
  return {
    ...evidenceWithoutFingerprint,
    pricingFingerprint: affordabilityCalculatorFingerprint(evidenceWithoutFingerprint),
    contractFingerprint: affordabilityContractFingerprint(evidenceWithoutFingerprint),
  }
}

export function calculatorEvidenceIsIntact(
  calculator: AffordabilityCalculatorEvidence,
): boolean {
  if (!isRecord(calculator)) return false
  const scalarAmounts = [
    calculator.principalCents,
    calculator.totalInterestCents,
    calculator.initiationFeeCents,
    calculator.serviceFeesCents,
    calculator.totalRepayableCents,
    calculator.disbursementAmountCents,
    calculator.recurringInstalmentCents,
  ]
  if (
    calculator.version !== AFFORDABILITY_CALCULATOR_VERSION ||
    !isIsoInstant(calculator.startDate) ||
    !scalarAmounts.every(isNonNegativeInteger) ||
    !Array.isArray(calculator.schedule) ||
    !calculator.schedule.every((item) =>
      isRecord(item) &&
      isIsoInstant(item.dueDate) &&
      [
        item.installmentNo,
        item.principalDueCents,
        item.interestDueCents,
        item.feesDueCents,
        item.totalDueCents,
        item.openingBalanceCents,
        item.closingBalanceCents,
      ].every(isNonNegativeInteger),
    )
  ) {
    return false
  }
  const { pricingFingerprint, contractFingerprint, ...evidence } = calculator
  return pricingFingerprint === affordabilityCalculatorFingerprint(evidence) &&
    contractFingerprint === affordabilityContractFingerprint(evidence)
}

export function loanCalculationFromEvidence(
  calculator: AffordabilityCalculatorEvidence,
): LoanCalcResult {
  return {
    principal: calculator.principalCents,
    totalInterest: calculator.totalInterestCents,
    initiationFee: calculator.initiationFeeCents,
    serviceFees: calculator.serviceFeesCents,
    totalRepayable: calculator.totalRepayableCents,
    disbursementAmount: calculator.disbursementAmountCents,
    monthlyInstalment: calculator.recurringInstalmentCents,
    schedule: calculator.schedule.map((item) => ({
      installmentNo: item.installmentNo,
      dueDate: new Date(item.dueDate),
      principalDue: item.principalDueCents,
      interestDue: item.interestDueCents,
      feesDue: item.feesDueCents,
      totalDue: item.totalDueCents,
      openingBalance: item.openingBalanceCents,
      closingBalance: item.closingBalanceCents,
    })),
  }
}

export function affordabilityDecisionFingerprint(args: {
  stage: AffordabilityDecisionSnapshot["stage"]
  policyVersion: string
  capturedAt: string
  capturedById: string | null
  inputs: AffordabilityDecisionInputs
  expenses: AffordabilityExpenseEvidence
  applicationDebts: readonly AffordabilityDebtEvidence[]
  clientDebts: readonly AffordabilityDebtEvidence[]
  bureauEvidence: BureauDecisionEvidence | null
  calculator: AffordabilityCalculatorEvidence
  outcome: AffordabilityDecisionOutcome
}): string {
  return createHash("sha256").update(JSON.stringify([
    args.stage,
    args.policyVersion,
    args.capturedAt,
    args.capturedById,
    affordabilityInputFingerprint(args.inputs),
    args.expenses.fingerprint,
    affordabilityDebtFingerprint(args.applicationDebts),
    affordabilityDebtFingerprint(args.clientDebts),
    bureauDecisionFingerprint(args.bureauEvidence),
    args.calculator.pricingFingerprint,
    args.calculator.contractFingerprint,
    [
      args.outcome.netDisposableIncomeCents,
      args.outcome.ndiAfterLoanCents,
      args.outcome.requiredNdiCents,
      args.outcome.isAffordable,
      args.outcome.reason,
    ],
  ])).digest("hex")
}

export function createAffordabilitySnapshot(args: {
  stage: AffordabilityDecisionSnapshot["stage"]
  policyVersion: string
  capturedAt: Date
  capturedById: string | null
  inputs: AffordabilityDecisionInputs
  applicationDebts: readonly AffordabilityDebtInput[]
  clientDebts: readonly AffordabilityDebtInput[]
  expenseEvidence: AffordabilityExpenseEvidence
  bureauEvidence?: BureauDecisionEvidence | null
  calculation: LoanCalcResult
  calculationStartDate: Date
  outcome: AffordabilityDecisionOutcome
}): AffordabilityDecisionSnapshot {
  const applicationDebts = normaliseAffordabilityDebts(args.applicationDebts)
  const clientDebts = normaliseAffordabilityDebts(args.clientDebts)
  const bureauEvidence = args.bureauEvidence ?? null
  const calculator = createAffordabilityCalculatorEvidence(
    args.calculation,
    args.calculationStartDate,
  )
  const capturedAt = args.capturedAt.toISOString()
  return {
    stage: args.stage,
    policyVersion: args.policyVersion,
    capturedAt,
    capturedById: args.capturedById,
    inputs: args.inputs,
    debts: {
      application: applicationDebts,
      client: clientDebts,
      applicationFingerprint: affordabilityDebtFingerprint(applicationDebts),
      clientFingerprint: affordabilityDebtFingerprint(clientDebts),
    },
    expenses: args.expenseEvidence,
    bureauEvidence,
    calculator,
    outcome: args.outcome,
    inputFingerprint: affordabilityInputFingerprint(args.inputs),
    decisionFingerprint: affordabilityDecisionFingerprint({
      stage: args.stage,
      policyVersion: args.policyVersion,
      capturedAt,
      capturedById: args.capturedById,
      inputs: args.inputs,
      expenses: args.expenseEvidence,
      applicationDebts,
      clientDebts,
      bureauEvidence,
      calculator,
      outcome: args.outcome,
    }),
  }
}

/**
 * Snapshots written before the integer-exact requiredNdi fix shipped used
 * float math that can land one cent HIGH (never low — verified exhaustively
 * over the realistic instalment×buffer space). Their evidence is immutable,
 * so the validator accepts that value — but only for snapshots captured
 * before this cutover, keeping the accepted set closed. The date is generous
 * to survive a delayed deploy; the only thing a forger gains inside the
 * window is a requiredNdi one cent STRICTER than the exact value.
 */
const LEGACY_REQUIRED_NDI_CUTOVER_MS = Date.parse("2026-08-31T00:00:00.000Z")

function affordabilityOutcomeIsConsistent(
  inputs: AffordabilityDecisionInputs,
  outcome: AffordabilityDecisionOutcome,
  capturedAt: string,
): boolean {
  const effectiveDebtCents = Math.max(
    inputs.declaredDebtCents,
    inputs.bureauObligationsCents,
  )
  const discretionaryIncomeCents = inputs.monthlyIncomeCents - inputs.monthlyExpensesCents
  const netDisposableIncomeCents = discretionaryIncomeCents - effectiveDebtCents
  const ndiAfterLoanCents = netDisposableIncomeCents - inputs.proposedInstalmentCents
  const exactRequiredNdiCents = Math.ceil(
    (inputs.proposedInstalmentCents * inputs.ndiBufferPct) / 100,
  )
  // The DB trigger only checks NEW approvals, never re-runs over stored
  // ones, so app-side acceptance of the legacy generation is what keeps
  // pre-fix evidence progressing through sign and disbursement.
  const legacyGenerationSnapshot =
    Date.parse(capturedAt) < LEGACY_REQUIRED_NDI_CUTOVER_MS
  const legacyRequiredNdiCents = Math.ceil(
    inputs.proposedInstalmentCents * (inputs.ndiBufferPct / 100),
  )
  const ratio = inputs.proposedInstalmentCents / Math.max(1, discretionaryIncomeCents)
  const isAffordable =
    netDisposableIncomeCents >= outcome.requiredNdiCents && ratio <= 0.7
  return outcome.netDisposableIncomeCents === netDisposableIncomeCents &&
    outcome.ndiAfterLoanCents === ndiAfterLoanCents &&
    (outcome.requiredNdiCents === exactRequiredNdiCents ||
      (legacyGenerationSnapshot &&
        outcome.requiredNdiCents === legacyRequiredNdiCents)) &&
    outcome.isAffordable === isAffordable &&
    (isAffordable
      ? outcome.reason === null
      : typeof outcome.reason === "string" && outcome.reason.trim().length > 0)
}

function affordabilityDebtEvidenceIsValid(value: unknown): value is AffordabilityDebtEvidence {
  return isRecord(value) &&
    (value.sourceId === null || typeof value.sourceId === "string") &&
    typeof value.provider === "string" && value.provider.trim().length > 0 &&
    typeof value.type === "string" && value.type.trim().length > 0 &&
    isPrismaIntCents(value.balanceCents) &&
    isPrismaIntCents(value.monthlyInstalmentCents) &&
    (value.notes === null || typeof value.notes === "string")
}

function affordabilityDebtEvidenceListIsValid(value: unknown): value is AffordabilityDebtEvidence[] {
  if (!Array.isArray(value) || !value.every(affordabilityDebtEvidenceIsValid)) {
    return false
  }
  const sourceIds = value
    .map((debt) => debt.sourceId)
    .filter((sourceId): sourceId is string => sourceId !== null)
  return new Set(sourceIds).size === sourceIds.length
}

function bureauDecisionEvidenceIsValid(value: unknown): value is BureauDecisionEvidence | null {
  if (value === null) return true
  if (
    !isRecord(value) ||
    (value.mode !== "CHECK" && value.mode !== "OVERRIDE") ||
    !isRecord(value.policy) ||
    !Number.isFinite(value.policy.minimumScore) ||
    typeof value.policy.blockAdverse !== "boolean"
  ) {
    return false
  }

  const check = value.check
  if (check !== null && (
    !isRecord(check) ||
    typeof check.id !== "string" ||
    typeof check.clientId !== "string" ||
    check.clientId.length === 0 ||
    typeof check.subjectFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(check.subjectFingerprint) ||
    typeof check.provider !== "string" ||
    !isIsoInstant(check.createdAt) ||
    (check.score !== null && !Number.isFinite(check.score)) ||
    (check.riskGrade !== null && typeof check.riskGrade !== "string") ||
    typeof check.unscoreable !== "boolean" ||
    typeof check.hasAdverse !== "boolean" ||
    typeof check.deceased !== "boolean" ||
    typeof check.underDebtReview !== "boolean" ||
    typeof check.hasJudgement !== "boolean" ||
    typeof check.hasNotice !== "boolean" ||
    !isNonNegativeInteger(check.obligationsCents) ||
    (check.simulated !== undefined && check.simulated !== true)
  )) {
    return false
  }

  const override = value.override
  if (override !== null && (
    !isRecord(override) ||
    typeof override.reason !== "string" ||
    override.reason.trim().length === 0 ||
    override.reasonSha256 !== sha256Text(override.reason) ||
    typeof override.byId !== "string" ||
    override.byId.trim().length === 0 ||
    !isIsoInstant(override.at)
  )) {
    return false
  }

  return value.mode === "OVERRIDE" ? override !== null : override === null
}

function affordabilityInputsAreValid(value: unknown): value is AffordabilityDecisionInputs {
  if (!isRecord(value)) return false
  const centFields = [
    value.monthlyIncomeCents,
    value.monthlyExpensesCents,
    value.applicationDebtCents,
    value.clientDebtCents,
    value.declaredDebtCents,
    value.bureauObligationsCents,
    value.proposedInstalmentCents,
    value.principalCents,
    value.initiationFeeMaxCents,
    value.monthlyServiceFeeCents,
  ]
  return centFields.every(isNonNegativeInteger) &&
    (value.creditLifePremiumCents === undefined
      || isNonNegativeInteger(value.creditLifePremiumCents)) &&
    Number.isInteger(value.termDays) && Number(value.termDays) > 0 &&
    typeof value.productId === "string" && value.productId.trim().length > 0 &&
    Number.isFinite(value.interestRatePm) && Number(value.interestRatePm) >= 0 &&
    (value.interestModel === "FLAT" ||
      value.interestModel === "REDUCING_BALANCE" ||
      value.interestModel === "DAILY_ACCRUAL") &&
    (value.initiationFeeModel === undefined ||
      value.initiationFeeModel === "FLAT_PCT" ||
      value.initiationFeeModel === "NCA_REG42") &&
    Number.isFinite(value.initiationFeePct) && Number(value.initiationFeePct) >= 0 &&
    (value.initiationFeePayment === "DEFERRED" || value.initiationFeePayment === "UPFRONT") &&
    Number.isFinite(value.ndiBufferPct) && Number(value.ndiBufferPct) >= 0
}

export function calculateLoanFromDecisionInputs(
  inputs: AffordabilityDecisionInputs,
  startDate: Date,
): LoanCalcResult {
  return calculateLoan({
    principal: inputs.principalCents,
    termDays: inputs.termDays,
    interestRatePm: inputs.interestRatePm,
    interestModel: inputs.interestModel,
    initiationFeeModel: inputs.initiationFeeModel ?? "FLAT_PCT",
    initiationFeePct: inputs.initiationFeePct,
    initiationFeeMax: inputs.initiationFeeMaxCents,
    monthlyServiceFee: inputs.monthlyServiceFeeCents,
    productType: inputs.productType ?? null,
    initiationFeePayment: inputs.initiationFeePayment,
  }, startDate)
}

const POLICY_VERSION_BY_STAGE = {
  SUBMISSION: SUBMISSION_AFFORDABILITY_POLICY_VERSION,
  ASSESSMENT: ASSESSMENT_AFFORDABILITY_POLICY_VERSION,
  APPROVAL: APPROVAL_AFFORDABILITY_POLICY_VERSION,
} as const

export function affordabilityDecisionSnapshotIsIntact(
  snapshot: AffordabilityDecisionSnapshot,
): boolean {
  if (
    !isRecord(snapshot) ||
    (snapshot.stage !== "SUBMISSION" &&
      snapshot.stage !== "ASSESSMENT" &&
      snapshot.stage !== "APPROVAL") ||
    snapshot.policyVersion !== POLICY_VERSION_BY_STAGE[snapshot.stage] ||
    !isIsoInstant(snapshot.capturedAt) ||
    (snapshot.capturedById !== null && typeof snapshot.capturedById !== "string") ||
    !affordabilityInputsAreValid(snapshot.inputs) ||
    !isRecord(snapshot.debts) ||
    !affordabilityDebtEvidenceListIsValid(snapshot.debts.application) ||
    !affordabilityDebtEvidenceListIsValid(snapshot.debts.client) ||
    !isRecord(snapshot.outcome) ||
    !bureauDecisionEvidenceIsValid(snapshot.bureauEvidence) ||
    !affordabilityExpenseEvidenceIsIntact(snapshot.expenses) ||
    !calculatorEvidenceIsIntact(snapshot.calculator)
  ) {
    return false
  }

  let applicationDebtCents: number
  let clientDebtCents: number
  const expectedBureauObligationsCents = snapshot.bureauEvidence?.check?.obligationsCents ?? 0
  let expectedCalculator: AffordabilityCalculatorEvidence
  try {
    applicationDebtCents = totalAffordabilityDebt(snapshot.debts.application)
    clientDebtCents = totalAffordabilityDebt(snapshot.debts.client)
    const calculation = calculateLoanFromDecisionInputs(
      snapshot.inputs,
      new Date(snapshot.calculator.startDate),
    )
    expectedCalculator = createAffordabilityCalculatorEvidence(
      calculation,
      new Date(snapshot.calculator.startDate),
    )
  } catch {
    return false
  }

  if (
    (snapshot.stage === "APPROVAL"
      ? Date.parse(snapshot.calculator.startDate) > Date.parse(snapshot.capturedAt)
      : snapshot.calculator.startDate !== snapshot.capturedAt) ||
    snapshot.inputs.monthlyIncomeCents !== snapshot.expenses.monthlyIncomeCents ||
    snapshot.inputs.monthlyExpensesCents !== snapshot.expenses.statedMonthlyExpensesCents ||
    snapshot.inputs.applicationDebtCents !== applicationDebtCents ||
    snapshot.inputs.clientDebtCents !== clientDebtCents ||
    snapshot.inputs.declaredDebtCents !== Math.max(applicationDebtCents, clientDebtCents) ||
    snapshot.inputs.bureauObligationsCents !== expectedBureauObligationsCents ||
    snapshot.inputs.proposedInstalmentCents !==
      expectedCalculator.recurringInstalmentCents
        + (snapshot.inputs.creditLifePremiumCents ?? 0) ||
    (snapshot.stage === "APPROVAL" && !snapshot.outcome.isAffordable) ||
    snapshot.calculator.contractFingerprint !== expectedCalculator.contractFingerprint ||
    snapshot.inputFingerprint !== affordabilityInputFingerprint(snapshot.inputs) ||
    snapshot.debts.applicationFingerprint !== affordabilityDebtFingerprint(snapshot.debts.application) ||
    snapshot.debts.clientFingerprint !== affordabilityDebtFingerprint(snapshot.debts.client) ||
    !affordabilityOutcomeIsConsistent(snapshot.inputs, snapshot.outcome, snapshot.capturedAt)
  ) {
    return false
  }
  return snapshot.decisionFingerprint === affordabilityDecisionFingerprint({
    stage: snapshot.stage,
    policyVersion: snapshot.policyVersion,
    capturedAt: snapshot.capturedAt,
    capturedById: snapshot.capturedById,
    inputs: snapshot.inputs,
    expenses: snapshot.expenses,
    applicationDebts: snapshot.debts.application,
    clientDebts: snapshot.debts.client,
    bureauEvidence: snapshot.bureauEvidence,
    calculator: snapshot.calculator,
    outcome: snapshot.outcome,
  })
}

function affordabilityContractEvidenceFingerprint(
  evidence: Omit<AffordabilityContractEvidence, "fingerprint">,
): string {
  if (evidence.version === LEGACY_AFFORDABILITY_CONTRACT_VERSION) {
    return createHash("sha256").update(JSON.stringify([
      evidence.version,
      evidence.establishedAt,
      evidence.acceptedPasqDocumentSha256,
      evidence.approvalDecisionFingerprint,
      evidence.calculator.contractFingerprint,
    ])).digest("hex")
  }
  return createHash("sha256").update(JSON.stringify([
    evidence.version,
    evidence.establishedAt,
    evidence.acceptedPasqDocumentSha256,
    evidence.acceptedPasqContractFingerprint,
    evidence.quotePresentedAt,
    evidence.quoteValidUntilDate,
    evidence.approvalDecisionFingerprint,
    evidence.calculator.contractFingerprint,
  ])).digest("hex")
}

export function rebaseAffordabilityCalculatorEvidence(
  calculator: AffordabilityCalculatorEvidence,
  rebasedStartAt: Date,
): AffordabilityCalculatorEvidence {
  if (
    !calculatorEvidenceIsIntact(calculator)
    || !Number.isFinite(rebasedStartAt.getTime())
  ) {
    throw new Error("Cannot rebase invalid calculator evidence")
  }
  const originalStartAt = new Date(calculator.startDate)
  const offsetMs = rebasedStartAt.getTime() - originalStartAt.getTime()
  const evidenceWithoutFingerprint = {
    version: calculator.version,
    startDate: rebasedStartAt.toISOString(),
    principalCents: calculator.principalCents,
    totalInterestCents: calculator.totalInterestCents,
    initiationFeeCents: calculator.initiationFeeCents,
    serviceFeesCents: calculator.serviceFeesCents,
    totalRepayableCents: calculator.totalRepayableCents,
    disbursementAmountCents: calculator.disbursementAmountCents,
    recurringInstalmentCents: calculator.recurringInstalmentCents,
    schedule: calculator.schedule.map((item) => ({
      ...item,
      dueDate: new Date(
        new Date(item.dueDate).getTime() + offsetMs,
      ).toISOString(),
    })),
  }
  return {
    ...evidenceWithoutFingerprint,
    pricingFingerprint:
      affordabilityCalculatorFingerprint(evidenceWithoutFingerprint),
    contractFingerprint:
      affordabilityContractFingerprint(evidenceWithoutFingerprint),
  }
}

export function createAffordabilityContractEvidence(
  approval: AffordabilityDecisionSnapshot,
  establishedAt: Date,
  acceptedPasq: {
    documentSha256: string
    calculator: AffordabilityCalculatorEvidence
    quoteValidUntilDate?: string
  },
): AffordabilityContractEvidence {
  if (approval.stage !== "APPROVAL" || !affordabilityDecisionSnapshotIsIntact(approval)) {
    throw new Error("Cannot establish a contract schedule from invalid approval evidence")
  }
  const quotePresentedAt = acceptedPasq.calculator.startDate
  const quoteValidUntilDate = acceptedPasq.quoteValidUntilDate
    ?? quotationValidUntilDate(new Date(quotePresentedAt))
  if (
    !isSha256Digest(acceptedPasq.documentSha256)
    || !calculatorEvidenceIsIntact(acceptedPasq.calculator)
    || acceptedPasq.calculator.pricingFingerprint !== approval.calculator.pricingFingerprint
    || !Number.isFinite(Date.parse(acceptedPasq.calculator.startDate))
    || !quotationIsBindingThroughDate(
      new Date(acceptedPasq.calculator.startDate),
      establishedAt,
      quoteValidUntilDate,
    )
  ) {
    throw new Error(
      "Contract schedule no longer matches a binding approved and acknowledged PASQ",
    )
  }
  const calculator = rebaseAffordabilityCalculatorEvidence(
    acceptedPasq.calculator,
    establishedAt,
  )
  const evidenceWithoutFingerprint = {
    version: AFFORDABILITY_CONTRACT_VERSION,
    establishedAt: establishedAt.toISOString(),
    acceptedPasqDocumentSha256: acceptedPasq.documentSha256,
    acceptedPasqContractFingerprint:
      acceptedPasq.calculator.contractFingerprint,
    quotePresentedAt,
    quoteValidUntilDate,
    approvalDecisionFingerprint: approval.decisionFingerprint,
    calculator,
  }
  return {
    ...evidenceWithoutFingerprint,
    fingerprint: affordabilityContractEvidenceFingerprint(evidenceWithoutFingerprint),
  }
}

export function affordabilityContractEvidenceIsIntact(
  contract: AffordabilityContractEvidence,
  approval: AffordabilityDecisionSnapshot,
): boolean {
  if (
    !isRecord(contract) ||
    !affordabilityDecisionSnapshotIsIntact(approval) ||
    approval.stage !== "APPROVAL" ||
    (
      contract.version !== AFFORDABILITY_CONTRACT_VERSION
      && contract.version !== LEGACY_AFFORDABILITY_CONTRACT_VERSION
    ) ||
    !isIsoInstant(contract.establishedAt) ||
    !isSha256Digest(contract.acceptedPasqDocumentSha256) ||
    !isRecord(contract.calculator) ||
    contract.approvalDecisionFingerprint !== approval.decisionFingerprint ||
    !calculatorEvidenceIsIntact(contract.calculator) ||
    contract.calculator.pricingFingerprint !== approval.calculator.pricingFingerprint
  ) {
    return false
  }

  const { fingerprint, ...payload } = contract
  if (fingerprint !== affordabilityContractEvidenceFingerprint(payload)) {
    return false
  }

  if (contract.version === LEGACY_AFFORDABILITY_CONTRACT_VERSION) {
    return quotationIsBindingAt(
      new Date(contract.calculator.startDate),
      new Date(contract.establishedAt),
    )
  }

  if (
    !isSha256Digest(contract.acceptedPasqContractFingerprint)
    || !isIsoInstant(contract.quotePresentedAt)
    || typeof contract.quoteValidUntilDate !== "string"
    || !quotationIsBindingThroughDate(
      new Date(contract.quotePresentedAt),
      new Date(contract.establishedAt),
      contract.quoteValidUntilDate,
    )
  ) {
    return false
  }

  let acceptedPasqCalculator: AffordabilityCalculatorEvidence
  let expected: AffordabilityContractEvidence
  try {
    acceptedPasqCalculator = rebaseAffordabilityCalculatorEvidence(
      contract.calculator,
      new Date(contract.quotePresentedAt),
    )
    if (
      acceptedPasqCalculator.contractFingerprint
        !== contract.acceptedPasqContractFingerprint
    ) {
      return false
    }
    expected = createAffordabilityContractEvidence(
      approval,
      new Date(contract.establishedAt),
      {
        documentSha256: contract.acceptedPasqDocumentSha256,
        calculator: acceptedPasqCalculator,
        quoteValidUntilDate: contract.quoteValidUntilDate,
      },
    )
  } catch {
    return false
  }
  return fingerprint === expected.fingerprint
}

/**
 * May this contract be acted on AT `at`?
 *
 * The quotation stays binding for the statutory five South African business
 * days (NCA s92(3)). Whether the whole ceremony must ALSO complete on the
 * established SAST calendar day now depends on how the loan is collected.
 *
 * DEBIT_ORDER: yes. The consumer signs a debit mandate BEFORE payout that
 * authorises collection on specific dates, `lib/loan/debit-mandate.ts` checks
 * the booked schedule against those exact dates, and a signed mandate cannot be
 * quietly amended. Holding payout to the established day keeps the mandate
 * correct by construction. An unset method takes this path too.
 *
 * EFT: no. There is no mandate and nothing has authorised dates in advance, so
 * s92(3) is the only bound needed. This is what makes a paper signature
 * returned the next morning recordable — the closed loop that produced two
 * management ledger exceptions in eight days, because regenerating to refresh
 * the schedule mints a document the consumer never signed.
 *
 * The EFT relaxation is only safe because the disburse route TRANSLATES the
 * schedule to the payout date (`sastCalendarDaysBetween`), so the consumer
 * still receives the full disclosed term, and the credit agreement states that
 * payment dates run from payout. Without both, relaxing this is an s103
 * rate-cap breach: R100 over 29 days instead of 30 is 5.17% a month against a
 * 5% cap.
 *
 * `at` is the instant the real-world event happened — the consumer's
 * signature, the provider's countersignature, the payout — NOT the wall clock
 * of the request recording it. Those are different facts, and the parameter is
 * required so no caller can conflate them by omission: a signature given on
 * 4 August is a 4 August fact even when staff record it on the 5th.
 *
 * It is deliberately not defaulted. The default used to be `new Date()`, which
 * meant a caller who never thought about the event date silently got "now" and
 * a plausible answer to the wrong question. An absent or unparseable instant is
 * missing evidence, so it fails closed instead.
 */
export function affordabilityContractCanBeDisbursed(
  contract: AffordabilityContractEvidence,
  at: Date,
  repaymentMethod: "EFT" | "DEBIT_ORDER" | null | undefined,
): boolean {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) return false
  // Only EFT is relaxed. DEBIT_ORDER keeps the same-day rule because its
  // mandate authorises collection on specific dates before payout, and an
  // unset method takes the strict path too — we cannot know what will be
  // collected, so the safe answer is the one that was already true.
  const requireSameDayPayout = repaymentMethod !== "EFT"
  const establishedAt = new Date(contract.establishedAt)
  const scheduleStartAt = new Date(contract.calculator.startDate)
  const quotePresentedAt = new Date(
    contract.quotePresentedAt ?? contract.calculator.startDate,
  )
  const firstDueAt = contract.calculator.schedule[0]?.dueDate
    ? new Date(contract.calculator.schedule[0].dueDate)
    : null
  const quoteIsBinding = contract.quoteValidUntilDate
    ? quotationIsBindingThroughDate(
        quotePresentedAt,
        at,
        contract.quoteValidUntilDate,
      )
    : quotationIsBindingAt(quotePresentedAt, at)
  return Number.isFinite(establishedAt.getTime()) &&
    Number.isFinite(scheduleStartAt.getTime()) &&
    Number.isFinite(quotePresentedAt.getTime()) &&
    establishedAt.getTime() <= at.getTime() &&
    quoteIsBinding &&
    (!requireSameDayPayout
      || southAfricanCalendarDate(establishedAt)
        === southAfricanCalendarDate(at)) &&
    firstDueAt !== null &&
    Number.isFinite(firstDueAt.getTime()) &&
    firstDueAt.getTime() > scheduleStartAt.getTime()
}

export function acceptedPasqCalculatorFingerprint(
  contract: AffordabilityContractEvidence,
): string {
  return contract.acceptedPasqContractFingerprint
    ?? contract.calculator.contractFingerprint
}

export function createSubmissionAffordabilitySnapshot(args: {
  capturedAt: Date
  capturedById: string | null
  client: AffordabilityExpenseInput
  applicationDebts: readonly AffordabilityDebtInput[]
  clientDebts: readonly AffordabilityDebtInput[]
  application: {
    appliedAmount: number
    appliedTermDays: number
    productId: string
    initiationFeePayment?: "DEFERRED" | "UPFRONT"
    creditLifeMonthlyPremiumCents?: number
  }
  product: {
    interestRatePm: number
    interestModel: "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL"
    productType: string | null
    initiationFeeModel: "FLAT_PCT" | "NCA_REG42"
    initiationFeePct: number
    initiationFeeMax: number
    monthlyServiceFee: number
  }
}): AffordabilityDecisionSnapshot {
  const initiationFeePayment = args.application.initiationFeePayment ?? "DEFERRED"
  const applicationDebts = normaliseAffordabilityDebts(args.applicationDebts)
  const clientDebts = normaliseAffordabilityDebts(args.clientDebts)
  const applicationDebtCents = totalAffordabilityDebt(applicationDebts)
  const clientDebtCents = totalAffordabilityDebt(clientDebts)
  const declaredDebtCents = Math.max(applicationDebtCents, clientDebtCents)
  const creditLifeMonthlyPremiumCents =
    args.application.creditLifeMonthlyPremiumCents ?? 0
  if (!isNonNegativeInteger(creditLifeMonthlyPremiumCents)) {
    throw new RangeError("Credit-life premium is outside the supported cents range")
  }
  const loanCalc = calculateLoan({
    principal: args.application.appliedAmount,
    termDays: args.application.appliedTermDays,
    interestRatePm: args.product.interestRatePm,
    productType: args.product.productType,
    interestModel: args.product.interestModel,
    initiationFeeModel: args.product.initiationFeeModel,
    initiationFeePct: args.product.initiationFeePct,
    initiationFeeMax: args.product.initiationFeeMax,
    monthlyServiceFee: args.product.monthlyServiceFee,
    initiationFeePayment,
  }, args.capturedAt)
  const expenseEvidence = createAffordabilityExpenseEvidence(args.client)
  const creditLifePremiumCents = creditLifeMonthlyPremiumCents === 0
    ? 0
    : creditLifePremiumPaymentLoadCents({
        scheduleLength: loanCalc.schedule.length,
        premiumPeriods: calculateCreditLifePremiumPeriodsForSchedule(
          loanCalc.schedule.length,
          args.application.appliedTermDays,
        ),
        monthlyPremiumCents: creditLifeMonthlyPremiumCents,
        accepted: true,
      })
  const proposedInstalmentCents = loanCalc.monthlyInstalment + creditLifePremiumCents
  if (!Number.isSafeInteger(proposedInstalmentCents)) {
    throw new RangeError("Proposed instalment is outside the supported cents range")
  }
  const assessment = assessAffordability({
    monthlyIncomeCents: args.client.monthlyIncome,
    monthlyExpensesCents: args.client.monthlyExpenses,
    debts: [{ monthlyInstalment: declaredDebtCents }],
    proposedInstalmentCents,
  })
  return createAffordabilitySnapshot({
    stage: "SUBMISSION",
    policyVersion: SUBMISSION_AFFORDABILITY_POLICY_VERSION,
    capturedAt: args.capturedAt,
    capturedById: args.capturedById,
    applicationDebts,
    clientDebts,
    expenseEvidence,
    calculation: loanCalc,
    calculationStartDate: args.capturedAt,
    inputs: {
      monthlyIncomeCents: args.client.monthlyIncome,
      monthlyExpensesCents: args.client.monthlyExpenses,
      applicationDebtCents,
      clientDebtCents,
      declaredDebtCents,
      bureauObligationsCents: 0,
      proposedInstalmentCents,
      creditLifePremiumCents,
      principalCents: args.application.appliedAmount,
      termDays: args.application.appliedTermDays,
      productId: args.application.productId,
      interestRatePm: args.product.interestRatePm,
      productType: args.product.productType,
      interestModel: args.product.interestModel,
      initiationFeeModel: args.product.initiationFeeModel,
      initiationFeePct: args.product.initiationFeePct,
      initiationFeeMaxCents: args.product.initiationFeeMax,
      monthlyServiceFeeCents: args.product.monthlyServiceFee,
      initiationFeePayment,
      ndiBufferPct: 100,
    },
    outcome: {
      netDisposableIncomeCents: assessment.netDisposableIncome,
      ndiAfterLoanCents: assessment.ndiAfterLoan,
      requiredNdiCents: proposedInstalmentCents,
      isAffordable: assessment.isAffordable,
      reason: assessment.isAffordable ? null : "Submission affordability assessment failed",
    },
  })
}

/** Preserve pre-v3 evidence verbatim while moving to the stronger versioned store. */
export function readAffordabilitySnapshotStore(value: unknown): AffordabilitySnapshotStore {
  if (isRecord(value) && value.schemaVersion === AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION) {
    return value as unknown as AffordabilitySnapshotStore
  }
  return {
    schemaVersion: AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
    ...(isRecord(value) && Object.keys(value).length > 0 ? { legacy: value } : {}),
  }
}

export function withAffordabilitySnapshot(
  current: unknown,
  snapshot: AffordabilityDecisionSnapshot,
): AffordabilitySnapshotStore {
  const store = readAffordabilitySnapshotStore(current)
  const key = snapshot.stage.toLowerCase() as "submission" | "assessment" | "approval"
  if (key === "submission") {
    return {
      ...store,
      ...(store.submission
        ? { submissionHistory: [...(store.submissionHistory ?? []), store.submission] }
        : {}),
      submission: snapshot,
    }
  }
  if (key === "approval") {
    const { contract, ...withoutContract } = store
    return {
      ...withoutContract,
      ...(store.approval
        ? { approvalHistory: [...(store.approvalHistory ?? []), store.approval] }
        : {}),
      ...(contract
        ? { contractHistory: [...(store.contractHistory ?? []), contract] }
        : {}),
      approval: snapshot,
    }
  }
  return { ...store, [key]: snapshot }
}

export function withAffordabilityContract(
  current: unknown,
  contract: AffordabilityContractEvidence,
): AffordabilitySnapshotStore {
  const store = readAffordabilitySnapshotStore(current)
  return {
    ...store,
    ...(store.contract
      ? { contractHistory: [...(store.contractHistory ?? []), store.contract] }
      : {}),
    contract,
  }
}

export function returnAffordabilityToReview(current: unknown): AffordabilitySnapshotStore {
  const store = readAffordabilitySnapshotStore(current)
  const { approval, contract, ...withoutCurrentDecision } = store
  if (!approval && !contract) return store
  return {
    ...withoutCurrentDecision,
    ...(approval
      ? { approvalHistory: [...(store.approvalHistory ?? []), approval] }
      : {}),
    ...(contract
      ? { contractHistory: [...(store.contractHistory ?? []), contract] }
      : {}),
  }
}

export function returnAffordabilityToDraft(current: unknown): AffordabilitySnapshotStore {
  const store = readAffordabilitySnapshotStore(current)
  const { submission, ...withoutCurrentSubmission } = store
  if (!submission) return store
  return {
    ...withoutCurrentSubmission,
    submissionHistory: [...(store.submissionHistory ?? []), submission],
  }
}

export function assessmentSnapshotMatches(
  current: unknown,
  args: {
    inputs: AffordabilityDecisionInputs
    expenseEvidence: AffordabilityExpenseEvidence
    applicationDebts: readonly AffordabilityDebtInput[]
    clientDebts: readonly AffordabilityDebtInput[]
    calculation: LoanCalcResult
  },
): { ok: true; snapshot: AffordabilityDecisionSnapshot } | { ok: false; reason: "missing" | "changed" } {
  const assessment = readAffordabilitySnapshotStore(current).assessment
  if (!assessment || assessment.policyVersion !== ASSESSMENT_AFFORDABILITY_POLICY_VERSION) {
    return { ok: false, reason: "missing" }
  }
  if (
    !affordabilityDecisionSnapshotIsIntact(assessment)
  ) {
    return { ok: false, reason: "changed" }
  }
  let calculator: AffordabilityCalculatorEvidence
  try {
    const calculation = calculateLoanFromDecisionInputs(
      args.inputs,
      new Date(assessment.calculator.startDate),
    )
    calculator = createAffordabilityCalculatorEvidence(
      calculation,
      new Date(assessment.calculator.startDate),
    )
    const suppliedPricing = createAffordabilityCalculatorEvidence(
      args.calculation,
      new Date(assessment.calculator.startDate),
    )
    if (calculator.pricingFingerprint !== suppliedPricing.pricingFingerprint) {
      return { ok: false, reason: "changed" }
    }
  } catch {
    return { ok: false, reason: "changed" }
  }
  const decisionFingerprint = affordabilityDecisionFingerprint({
    stage: assessment.stage,
    policyVersion: assessment.policyVersion,
    capturedAt: assessment.capturedAt,
    capturedById: assessment.capturedById,
    inputs: args.inputs,
    expenses: args.expenseEvidence,
    applicationDebts: normaliseAffordabilityDebts(args.applicationDebts),
    clientDebts: normaliseAffordabilityDebts(args.clientDebts),
    bureauEvidence: null,
    calculator,
    outcome: assessment.outcome,
  })
  return assessment.decisionFingerprint === decisionFingerprint
    ? { ok: true, snapshot: assessment }
    : { ok: false, reason: "changed" }
}

/**
 * The loan's pricing terms as they stood when the approval was minted.
 *
 * Under NCA s.92 the quotation the consumer received and agreed to IS the deal.
 * Editing a `LoanProduct` afterwards is ordinary maintenance that must apply to
 * FUTURE applications only — re-deriving a live price for an already-approved
 * loan silently reprices it, and then every downstream gate refuses it for no
 * longer matching its own approval. (Flipping a product from REDUCING_BALANCE
 * to FLAT would otherwise turn a three-instalment approved loan into a single
 * payment of a different total, and block its credit agreement from being
 * generated at all.)
 *
 * Reading terms back out of the snapshot is only sound because the snapshot
 * carries its own integrity fingerprint, which is verified here before any value
 * is trusted — these terms cannot be tampered with independently of the approval
 * they belong to. Callers that also compare against this snapshot must keep
 * their CONSUMER inputs live, or the comparison degrades into the snapshot being
 * checked against itself, which can never fail.
 *
 * Returns null rather than falling back to the live product: a silent fallback
 * would quietly reinstate the exact behaviour this exists to prevent.
 */
export function frozenApprovedTerms(
  affordabilityResult: unknown,
):
  | { ok: true; terms: AffordabilityDecisionInputs }
  | { ok: false; reason: "missing" | "changed" } {
  const approval = readAffordabilitySnapshotStore(affordabilityResult).approval
  // Absent or from a superseded policy generation === "missing"; present but
  // failing its own integrity fingerprint === "changed". These are different
  // operator remedies and callers render different copy for them, so they must
  // not be collapsed: reporting a tampered snapshot as "missing" is a false
  // statement about the evidence, even though the recovery happens to match.
  if (!approval || approval.policyVersion !== APPROVAL_AFFORDABILITY_POLICY_VERSION) {
    return { ok: false, reason: "missing" }
  }
  if (!affordabilityDecisionSnapshotIsIntact(approval)) {
    return { ok: false, reason: "changed" }
  }
  return { ok: true, terms: approval.inputs }
}

export function approvalSnapshotMatches(
  current: unknown,
  args: {
    inputs: AffordabilityDecisionInputs
    expenseEvidence: AffordabilityExpenseEvidence
    applicationDebts: readonly AffordabilityDebtInput[]
    clientDebts: readonly AffordabilityDebtInput[]
    bureauEvidence: BureauDecisionEvidence
    calculation: LoanCalcResult
  },
): { ok: true; snapshot: AffordabilityDecisionSnapshot } | { ok: false; reason: "missing" | "changed" } {
  const approval = readAffordabilitySnapshotStore(current).approval
  if (!approval || approval.policyVersion !== APPROVAL_AFFORDABILITY_POLICY_VERSION) {
    return { ok: false, reason: "missing" }
  }
  if (
    !affordabilityDecisionSnapshotIsIntact(approval)
  ) {
    return { ok: false, reason: "changed" }
  }
  let calculator: AffordabilityCalculatorEvidence
  try {
    const calculation = calculateLoanFromDecisionInputs(
      args.inputs,
      new Date(approval.calculator.startDate),
    )
    calculator = createAffordabilityCalculatorEvidence(
      calculation,
      new Date(approval.calculator.startDate),
    )
    const suppliedPricing = createAffordabilityCalculatorEvidence(
      args.calculation,
      new Date(approval.calculator.startDate),
    )
    if (calculator.pricingFingerprint !== suppliedPricing.pricingFingerprint) {
      return { ok: false, reason: "changed" }
    }
  } catch {
    return { ok: false, reason: "changed" }
  }
  const decisionFingerprint = affordabilityDecisionFingerprint({
    stage: approval.stage,
    policyVersion: approval.policyVersion,
    capturedAt: approval.capturedAt,
    capturedById: approval.capturedById,
    inputs: args.inputs,
    expenses: args.expenseEvidence,
    applicationDebts: normaliseAffordabilityDebts(args.applicationDebts),
    clientDebts: normaliseAffordabilityDebts(args.clientDebts),
    bureauEvidence: args.bureauEvidence,
    calculator,
    outcome: approval.outcome,
  })
  return approval.decisionFingerprint === decisionFingerprint
    ? { ok: true, snapshot: approval }
    : { ok: false, reason: "changed" }
}

export function latestAffordabilitySnapshot(current: unknown): AffordabilityDecisionSnapshot | null {
  const store = readAffordabilitySnapshotStore(current)
  return [store.submission, store.assessment, store.approval]
    .filter((snapshot): snapshot is AffordabilityDecisionSnapshot => {
      if (!isRecord(snapshot)) return false
      try {
        return affordabilityDecisionSnapshotIsIntact(
          snapshot as unknown as AffordabilityDecisionSnapshot,
        )
      } catch {
        return false
      }
    })
    .sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt))[0] ?? null
}
