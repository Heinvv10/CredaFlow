import { describe, expect, it } from "vitest"
import { recordData, type DecisionRecordInput } from "./decision-log"
import {
  consumerApprovalRecords,
  consumerDeclineRecord,
  consumerReturnRecord,
  creditCheckClearRecord,
  quotationIssuedRecord,
  type ConsumerApprovalFacts,
} from "./records"
import { assetFinanceDecisionRecords, type AssetFinanceDecisionFacts } from "./records-asset-finance"

// Obviously synthetic personal data. Each builder is handed rows carrying it
// (as a route might pass a whole row); none of it may reach a stored column.
const PII = {
  idNumber: "0001015800099",
  firstName: "Testfirst",
  lastName: "Testlast",
  email: "synthetic.person@example.invalid",
  phone: "0820000001",
  accountNumber: "99887766554433",
  bankName: "Synthetic Bank",
  address: "1 Nowhere Lane",
}
const BUREAU_PAYLOAD = { rawReport: "SYNTHETIC-BUREAU-PAYLOAD-7f3a", accounts: [{ creditor: "SYNTHETIC-CREDITOR", balance: 12345 }] }
const SENTINELS = [...Object.values(PII), "SYNTHETIC-BUREAU-PAYLOAD-7f3a", "SYNTHETIC-CREDITOR"]

function stored(records: DecisionRecordInput[]): string {
  return JSON.stringify(records.map(recordData))
}
function expectNoPii(records: DecisionRecordInput[]) {
  const text = stored(records)
  for (const value of SENTINELS) expect(text, `leaked ${value}`).not.toContain(value)
  // Exact money never lands in the snapshot: only bands.
  for (const r of records.map(recordData)) {
    expect(JSON.stringify(r.inputsSnapshot)).not.toMatch(/Cents/)
  }
}

const decidedAt = new Date("2026-10-21T08:00:00.000Z")
const actor = { userId: "user-1", role: "LOAN_ADMIN" }
const fingerprint = (c: string) => c.repeat(64)

const bureauRow = {
  id: "bureau-1",
  provider: "experian",
  score: 612,
  unscoreable: false,
  hasAdverse: false,
  deceased: false,
  underDebtReview: false,
  hasJudgement: false,
  hasNotice: false,
  obligations: { totalMonthly: 150000, ...BUREAU_PAYLOAD },
  // What else a CreditBureauCheck row holds: never read.
  ...PII,
}

function approval(over: Partial<ConsumerApprovalFacts> = {}): ConsumerApprovalFacts {
  return {
    tenantId: "tenant-a",
    applicationId: "app-1",
    clientId: "client-1",
    actor,
    decidedAt,
    productType: "PERSONAL",
    interestRatePm: 0.05,
    principalCents: 1_500_000,
    termDays: 180,
    instalmentCents: 310_000,
    creditLifePremiumCents: 4_500,
    repaymentMethod: "DEBIT_ORDER",
    monthlyIncomeCents: 2_500_000,
    thresholds: { bureauMinScore: 580, bureauBlockAdverse: true, ndiBufferPct: 110, bureauMaxAgeDays: 60 },
    bureau: bureauRow,
    bureauGateBlocked: false,
    bureauOverrideReason: null,
    affordability: { ndiCents: 600_000, requiredNdiCents: 341_000 },
    screeningState: "CLEAR",
    creditCheckFlags: [
      { id: "flag-2", check: "STATEMENTS", code: "GAMBLING", status: "CLEARED", ...PII } as never,
      { id: "flag-1", check: "PAYSLIP", code: "SALARY_MISMATCH", status: "CLEARED" },
    ],
    affordabilitySnapshot: { policyVersion: "approval-ndi-v3", inputFingerprint: fingerprint("a"), decisionFingerprint: fingerprint("b") },
    ...over,
  }
}

