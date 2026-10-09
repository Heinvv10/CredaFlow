import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const {
  auth,
  transaction,
  verifyLockedCurrentAffordabilityApproval,
  findVerifiedBankStatementForMandate,
  renderApplicationDebitMandatePdf,
  verifyCurrentStoredDebitMandate,
  applicationFindUnique,
  tenantFindUnique,
  clientUpdate,
  applicationUpdateMany,
  auditLogCreate,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  transaction: vi.fn(),
  verifyLockedCurrentAffordabilityApproval: vi.fn(),
  findVerifiedBankStatementForMandate: vi.fn(),
  renderApplicationDebitMandatePdf: vi.fn(),
  verifyCurrentStoredDebitMandate: vi.fn(),
  applicationFindUnique: vi.fn(),
  tenantFindUnique: vi.fn(),
  clientUpdate: vi.fn(),
  applicationUpdateMany: vi.fn(),
  auditLogCreate: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ auth }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (
    _req: unknown,
    callback: (tenant: { id: string; name: string }) => unknown,
  ) => callback({ id: "tenant-1", name: "Staging Tenant" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: transaction,
    loanApplication: { findUnique: applicationFindUnique },
    tenant: { findUnique: tenantFindUnique },
    clientDocument: { findFirst: vi.fn() },
    documentAccessLog: { create: vi.fn() },
  },
}))
vi.mock("@/lib/affordability/current-approval", () => ({
  verifyLockedCurrentAffordabilityApproval,
}))
vi.mock("@/lib/compliance/debit-mandate.server", () => ({
  debitMandateApplicationArgs: {},
  findVerifiedBankStatementForMandate,
  renderApplicationDebitMandatePdf,
  verifyCurrentStoredDebitMandate,
}))
vi.mock("@/lib/compliance/debit-mandate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/compliance/debit-mandate")>()),
  debitMandateContractTerms: vi.fn().mockReturnValue({
    contractFingerprint: "contract-sha",
    paymentTerms: {
      paymentFrequency: "MONTHLY",
      recurringDebitAmount: 150_000,
      firstDebitAmount: 156_900,
      firstDebitDate: new Date("2026-08-31T00:00:00.000Z"),
      firstDebitInitiationFee: 6_900,
    },
    evidence: {
      paymentFrequency: "MONTHLY",
      recurringDebitAmountCents: 150_000,
      firstDebitAmountCents: 156_900,
      firstDebitDate: "2026-08-31T00:00:00.000Z",
      firstDebitInitiationFeeCents: 6_900,
    },
  }),
}))
vi.mock("@/lib/audit", () => ({
  AuditAction: new Proxy({}, { get: (_target, property) => String(property) }),
}))

const application = {
  id: "app-1",
  tenantId: "tenant-1",
  clientId: "client-1",
  reference: "APP-TEST",
  status: "APPROVED",
  repaymentMethod: "DEBIT_ORDER",
  updatedAt: new Date("2026-07-23T15:00:00.000Z"),
  agreementSignedAt: new Date("2026-07-23T14:00:00.000Z"),
  affordabilityResult: {},
  debitMandatePreparedAt: null,
  debitMandateReference: null,
  debitMandateDraftSha256: null,
  debitMandateEvidence: null,
  debitMandateEvidenceSha256: null,
  debitMandateSignedAt: null,
  client: {
    id: "client-1",
    firstName: "Casey",
    lastName: "Staging",
    idNumber: "9001016000082",
    phone: "0710000000",
    email: "casey@example.test",
    bankName: "Old Bank",
    bankBranchCode: "000000",
    bankAccountNumber: "000000",
    accountType: "SAVINGS",
  },
}

function request(body: unknown) {
  return new NextRequest(
    "https://staging.example.test/api/applications/app-1/debit-mandate",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  )
}

const ctx = { params: Promise.resolve({ id: "app-1" }) }

