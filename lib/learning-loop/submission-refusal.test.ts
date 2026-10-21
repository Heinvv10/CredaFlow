import { beforeEach, describe, expect, it, vi } from "vitest"

const { txAudit, txRecord, appAudit, transaction } = vi.hoisted(() => ({
  txAudit: vi.fn(),
  txRecord: vi.fn(),
  appAudit: vi.fn(),
  transaction: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => transaction(cb),
    auditLog: { create: (a: unknown) => appAudit(a) },
  },
}))

import { recordData } from "./decision-log"
import {
  SUBMISSION_REFUSAL_REASONS,
  isSubmissionRefusalReason,
  recordSubmissionRefusal,
  submissionRefusalRecord,
  type SubmissionRefusal,
} from "./submission-refusal"

const decidedAt = new Date("2026-10-21T08:00:00.000Z")
const refusal = (over: Partial<SubmissionRefusal> = {}): SubmissionRefusal => ({
  tenantId: "tenant-1", channel: "PORTAL", reason: "client_blacklisted", subject: { clientId: "client-1" }, decidedAt, ...over,
})
// Synthetic values only; none may reach the record.
const audit = {
  tenantId: "tenant-1",
  userEmail: "synthetic.applicant@test.invalid",
  action: "APPLICATION_SUBMISSION_BLOCKED",
  entity: "LoanApplication",
  newValue: { reason: "client_blacklisted", clientId: "client-1", requestedAmount: 1_234_567, idNumber: "0000000000000" },
  ipAddress: "192.0.2.10",
}

describe("submissionRefusalRecord", () => {
  it("is an automated decline the gates blocked, flagged for the s71 legal review, overriding nothing", () => {
    expect(recordData(submissionRefusalRecord(refusal()))).toMatchObject({
      kind: "CREDIT_DECISION",
      decision: "DECLINE",
      recommendation: "BLOCK",
      overridden: false,
      overrideReason: null,
      actorType: "SYSTEM",
      actorUserId: null,
      actorRole: null,
      clientId: "client-1",
      leadId: null,
      applicationId: null,
      sourceEntityType: "Client",
      sourceEntityId: "client-1",
      ruleVersion: "decision-log-v1+submission-refusal-v1",
      s71ReviewRequired: true,
      decidedAt,
    })
  })

  it.each(Object.entries(SUBMISSION_REFUSAL_REASONS))("stores reason %s as class %s, and nothing else", (reason, refusalClass) => {
    if (!isSubmissionRefusalReason(reason)) throw new Error(reason)
    const data = recordData(submissionRefusalRecord(refusal({ channel: "WEBSITE", reason })))
    expect(data.inputsSnapshot).toEqual({ channel: "WEBSITE", refusalReason: reason, refusalClass, automated: true })
    expect(data.evidenceRefs).toEqual({ auditAction: "APPLICATION_SUBMISSION_BLOCKED" })
  })

  it("names the lead when no client is confirmed, and keeps a collided application as evidence, not the subject", () => {
    expect(recordData(submissionRefusalRecord(refusal({ reason: "identity_conflict", subject: { leadId: "lead-1" } })))).toMatchObject({
      clientId: null, leadId: "lead-1", sourceEntityType: "Lead", sourceEntityId: "lead-1",
    })
    const dup = recordData(submissionRefusalRecord(refusal({ reason: "open_application_exists", existingApplicationId: "app-open" })))
    expect(dup.applicationId).toBeNull()
    expect(dup.evidenceRefs).toEqual({ auditAction: "APPLICATION_SUBMISSION_BLOCKED", existingApplicationId: "app-open" })
  })

  it("classes the credit-standing and affordability refusals as CREDIT and the rest as PROCESS", () => {
    const credit = Object.entries(SUBMISSION_REFUSAL_REASONS).filter(([, c]) => c === "CREDIT").map(([r]) => r).sort()
    expect(credit).toEqual(["client_blacklisted", "client_deceased", "expense_evidence_invalid", "mle_justification_missing", "own_lender_arrears"])
    expect(isSubmissionRefusalReason("toString")).toBe(false)
  })
})

describe("recordSubmissionRefusal", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) =>
      cb({ auditLog: { create: txAudit }, creditDecisionRecord: { create: txRecord } }))
  })

  it("writes the audit row and the decision record in one transaction, the audit unchanged", async () => {
    await recordSubmissionRefusal(audit, refusal())
    expect(transaction).toHaveBeenCalledOnce()
    expect(txAudit).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "APPLICATION_SUBMISSION_BLOCKED", newValue: audit.newValue }) })
    expect(txRecord).toHaveBeenCalledOnce()
    expect(appAudit).not.toHaveBeenCalled()
    // The record holds none of the request's personal or exact values.
    const stored = JSON.stringify(txRecord.mock.calls[0][0])
    for (const value of ["synthetic.applicant", "1234567", "0000000000000", "192.0.2.10"]) expect(stored).not.toContain(value)
  })

  it("logs a failed record and still writes the audit row alone, never failing the refusal", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    txRecord.mockRejectedValue(new Error("record insert failed"))
    await expect(recordSubmissionRefusal(audit, refusal())).resolves.toBeUndefined()
    expect(appAudit).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "APPLICATION_SUBMISSION_BLOCKED" }) })
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("[learning-loop] automated refusal record failed"),
      { tenantId: "tenant-1", channel: "PORTAL", reason: "client_blacklisted" },
      expect.any(Error),
    )
    error.mockRestore()
  })

  it("throws on a strict site, as logAuditStrict did, and writes nothing outside the transaction", async () => {
    txRecord.mockRejectedValue(new Error("record insert failed"))
    await expect(recordSubmissionRefusal(audit, refusal(), { strict: true })).rejects.toThrow("record insert failed")
    expect(appAudit).not.toHaveBeenCalled()
  })
})