describe("consumer approval records", () => {
  it("writes the credit decision and the offer of the approved terms, banded, with references", () => {
    const [decision, offer] = consumerApprovalRecords(approval())
    expect(recordData(decision)).toMatchObject({
      tenantId: "tenant-a",
      kind: "CREDIT_DECISION",
      decision: "APPROVE",
      recommendation: "PASS",
      overridden: false,
      overrideReason: null,
      actorType: "STAFF",
      actorUserId: "user-1",
      actorRole: "LOAN_ADMIN",
      applicationId: "app-1",
      clientId: "client-1",
      sourceEntityType: "LoanApplication",
      sourceEntityId: "app-1",
      ruleVersion: "decision-log-v1+approval-ndi-v3",
      modelVersion: null,
      predictedProbability: null,
      inputsSnapshot: {
        productType: "PERSONAL",
        amountBand: "10000-24999",
        termDays: 180,
        incomeBand: "20000-39999",
        bureau: { gate: "PASS", blockCode: null, scoreBand: "580-629", provider: "experian", overridden: false },
        affordability: { gate: "PASS", ndiCoverBand: "1.50-1.99" },
        creditChecks: { cleared: 2, clearedCodes: ["PAYSLIP:SALARY_MISMATCH", "STATEMENTS:GAMBLING"] },
        screening: "CLEAR",
        thresholds: { bureauMinScore: 580, bureauBlockAdverse: true, ndiBufferPct: 110, bureauMaxAgeDays: 60 },
      },
      evidenceRefs: {
        bureauCheckId: "bureau-1",
        affordabilityInputFingerprint: fingerprint("a"),
        affordabilityDecisionFingerprint: fingerprint("b"),
        creditCheckFlagIds: ["flag-1", "flag-2"],
      },
    })
    expect(recordData(offer)).toMatchObject({
      kind: "OFFER",
      decision: "APPROVED_TERMS",
      recommendation: "NONE",
      overridden: false,
      inputsSnapshot: { amountBand: "10000-24999", termDays: 180, interestRatePm: 0.05, instalmentBand: "2500-4999", creditLife: true, repaymentMethod: "DEBIT_ORDER" },
    })
  })

  it("stores no identifier, name, contact, bank detail or bureau payload", () => {
    expectNoPii(consumerApprovalRecords(approval()))
    expectNoPii(consumerApprovalRecords(approval({ bureauGateBlocked: true, bureauOverrideReason: "Reviewed the bureau report by hand." })))
  })

  it("an approval past a blocking bureau gate is an override, with the reason and why the gate blocked", () => {
    const [decision, offer] = consumerApprovalRecords(approval({
      bureau: { ...bureauRow, score: 540 },
      bureauGateBlocked: true,
      bureauOverrideReason: "  Score dip from one settled account; verified.  ",
    }))
    expect(recordData(decision)).toMatchObject({
      recommendation: "BLOCK",
      overridden: true,
      overrideReason: "Score dip from one settled account; verified.",
      inputsSnapshot: { bureau: { gate: "BLOCK", blockCode: "BELOW_MIN_SCORE", scoreBand: "530-579", overridden: true } },
    })
    expect(recordData(offer)).toMatchObject({ overridden: false, overrideReason: null })
  })

  it("an approval with no bureau check is an override of the missing check", () => {
    const [decision] = consumerApprovalRecords(approval({ bureau: null, bureauGateBlocked: null, bureauOverrideReason: "Bureau unavailable; manual s81 file." }))
    expect(recordData(decision)).toMatchObject({
      recommendation: "BLOCK",
      overridden: true,
      inputsSnapshot: { bureau: { gate: "MISSING", blockCode: "BUREAU_MISSING", scoreBand: null } },
      evidenceRefs: { bureauCheckId: null },
    })
  })

  it("an override reason given where the gate passed is not an override", () => {
    const [decision] = consumerApprovalRecords(approval({ bureauOverrideReason: "Belt and braces note here." }))
    expect(recordData(decision)).toMatchObject({ recommendation: "PASS", overridden: false, overrideReason: null })
  })

  it("names the gate's block OTHER when the code cannot say why", () => {
    // The route's gate is the authority; a verdict the mirror does not reproduce still records the override.
    const [decision] = consumerApprovalRecords(approval({ bureauGateBlocked: true, bureauOverrideReason: "Gate verdict reviewed." }))
    expect(recordData(decision).inputsSnapshot).toMatchObject({ bureau: { blockCode: "OTHER" } })
  })

  it("hashes the exact inputs: the same facts give the same hash, any change another", () => {
    const [a] = consumerApprovalRecords(approval())
    const [b] = consumerApprovalRecords(approval({ creditCheckFlags: [...approval().creditCheckFlags].reverse() }))
    const [c] = consumerApprovalRecords(approval({ monthlyIncomeCents: 2_500_001 }))
    expect(recordData(a).inputsHash).toMatch(/^[0-9a-f]{64}$/)
    expect(recordData(b).inputsHash).toBe(recordData(a).inputsHash)
    // R0.01 more income is the same band, but not the same input.
    expect(recordData(c).inputsSnapshot).toEqual(recordData(a).inputsSnapshot)
    expect(recordData(c).inputsHash).not.toBe(recordData(a).inputsHash)
  })

  it("hashes the tenant's thresholds into the policy hash", () => {
    const [a] = consumerApprovalRecords(approval())
    const [b] = consumerApprovalRecords(approval({ thresholds: { ...approval().thresholds, bureauMinScore: 600 } }))
    expect(recordData(a).policyHash).toMatch(/^[0-9a-f]{64}$/)
    expect(recordData(b).policyHash).not.toBe(recordData(a).policyHash)
  })
})