describe("POST /api/applications/[id]/debit-mandate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-23T16:00:00.000Z"))
    auth.mockResolvedValue({
      user: { id: "client-1", email: "casey@example.test", role: "CLIENT" },
    })
    verifyLockedCurrentAffordabilityApproval.mockResolvedValue({ ok: true })
    applicationFindUnique.mockResolvedValue(application)
    tenantFindUnique.mockResolvedValue({
      id: "tenant-1",
      config: { ncrNumber: "NCRCP00000" },
    })
    clientUpdate.mockResolvedValue({ id: "client-1" })
    applicationUpdateMany.mockResolvedValue({ count: 1 })
    auditLogCreate.mockResolvedValue({ id: "audit-1" })
    findVerifiedBankStatementForMandate.mockResolvedValue({
      ok: true,
      evidence: {
        documentId: "statement-1",
        documentSha256: "d".repeat(64),
        verifiedAt: "2026-07-23T13:00:00.000Z",
      },
    })
    renderApplicationDebitMandatePdf.mockResolvedValue(
      Buffer.from("%PDF-1.4 exact debit mandate draft"),
    )
    transaction.mockImplementation(
      (callback: (tx: unknown) => unknown) => callback({
        loanApplication: {
          findUnique: applicationFindUnique,
          updateMany: applicationUpdateMany,
        },
        tenant: { findUnique: tenantFindUnique },
        client: { update: clientUpdate },
        auditLog: { create: auditLogCreate },
      }),
    )
  })

  it("rejects banking that does not match an integrity-bound verified statement", async () => {
    findVerifiedBankStatementForMandate.mockResolvedValue({
      ok: false,
      reason: "verified_bank_statement_mismatch",
    })
    const { POST } = await import("./route")

    const response = await POST(request({
      bankName: "FNB",
      branchCode: "250655",
      accountNumber: "123456789",
      accountType: "SAVINGS",
    }), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: "The entered bank, account number, or account type does not match a verified bank statement.",
      debitMandate: "verified_bank_statement_mismatch",
    })
    expect(clientUpdate).not.toHaveBeenCalled()
    expect(applicationUpdateMany).not.toHaveBeenCalled()
  })

  it("does not create a debit mandate for an EFT repayment application", async () => {
    applicationFindUnique.mockResolvedValue({
      ...application,
      repaymentMethod: "EFT",
    })
    const { POST } = await import("./route")

    const response = await POST(request({
      bankName: "FNB",
      branchCode: "250655",
      accountNumber: "123456789",
      accountType: "SAVINGS",
    }), ctx)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "This application is approved for EFT repayment and does not require a debit mandate.",
      debitMandate: "repayment_method_eft",
    })
    expect(findVerifiedBankStatementForMandate).not.toHaveBeenCalled()
    expect(applicationUpdateMany).not.toHaveBeenCalled()
  })

  it("returns 400 for malformed JSON instead of leaking a server error", async () => {
    const malformed = new NextRequest(
      "https://staging.example.test/api/applications/app-1/debit-mandate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      },
    )
    const { POST } = await import("./route")

    const response = await POST(malformed, ctx)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "Invalid request body.",
      debitMandate: "invalid_body",
    })
    expect(transaction).not.toHaveBeenCalled()
  })

  it("refuses a consumer swapping one VALID branch code for another", async () => {
    // The branch code is the ONE field on this form that no longer has to match
    // the verified statement (that leg was removed because SA banks use a single
    // universal code and mostly do not print it). So it is the one field a
    // consumer could move freely onto the payout tuple, and from a client
    // session. Every other field here is still bound to the statement.
    //
    // The fixture's stored code is the placeholder "000000", so first make it a
    // usable code — a change from THAT is a genuine correction and is allowed.
    applicationFindUnique.mockResolvedValueOnce({
      ...application,
      client: { ...application.client, bankBranchCode: "250655" },
    })

    const { POST } = await import("./route")
    const response = await POST(request({
      bankName: "FNB",
      branchCode: "470010",
      accountNumber: "123456789",
      accountType: "SAVINGS",
    }), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: expect.stringContaining("branch code on file cannot be changed"),
      debitMandate: "branch_code_change_not_permitted",
    })
    expect(clientUpdate).not.toHaveBeenCalled()
  })

  it("updates only banking fields and records the exact prepared evidence", async () => {
    const { POST } = await import("./route")

    const response = await POST(request({
      bankName: "FNB",
      branchCode: "250655",
      accountNumber: "123456789",
      accountType: "SAVINGS",
    }), ctx)

    expect(response.status).toBe(200)
    expect(clientUpdate).toHaveBeenCalledWith({
      where: { id: "client-1", tenantId: "tenant-1" },
      data: {
        bankName: "FNB",
        bankBranchCode: "250655",
        bankAccountNumber: "123456789",
        accountType: "SAVINGS",
      },
    })
    const clientMutation = clientUpdate.mock.calls[0][0].data
    expect(clientMutation).not.toHaveProperty("monthlyExpenses")
    expect(clientMutation).not.toHaveProperty("monthlyIncome")
    expect(applicationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          debitMandatePreparedAt: new Date("2026-07-23T16:00:00.000Z"),
          debitMandateReference: "LN-app-1",
          debitMandateDraftSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          debitMandateEvidenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          debitMandateEvidence: expect.objectContaining({
            applicationId: "app-1",
            clientId: "client-1",
            collectionReference: "LN-app-1",
            contractFingerprint: "contract-sha",
            bankStatement: expect.objectContaining({
              documentId: "statement-1",
              documentSha256: "d".repeat(64),
            }),
            terms: expect.objectContaining({
              recurringDebitAmountCents: 150_000,
              firstDebitAmountCents: 156_900,
              firstDebitInitiationFeeCents: 6_900,
            }),
          }),
        }),
      }),
    )
    expect(auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "DEBIT_MANDATE_PREPARED",
          entityId: "app-1",
          newValue: expect.objectContaining({
            bankAccountMasked: "*****6789",
            bankStatement: expect.objectContaining({
              documentId: "statement-1",
            }),
          }),
        }),
      }),
    )
  })

  it("cannot replace a signed mandate", async () => {
    applicationFindUnique.mockResolvedValue({
      ...application,
      debitMandateSignedAt: new Date("2026-07-23T15:30:00.000Z"),
    })
    const { POST } = await import("./route")

    const response = await POST(request({
      bankName: "FNB",
      branchCode: "250655",
      accountNumber: "123456789",
      accountType: "SAVINGS",
    }), ctx)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(
      expect.objectContaining({ debitMandate: "already_signed" }),
    )
    expect(applicationUpdateMany).not.toHaveBeenCalled()
  })
})
