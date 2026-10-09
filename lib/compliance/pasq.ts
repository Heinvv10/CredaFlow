import { canonicalJson } from "@/lib/canonical-json"
import { createHash } from "node:crypto"
import {
  calculatorEvidenceIsIntact,
  type AffordabilityCalculatorEvidence,
} from "@/lib/affordability/snapshot"
import {
  CREDIT_LIFE_DISCLOSURE_VERSION,
  CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
  isCreditLifeElection,
  type CreditLifeElection,
} from "@/lib/insurance/credit-life-election"
import {
  createCreditLifeDisclosureSha256,
  createCreditLifeNoOfferDisclosureSha256,
} from "@/lib/insurance/credit-life-election.server"
import {
  calculateCreditLifePremiumPeriodsForSchedule,
  creditLifePremiumsByInstallment,
} from "@/lib/insurance/credit-life-billing"

export const PASQ_VERSION = "pasq-v3" as const
export const PASQ_BILLING_VERSION = "credit-life-billing-v1" as const

export interface PasqBillingScheduleItem {
  installmentNo: number
  dueDate: string
  principalDueCents: number
  interestDueCents: number
  baseFeesDueCents: number
  creditLifePremiumDueCents: number
  feesDueCents: number
  totalDueCents: number
  openingBalanceCents: number
  closingBalanceCents: number
}

export interface PasqBillingEvidence {
  version: typeof PASQ_BILLING_VERSION
  collectionMethod: "INCLUDED_IN_LOAN_REPAYMENT"
  recurringPaymentCents: number
  totalRepayableCents: number
  schedule: PasqBillingScheduleItem[]
}

export interface PasqEvidence {
  version: typeof PASQ_VERSION
  tenantId: string
  applicationId: string
  clientId: string
  productId: string
  termDays: number
  generatedAt: string
  calculator: AffordabilityCalculatorEvidence
  creditLife: {
    election: CreditLifeElection
    // Null exactly when disclosureVersion is the no-offer version: the tenant
    // had no active credit-life product, so there was no identity to disclose.
    productId: string | null
    productName: string | null
    insurerId: string | null
    insurerName: string | null
    monthlyPremiumCents: number
    premiumPeriods: number
    totalPremiumCents: number
    disclosureVersion:
      | typeof CREDIT_LIFE_DISCLOSURE_VERSION
      | typeof CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION
    disclosureSha256: string
  }
  billing: PasqBillingEvidence
  totalCostOfCreditCents: number
  evidenceSha256: string
}

export interface CreatePasqEvidenceInput {
  tenantId: string
  applicationId: string
  clientId: string
  productId: string
  termDays: number
  generatedAt: Date
  calculator: AffordabilityCalculatorEvidence
  creditLife: {
    election: CreditLifeElection
    productId: string | null
    productName: string | null
    insurerId: string | null
    insurerName: string | null
    monthlyPremiumCents: number
    disclosureVersion:
      | typeof CREDIT_LIFE_DISCLOSURE_VERSION
      | typeof CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION
    disclosureSha256: string
  }
}

function canonicalPasqFields(
  evidence: Omit<PasqEvidence, "evidenceSha256">,
): string[] {
  return [
    evidence.version,
    evidence.tenantId,
    evidence.applicationId,
    evidence.clientId,
    evidence.productId,
    String(evidence.termDays),
    evidence.generatedAt,
    evidence.calculator.version,
    evidence.calculator.startDate,
    String(evidence.calculator.principalCents),
    String(evidence.calculator.totalInterestCents),
    String(evidence.calculator.initiationFeeCents),
    String(evidence.calculator.serviceFeesCents),
    String(evidence.calculator.totalRepayableCents),
    String(evidence.calculator.disbursementAmountCents),
    String(evidence.calculator.recurringInstalmentCents),
    String(evidence.calculator.schedule.length),
    ...evidence.calculator.schedule.flatMap((item) => [
      String(item.installmentNo),
      item.dueDate,
      String(item.principalDueCents),
      String(item.interestDueCents),
      String(item.feesDueCents),
      String(item.totalDueCents),
      String(item.openingBalanceCents),
      String(item.closingBalanceCents),
    ]),
    evidence.calculator.pricingFingerprint,
    evidence.calculator.contractFingerprint,
    evidence.creditLife.election,
    // A no-offer disclosure contributes NO identity fields — mirrored by the
    // same branch in "pasqEvidenceSha256V3". Hashing empty strings
    // instead would collide with a genuine offer whose names were blank, and
    // the DB function rejects empty required values outright.
    ...(evidence.creditLife.disclosureVersion === CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION
      ? []
      : [
          evidence.creditLife.productId ?? "",
          evidence.creditLife.productName ?? "",
          evidence.creditLife.insurerId ?? "",
          evidence.creditLife.insurerName ?? "",
        ]),
    String(evidence.creditLife.monthlyPremiumCents),
    String(evidence.creditLife.premiumPeriods),
    String(evidence.creditLife.totalPremiumCents),
    evidence.creditLife.disclosureVersion,
    evidence.creditLife.disclosureSha256,
    evidence.billing.version,
    evidence.billing.collectionMethod,
    String(evidence.billing.recurringPaymentCents),
    String(evidence.billing.totalRepayableCents),
    String(evidence.billing.schedule.length),
    ...evidence.billing.schedule.flatMap((item) => [
      String(item.installmentNo),
      item.dueDate,
      String(item.principalDueCents),
      String(item.interestDueCents),
      String(item.baseFeesDueCents),
      String(item.creditLifePremiumDueCents),
      String(item.feesDueCents),
      String(item.totalDueCents),
      String(item.openingBalanceCents),
      String(item.closingBalanceCents),
    ]),
    String(evidence.totalCostOfCreditCents),
  ]
}