describe("other consumer events", () => {
  const subject = { tenantId: "tenant-a", applicationId: "app-1", clientId: "client-1", actor, decidedAt, ...PII }

  it("a decline records its category, no gate and none of the reason text", () => {
    const record = consumerDeclineRecord({ ...subject, declineCategory: "AFFORDABILITY", reason: PII.firstName } as never)
    expect(recordData(record)).toMatchObject({ decision: "DECLINE", recommendation: "NONE", overridden: false, inputsSnapshot: { declineCategory: "AFFORDABILITY" } })
    expectNoPii([record])
  })

  it("returns to review and to draft", () => {
    expect(recordData(consumerReturnRecord({ ...subject, to: "REVIEW", priorStatus: "APPROVED" }))).toMatchObject({ decision: "RETURN_TO_REVIEW", recommendation: "NONE" })
    expect(recordData(consumerReturnRecord({ ...subject, to: "DRAFT", priorStatus: "UNDER_REVIEW" }))).toMatchObject({ decision: "RETURN_TO_DRAFT", inputsSnapshot: { priorStatus: "UNDER_REVIEW" } })
    expectNoPii([consumerReturnRecord({ ...subject, to: "DRAFT", priorStatus: "UNDER_REVIEW" })])
  })

  it("a cleared credit check is the person overriding a referral, with the reason", () => {
    const record = creditCheckClearRecord({
      ...subject, clientId: null, flagId: "flag-1", check: "STATEMENTS", code: "GAMBLING",
      reason: "Two small bets in six months; not material.", policyVersion: "credit-checks-unversioned",
    })
    expect(recordData(record)).toMatchObject({
      decision: "CLEAR_FLAG", recommendation: "REFER", overridden: true, overrideReason: "Two small bets in six months; not material.",
      sourceEntityType: "ApplicationCheckFlag", sourceEntityId: "flag-1", applicationId: "app-1", clientId: null,
      inputsSnapshot: { check: "STATEMENTS", code: "GAMBLING" },
    })
    expectNoPii([record])
  })

  it("the PASQ issued at signing is an offer, banded, referencing the document", () => {
    const record = quotationIssuedRecord({
      ...subject, documentSha256: fingerprint("d"), evidenceSha256: fingerprint("e"), pasqVersion: "pasq-v3",
      termDays: 180, principalCents: 1_500_000, recurringPaymentCents: 314_500, totalCostOfCreditCents: 400_000, creditLifeElection: "ACCEPTED",
    })
    expect(recordData(record)).toMatchObject({
      kind: "OFFER", decision: "QUOTATION_ISSUED", recommendation: "NONE",
      evidenceRefs: { pasqDocumentSha256: fingerprint("d"), pasqEvidenceSha256: fingerprint("e") },
      inputsSnapshot: { amountBand: "10000-24999", termDays: 180, instalmentBand: "2500-4999", creditLifeElection: "ACCEPTED" },
    })
    expectNoPii([record])
  })
})

describe("asset-finance decision records", () => {
  const facts = (over: Partial<AssetFinanceDecisionFacts> = {}): AssetFinanceDecisionFacts => ({
    tenantId: "tenant-a", dealId: "deal-1", applicationId: "app-9", clientId: null, actor, decidedAt,
    decision: "APPROVE", ncaRegime: "NON_NCA", productType: "ASSET_FINANCE", appliedAmountCents: 155_250_000, appliedTermDays: 1826,
    dscr: 1.8, gearing: 0.25, creditMemo: true, s81Affordable: null,
    exceptionKinds: [], exceptionsFingerprint: null, exceptionReason: null,
    ...over,
  })

  it("an approval without exceptions passed every gate, and makes an offer", () => {
    const [decision, offer] = assetFinanceDecisionRecords(facts())
    expect(recordData(decision)).toMatchObject({
      kind: "CREDIT_DECISION", decision: "APPROVE", recommendation: "PASS", overridden: false,
      sourceEntityType: "AssetFinanceDeal", sourceEntityId: "deal-1", applicationId: "app-9", clientId: null,
      inputsSnapshot: { ncaRegime: "NON_NCA", amountBand: "1000000+", dscrBand: "1.5-2", gearingBand: "0.25-0.5", s81: "NOT_APPLICABLE", exceptions: {} },
    })
    expect(recordData(offer)).toMatchObject({ kind: "OFFER", decision: "APPROVED_TERMS" })
  })

  it("an approval past exceptions is an override with the exception reason; exception keys are not stored", () => {
    const [decision] = assetFinanceDecisionRecords(facts({
      exceptionKinds: ["ARREARS", "BUREAU", "ARREARS"], exceptionsFingerprint: fingerprint("f"),
      exceptionReason: "Director's arrears settled last week; proof on file.",
    }))
    expect(recordData(decision)).toMatchObject({
      recommendation: "REFER", overridden: true, overrideReason: "Director's arrears settled last week; proof on file.",
      inputsSnapshot: { exceptions: { ARREARS: 2, BUREAU: 1 } }, evidenceRefs: { exceptionsFingerprint: fingerprint("f") },
    })
  })

  it("a decline and a referral record no gate and make no offer", () => {
    expect(assetFinanceDecisionRecords(facts({ decision: "DECLINE", ncaRegime: "NCA", s81Affordable: false })).map(recordData)).toEqual([
      expect.objectContaining({ decision: "DECLINE", recommendation: "NONE", overridden: false, inputsSnapshot: expect.objectContaining({ s81: "BLOCK", exceptions: null }) }),
    ])
    expect(assetFinanceDecisionRecords(facts({ decision: "REFER" })).map((r) => r.decision)).toEqual(["REFER"])
  })

  it("stores none of the borrower's personal data", () => {
    expectNoPii(assetFinanceDecisionRecords({ ...facts(), ...PII } as never))
  })
})
