import { Prisma } from "@prisma/client"
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ application: vi.fn(), verifyLocked: vi.fn(), kyc: vi.fn(), statement: vi.fn(), verification: vi.fn(), problem: vi.fn(), screening: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { loanApplication: { findFirst: h.application } } }))
vi.mock("@/lib/approval/progress", () => ({ approvalStepApproverIds: async () => [] }))
vi.mock("@/lib/affordability/current-approval", () => ({ verifyLockedCurrentAffordabilityApproval: h.verifyLocked }))
vi.mock("@/lib/compliance/debit-mandate.server", async (original) => ({ ...(await original<typeof import("@/lib/compliance/debit-mandate.server")>()), findVerifiedBankStatementForMandate: h.statement }))
vi.mock("@/lib/kyc/document-state", () => ({ readCompositeKycState: h.kyc }))
vi.mock("@/lib/screening/gate", () => ({ readBorrowerScreening: async () => ({ allowed: true }), lockedBorrowerScreeningAllows: h.screening }))
vi.mock("@/lib/security/segregation-of-duties", () => ({ SEGREGATION_OF_DUTIES_REFUSALS: {}, isSegregationOfDutiesRequired: async () => true, segregationOfDutiesConflict: () => null }))
vi.mock("./payout-account", () => ({ currentPayoutVerification: h.verification }))
vi.mock("./state", () => ({ documentProblem: h.problem }))

import { CHANGED, payoutGates, payoutPreconditions, payoutRefusalFrom, Refused } from "./payout-gates"

const subject = { tenantId: "t1", applicationId: "a1", user: { id: "u1", email: "u@test.invalid" } }
const scope = { ...subject, clientId: "c1", segregation: true }
const client = { id: "c1", kycStatus: "VERIFIED", bankName: "Demo Bank Lesotho", bankAccountNumber: "62000012345", bankBranchCode: "100001", accountType: "CHEQUE", createdByDealerId: null, dealerContactVerifiedAt: null }
const current = { repaymentMethod: "EFT", agreementSignedAt: new Date(), approvedById: "a2", updatedAt: new Date(), client }
const today = { calculator: { startDate: new Date().toISOString() } }

function tx(row: object | null = current) {
  return { $queryRaw: vi.fn().mockResolvedValue([]), loanApplication: { findFirst: vi.fn().mockResolvedValue(row) } } as never
}
const refusal = async (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as Refused).refusal)

describe("the gates a real row cannot reach, held anyway", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.application.mockResolvedValue({ status: "APPROVED", disclosureRegime: "KEY_FACTS", clientId: "c1", approvedBy: null })
    h.verifyLocked.mockResolvedValue({ ok: true, approval: today, calculation: { schedule: [] } })
    h.screening.mockResolvedValue(true)
    h.problem.mockResolvedValue(null)
    h.kyc.mockResolvedValue({ ok: true })
    h.statement.mockResolvedValue({ ok: true, evidence: { documentId: "d1" } })
    h.verification.mockResolvedValue({ ok: true, avsCheckId: "v1", verifiedById: "second" })
  })

  it("an NCA application is not this route's", async () => {
    h.application.mockResolvedValue({ status: "APPROVED", disclosureRegime: "NCA_PASQ", clientId: "c1" })
    expect(await payoutPreconditions(subject)).toMatchObject({ ok: false, status: 409, precondition: "regime" })
  })

  it("passes a complete row", async () => {
    expect(await payoutGates(tx(), scope)).toMatchObject({ repaymentMethod: "EFT", bank: { accountNo: "62000012345" } })
  })

  it("an application that left APPROVED under the lock is a 409 changed, not an affordability refusal", async () => {
    h.verifyLocked.mockResolvedValue({ ok: false, reason: "application_changed" })
    expect(await refusal(payoutGates(tx(), scope))).toEqual(CHANGED)
    h.verifyLocked.mockResolvedValue({ ok: true, approval: today, calculation: { schedule: [] } })
    expect(await refusal(payoutGates(tx(null), scope))).toEqual(CHANGED)
  })

  it("refuses KYC on the read under the document locks, whichever half fell", async () => {
    expect(await refusal(payoutGates(tx({ ...current, client: { ...client, kycStatus: "PENDING" } }), scope))).toMatchObject({ precondition: "composite_kyc" })
    h.kyc.mockResolvedValue({ ok: false })
    expect(await refusal(payoutGates(tx(), scope))).toMatchObject({ precondition: "composite_kyc" })
  })

  it("refuses a bank record the statement matcher cannot read, and a repayment method that is not EFT", async () => {
    expect(await refusal(payoutGates(tx({ ...current, client: { ...client, accountType: "TRANSMISSION" } }), scope))).toMatchObject({ precondition: "bank_details_incomplete" })
    expect(await refusal(payoutGates(tx({ ...current, repaymentMethod: "DEBIT_ORDER" }), scope))).toMatchObject({ precondition: "repayment_method" })
  })
})

describe("what an error from the payout transaction amounts to", () => {
  it("a database refusal says what the database said; a fault stays a fault", () => {
    const guard = new Prisma.PrismaClientUnknownRequestError('PostgresError { code: "23514", message: "A guard said no", severity: "ERROR" }', { clientVersion: "5" })
    expect(payoutRefusalFrom(guard)).toMatchObject({ status: 422, precondition: "database_guard", error: "Cannot disburse: A guard said no" })
    const fault = new Error("boom")
    expect(() => payoutRefusalFrom(fault)).toThrow(fault)
  })
})