export function pasqEvidenceSha256(
  evidence: Omit<PasqEvidence, "evidenceSha256">,
): string {
  const encoded = canonicalPasqFields(evidence).map((value) =>
    Buffer.from(value, "utf8").toString("hex")
  )
  return createHash("sha256")
    .update(["pasq-evidence-envelope-v3", ...encoded].join(":"))
    .digest("hex")
}

export function calculateCreditLifePremiumPeriods(
  calculator: Pick<AffordabilityCalculatorEvidence, "schedule">,
  termDays: number,
): number {
  return calculateCreditLifePremiumPeriodsForSchedule(
    calculator.schedule.length,
    termDays,
  )
}

export function calculatePasqTotalCostOfCreditCents(args: {
  calculator: Pick<
    AffordabilityCalculatorEvidence,
    "principalCents" | "totalInterestCents" | "serviceFeesCents" | "initiationFeeCents"
  >
  creditLifeTotalPremiumCents: number
}): number {
  const total =
    args.calculator.principalCents
    + args.calculator.totalInterestCents
    + args.calculator.serviceFeesCents
    + args.calculator.initiationFeeCents
    + args.creditLifeTotalPremiumCents
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError("PASQ total cost of credit is outside the supported cents range")
  }
  return total
}

export function createPasqBillingEvidence(args: {
  calculator: AffordabilityCalculatorEvidence
  election: CreditLifeElection
  monthlyPremiumCents: number
  premiumPeriods: number
  /** False only when no credit-life cover was offered, so no premium exists. */
  offered?: boolean
}): PasqBillingEvidence {
  const offered = args.offered ?? true
  if (
    !calculatorEvidenceIsIntact(args.calculator)
    || !Number.isSafeInteger(args.monthlyPremiumCents)
    || (offered ? args.monthlyPremiumCents <= 0 : args.monthlyPremiumCents !== 0)
    || !Number.isSafeInteger(args.premiumPeriods)
    || args.premiumPeriods <= 0
  ) {
    throw new RangeError("PASQ billing evidence is outside the supported range")
  }
  const premiums = creditLifePremiumsByInstallment({
    scheduleLength: args.calculator.schedule.length,
    premiumPeriods: args.premiumPeriods,
    monthlyPremiumCents: args.monthlyPremiumCents,
    accepted: args.election === "ACCEPTED",
  })
  const schedule = args.calculator.schedule.map((item, index) => {
    const creditLifePremiumDueCents = premiums[index]
    const feesDueCents = item.feesDueCents + creditLifePremiumDueCents
    const totalDueCents = item.totalDueCents + creditLifePremiumDueCents
    if (
      !Number.isSafeInteger(feesDueCents)
      || !Number.isSafeInteger(totalDueCents)
    ) {
      throw new RangeError("PASQ billing schedule is outside the supported cents range")
    }
    return {
      installmentNo: item.installmentNo,
      dueDate: item.dueDate,
      principalDueCents: item.principalDueCents,
      interestDueCents: item.interestDueCents,
      baseFeesDueCents: item.feesDueCents,
      creditLifePremiumDueCents,
      feesDueCents,
      totalDueCents,
      openingBalanceCents: item.openingBalanceCents,
      closingBalanceCents: item.closingBalanceCents,
    }
  })
  const totalRepayableCents = schedule.reduce((sum, item) => {
    const next = sum + item.totalDueCents
    if (!Number.isSafeInteger(next)) {
      throw new RangeError("PASQ total repayment is outside the supported cents range")
    }
    return next
  }, 0)
  const recurringPaymentCents =
    args.calculator.recurringInstalmentCents + Math.max(0, ...premiums)
  if (!Number.isSafeInteger(recurringPaymentCents)) {
    throw new RangeError("PASQ recurring payment exceeds the supported cents range")
  }
  return {
    version: PASQ_BILLING_VERSION,
    collectionMethod: "INCLUDED_IN_LOAN_REPAYMENT",
    recurringPaymentCents,
    totalRepayableCents,
    schedule,
  }
}

export function createPasqEvidence(input: CreatePasqEvidenceInput): PasqEvidence {
  if (!calculatorEvidenceIsIntact(input.calculator)) {
    throw new TypeError("PASQ requires intact calculator evidence")
  }
  const premiumPeriods = calculateCreditLifePremiumPeriods(input.calculator, input.termDays)
  const totalPremiumCents = input.creditLife.election === "ACCEPTED"
    ? input.creditLife.monthlyPremiumCents * premiumPeriods
    : 0
  const offered =
    input.creditLife.disclosureVersion !== CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION
  if (
    !Number.isSafeInteger(input.creditLife.monthlyPremiumCents)
    || !Number.isSafeInteger(totalPremiumCents)
    // An offer must carry a real quoted premium; a no-offer disclosure must
    // carry none at all, and can only ever be a decline.
    || (offered && input.creditLife.monthlyPremiumCents <= 0)
    || (!offered && input.creditLife.monthlyPremiumCents !== 0)
    || (!offered && input.creditLife.election !== "DECLINED")
  ) {
    throw new RangeError("PASQ credit-life premium is invalid")
  }
  if (
    offered !== (input.creditLife.productId !== null)
    || offered !== (input.creditLife.productName !== null)
    || offered !== (input.creditLife.insurerId !== null)
    || offered !== (input.creditLife.insurerName !== null)
  ) {
    throw new TypeError("PASQ credit-life offer identity does not match its disclosure version")
  }
  const billing = createPasqBillingEvidence({
    calculator: input.calculator,
    election: input.creditLife.election,
    monthlyPremiumCents: input.creditLife.monthlyPremiumCents,
    premiumPeriods,
    offered,
  })
  const withoutHash = {
    version: PASQ_VERSION,
    tenantId: input.tenantId,
    applicationId: input.applicationId,
    clientId: input.clientId,
    productId: input.productId,
    termDays: input.termDays,
    generatedAt: input.generatedAt.toISOString(),
    calculator: input.calculator,
    creditLife: {
      ...input.creditLife,
      premiumPeriods,
      totalPremiumCents,
    },
    billing,
    totalCostOfCreditCents: calculatePasqTotalCostOfCreditCents({
      calculator: input.calculator,
      creditLifeTotalPremiumCents: totalPremiumCents,
    }),
  } as const
  return {
    ...withoutHash,
    evidenceSha256: pasqEvidenceSha256(withoutHash),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Order-independent JSON encoding.
 *
 * PostgreSQL `jsonb` does NOT preserve object key order — it stores keys sorted
 * by length, then bytewise. So evidence written as
 *   {version, collectionMethod, recurringPaymentCents, totalRepayableCents, schedule}
 * reads back as
 *   {version, schedule, collectionMethod, totalRepayableCents, recurringPaymentCents}
 * and a plain JSON.stringify comparison against freshly-recomputed evidence
 * fails for every stored PASQ, even when every value is identical. Comparing
 * canonically keeps the check meaningful — it still detects any changed VALUE,
 * which is what the integrity check is actually for.
 */

function isIsoInstant(value: unknown): value is string {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value
}

/**
 * A no-offer disclosure must carry NO product/insurer identity and a zero
 * premium; an offer disclosure must carry all four, non-blank. Anything in
 * between is a corrupted record and must fail closed.
 */
function creditLifeEvidenceIdentityIsIntact(
  creditLife: PasqEvidence["creditLife"],
): boolean {
  if (creditLife.disclosureVersion === CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION) {
    return (
      creditLife.election === "DECLINED"
      && creditLife.productId === null
      && creditLife.productName === null
      && creditLife.insurerId === null
      && creditLife.insurerName === null
      && creditLife.monthlyPremiumCents === 0
      && creditLife.totalPremiumCents === 0
    )
  }
  return (
    creditLife.disclosureVersion === CREDIT_LIFE_DISCLOSURE_VERSION
    && typeof creditLife.productId === "string"
    && creditLife.productId.trim() !== ""
    && typeof creditLife.productName === "string"
    && creditLife.productName.trim() !== ""
    && typeof creditLife.insurerId === "string"
    && creditLife.insurerId.trim() !== ""
    && typeof creditLife.insurerName === "string"
    && creditLife.insurerName.trim() !== ""
  )
}

export function pasqEvidenceIsIntact(value: unknown): value is PasqEvidence {
  if (
    !isRecord(value)
    || !isRecord(value.creditLife)
    || !isRecord(value.calculator)
    || !isRecord(value.billing)
  ) {
    return false
  }
  const evidence = value as unknown as PasqEvidence
  if (
    evidence.version !== PASQ_VERSION
    || typeof evidence.tenantId !== "string"
    || evidence.tenantId.trim() === ""
    || typeof evidence.applicationId !== "string"
    || evidence.applicationId.trim() === ""
    || typeof evidence.clientId !== "string"
    || evidence.clientId.trim() === ""
    || typeof evidence.productId !== "string"
    || evidence.productId.trim() === ""
    || !Number.isSafeInteger(evidence.termDays)
    || evidence.termDays <= 0
    || !isIsoInstant(evidence.generatedAt)
    || !calculatorEvidenceIsIntact(evidence.calculator)
    || !isCreditLifeElection(evidence.creditLife.election)
    || !creditLifeEvidenceIdentityIsIntact(evidence.creditLife)
    || !Number.isSafeInteger(evidence.creditLife.monthlyPremiumCents)
    || evidence.creditLife.monthlyPremiumCents < 0
    || !Number.isSafeInteger(evidence.creditLife.premiumPeriods)
    || evidence.creditLife.premiumPeriods <= 0
    || !Number.isSafeInteger(evidence.creditLife.totalPremiumCents)
    || evidence.creditLife.totalPremiumCents < 0
    || !/^[0-9a-f]{64}$/.test(evidence.creditLife.disclosureSha256)
    || evidence.billing.version !== PASQ_BILLING_VERSION
    || evidence.billing.collectionMethod !== "INCLUDED_IN_LOAN_REPAYMENT"
    || !Number.isSafeInteger(evidence.billing.recurringPaymentCents)
    || evidence.billing.recurringPaymentCents < 0
    || !Number.isSafeInteger(evidence.billing.totalRepayableCents)
    || evidence.billing.totalRepayableCents < 0
    || !Array.isArray(evidence.billing.schedule)
    || !Number.isSafeInteger(evidence.totalCostOfCreditCents)
    || evidence.totalCostOfCreditCents < 0
    || !/^[0-9a-f]{64}$/.test(evidence.evidenceSha256)
  ) {
    return false
  }
  const expectedPeriods = calculateCreditLifePremiumPeriods(evidence.calculator, evidence.termDays)
  const expectedPremium = evidence.creditLife.election === "ACCEPTED"
    ? evidence.creditLife.monthlyPremiumCents * expectedPeriods
    : 0
  const offered =
    evidence.creditLife.disclosureVersion !== CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION
  const expectedDisclosureHash = offered
    ? createCreditLifeDisclosureSha256({
        version: CREDIT_LIFE_DISCLOSURE_VERSION,
        election: evidence.creditLife.election,
        principalCents: evidence.calculator.principalCents,
        termDays: evidence.termDays,
        monthlyPremiumCents: evidence.creditLife.monthlyPremiumCents,
        productId: evidence.creditLife.productId ?? "",
        productName: evidence.creditLife.productName ?? "",
        insurerId: evidence.creditLife.insurerId ?? "",
        insurerName: evidence.creditLife.insurerName ?? "",
      })
    : createCreditLifeNoOfferDisclosureSha256({
        version: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
        election: "DECLINED",
        principalCents: evidence.calculator.principalCents,
        termDays: evidence.termDays,
      })
  const { evidenceSha256, ...withoutHash } = evidence
  let expectedBilling: PasqBillingEvidence
  try {
    expectedBilling = createPasqBillingEvidence({
      offered,
      calculator: evidence.calculator,
      election: evidence.creditLife.election,
      monthlyPremiumCents: evidence.creditLife.monthlyPremiumCents,
      premiumPeriods: expectedPeriods,
    })
  } catch {
    return false
  }
  return (
    evidence.creditLife.premiumPeriods === expectedPeriods
    && evidence.creditLife.totalPremiumCents === expectedPremium
    && evidence.creditLife.disclosureSha256 === expectedDisclosureHash
    && evidence.totalCostOfCreditCents === calculatePasqTotalCostOfCreditCents({
      calculator: evidence.calculator,
      creditLifeTotalPremiumCents: expectedPremium,
    })
    && canonicalJson(evidence.billing) === canonicalJson(expectedBilling)
    && evidenceSha256 === pasqEvidenceSha256(withoutHash)
  )
}

export interface StoredPasqBinding {
  clientId: unknown
  pasqVersion: unknown
  pasqGeneratedAt: unknown
  pasqDocumentId: unknown
  pasqDocumentSha256: unknown
  pasqEvidence: unknown
  pasqEvidenceSha256: unknown
  pasqAcknowledgedAt: unknown
  pasqAcknowledgedBy: unknown
  pasqAcknowledgedSha256: unknown
  approvedPasqDocumentSha256: unknown
}

export type VerifiedPasqBinding =
  | { ok: true; evidence: PasqEvidence; documentId: string; documentSha256: string }
  | {
      ok: false
      reason:
        | "missing"
        | "evidence_changed"
        | "not_client_acknowledged"
        | "acknowledgement_changed"
        | "approval_binding_missing"
    }

export function verifyStoredPasqBinding(
  stored: StoredPasqBinding,
  expected: {
    tenantId: string
    applicationId: string
    clientId: string
    productId: string
    calculatorPricingFingerprint: string
    creditLifeDisclosureSha256: string
    /**
     * Agreement preparation may use an intact issued PASQ before the consumer
     * signs. Every signing, countersigning, and payout path keeps the default
     * and therefore requires the exact client acknowledgement.
     */
    requireAcknowledgement?: boolean
    requireApprovalBinding?: boolean
  },
): VerifiedPasqBinding {
  if (
    stored.pasqVersion !== PASQ_VERSION
    || !(stored.pasqGeneratedAt instanceof Date)
    || typeof stored.pasqDocumentId !== "string"
    || stored.pasqDocumentId.trim() === ""
    || typeof stored.pasqDocumentSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(stored.pasqDocumentSha256)
    || typeof stored.pasqEvidenceSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(stored.pasqEvidenceSha256)
    || !pasqEvidenceIsIntact(stored.pasqEvidence)
  ) {
    return { ok: false, reason: "missing" }
  }
  const evidence = stored.pasqEvidence
  if (
    stored.pasqGeneratedAt.toISOString() !== evidence.generatedAt
    || stored.pasqEvidenceSha256 !== evidence.evidenceSha256
    || evidence.tenantId !== expected.tenantId
    || evidence.applicationId !== expected.applicationId
    || evidence.clientId !== expected.clientId
    || evidence.productId !== expected.productId
    || evidence.calculator.pricingFingerprint !== expected.calculatorPricingFingerprint
    || evidence.creditLife.disclosureSha256 !== expected.creditLifeDisclosureSha256
  ) {
    return { ok: false, reason: "evidence_changed" }
  }
  const acknowledgementFields = [
    stored.pasqAcknowledgedAt,
    stored.pasqAcknowledgedBy,
    stored.pasqAcknowledgedSha256,
    stored.approvedPasqDocumentSha256,
  ]
  const hasAnyAcknowledgement = acknowledgementFields.some((value) => value !== null)
  const requireAcknowledgement = expected.requireAcknowledgement ?? true
  if (!hasAnyAcknowledgement && !requireAcknowledgement) {
    return {
      ok: true,
      evidence,
      documentId: stored.pasqDocumentId,
      documentSha256: stored.pasqDocumentSha256,
    }
  }
  if (
    !(stored.pasqAcknowledgedAt instanceof Date)
    || typeof stored.pasqAcknowledgedBy !== "string"
    || stored.pasqAcknowledgedBy !== expected.clientId
    || stored.clientId !== expected.clientId
  ) {
    return { ok: false, reason: "not_client_acknowledged" }
  }
  if (
    stored.pasqAcknowledgedSha256 !== stored.pasqDocumentSha256
    || stored.pasqAcknowledgedAt < stored.pasqGeneratedAt
  ) {
    return { ok: false, reason: "acknowledgement_changed" }
  }
  if (
    expected.requireApprovalBinding
    && stored.approvedPasqDocumentSha256 !== stored.pasqDocumentSha256
  ) {
    return { ok: false, reason: "approval_binding_missing" }
  }
  return {
    ok: true,
    evidence,
    documentId: stored.pasqDocumentId,
    documentSha256: stored.pasqDocumentSha256,
  }
}
