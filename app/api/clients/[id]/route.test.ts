import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"

const biometricSubject = {
  id: "client-1",
  idNumber: "9001015000086",
  firstName: "Sipho",
  lastName: "Qatest",
  dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
}

const requireApiRoleMock = vi.fn()
const transactionMock = vi.fn()
const clientFindUniqueMock = vi.fn()
const clientUpdateMock = vi.fn()
const expenseBreakdownUpsertMock = vi.fn()
const debtDeleteManyMock = vi.fn()
const debtUpdateManyMock = vi.fn()
const debtCreateManyMock = vi.fn()
const debtFindManyMock = vi.fn()
const auditLogCreateMock = vi.fn()
const approvedApplicationFindManyMock = vi.fn()
const logAuditMock = vi.fn()
const syncClientConsentMock = vi.fn()
const queryRawMock = vi.fn()
const clientDocumentUpdateManyMock = vi.fn()
const clientDocumentFindManyMock = vi.fn()
const referralFindFirstMock = vi.fn()
const clientDocumentFindFirstMock = vi.fn()
const loadRetroAttributionPlanMock = vi.fn()
const applyRetroAttributionMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (...args: unknown[]) => requireApiRoleMock(...args),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) =>
    cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: {
      findUnique: (...args: unknown[]) => clientFindUniqueMock(...args),
    },
    // Options forwarded, not dropped: the isolation level and the timeout are
    // both asserted, and a mock that swallowed them would hide their loss.
    $transaction: (cb: (tx: unknown) => Promise<unknown>, options?: unknown) =>
      transactionMock(cb, options),
  },
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (args: unknown) => logAuditMock(args),
  AuditAction: new Proxy({}, { get: (_target, key) => String(key) }),
}))
vi.mock("@/lib/consent", () => ({
  syncClientConsent: (...args: unknown[]) => syncClientConsentMock(...args),
}))
vi.mock("@/lib/referral-agents/retro-attribution-apply", () => ({
  loadRetroAttributionPlan: (...args: unknown[]) => loadRetroAttributionPlanMock(...args),
  applyRetroAttribution: (...args: unknown[]) => applyRetroAttributionMock(...args),
}))

import { GET, PATCH, PUT } from "./route"

const context = { params: Promise.resolve({ id: "client-1" }) }

function putRequest(body: unknown) {
  return new NextRequest("http://localhost/api/clients/client-1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedUpdatedAt: "2026-07-18T12:00:00.000Z",
      ...(body as Record<string, unknown>),
    }),
  })
}

function getRequest() {
  return new NextRequest("http://localhost/api/clients/client-1")
}

function patchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/clients/client-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** The default client row their PUT reads under FOR UPDATE. Exposed as a
 *  factory so a test can vary one field without restating the whole shape. */
function baseClient(over: Record<string, unknown> = {}) {
  return {
    ...biometricSubject,
    updatedAt: new Date("2026-07-18T12:00:00.000Z"),
    kycStatus: "VERIFIED",
    kycVerifiedAt: new Date("2026-07-17T10:00:00.000Z"),
    kycVerifiedById: "officer-old",
    kycVerificationMethod: "SMILE_IDENTITY",
    grossMonthlyIncome: 1_500_000,
    monthlyIncome: 1_500_000,
    monthlyExpenses: 800_000,
    bankName: "FNB",
    bankAccountNumber: "62012345678",
    bankBranchCode: "250655",
    accountType: "SAVINGS",
    portalPassword: "$2b$12$never-return-a-password-hash",
    expenseBreakdown: {
      id: "expense-1",
      updatedAt: new Date("2026-07-18T11:00:00Z"),
      housing: 300_000,
      transport: 100_000,
      food: 200_000,
      education: 0,
      insurance: 50_000,
      clothing: 25_000,
      entertainment: 25_000,
      medical: 50_000,
      other: 50_000,
      belowMleJustification: null,
    },
    debtObligations: [{
      id: "debt-1",
      creditProvider: "Bank A",
      accountType: "PERSONAL_LOAN",
      outstandingBalance: 400_000,
      monthlyInstalment: 25_000,
      notes: "Preserve this note",
    }],
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({
    user: { id: "staff-1", email: "staff@example.test" },
  })
  clientFindUniqueMock.mockResolvedValue(baseClient())
  clientUpdateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...baseClient(),
    id: "client-1",
    ...data,
  }))
  expenseBreakdownUpsertMock.mockResolvedValue({ clientId: "client-1" })
  debtDeleteManyMock.mockResolvedValue({ count: 0 })
  debtUpdateManyMock.mockResolvedValue({ count: 1 })
  debtCreateManyMock.mockResolvedValue({ count: 0 })
  debtFindManyMock.mockResolvedValue([{
    id: "debt-1",
    creditProvider: "Bank A",
    accountType: "PERSONAL_LOAN",
    outstandingBalance: 400_000,
    monthlyInstalment: 25_000,
    notes: "Preserve this note",
  }])
  auditLogCreateMock.mockResolvedValue({ id: "audit-1" })
  approvedApplicationFindManyMock.mockResolvedValue([])
  transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      $queryRaw: queryRawMock,
      client: {
        findUnique: clientFindUniqueMock,
        update: clientUpdateMock,
      },
      // resolveReferralCodeById runs on the tx.
      loanApplication: { findMany: approvedApplicationFindManyMock },
      referralCode: { findFirst: referralFindFirstMock },
      clientExpenseBreakdown: { upsert: expenseBreakdownUpsertMock },
      clientDocument: {
        findFirst: clientDocumentFindFirstMock,
        findMany: clientDocumentFindManyMock,
        updateMany: clientDocumentUpdateManyMock,
      },
      existingDebtObligation: {
        deleteMany: debtDeleteManyMock,
        updateMany: debtUpdateManyMock,
        createMany: debtCreateManyMock,
        findMany: debtFindManyMock,
      },
      auditLog: { create: auditLogCreateMock },
    }),
  )
  queryRawMock.mockResolvedValue([{ id: "client-1" }])
  clientDocumentFindManyMock.mockResolvedValue([{ id: "bank-doc-1" }])
  clientDocumentFindFirstMock.mockResolvedValue({
    deletedAt: null,
    verified: true,
    extractionStatus: "done",
    extractionResult: {
      faceDetected: { value: true },
      facesCount: { value: 1 },
      isLive: { value: true },
      quality: { value: "good" },
    },
    extractionError: null,
    validationMismatch: false,
    validationScore: 98,
    biometricMatchScore: 98,
    biometricLiveness: 97,
    biometricVerifiedAt: new Date("2026-07-22T10:00:00.000Z"),
    biometricResult: {
      ok: true,
      verified: true,
      matchScore: 98,
      livenessScore: 97,
      subjectFingerprint: biometricSubjectFingerprint(biometricSubject),
    },
  })
  clientDocumentUpdateManyMock.mockResolvedValue({ count: 1 })
  referralFindFirstMock.mockResolvedValue({ id: "code-live", agentId: "agent-1" })
  loadRetroAttributionPlanMock.mockResolvedValue({
    accrue: [], reverse: [], skipped: [], blockers: [],
  })
  applyRetroAttributionMock.mockResolvedValue({
    reversed: 0, accrued: 0, totalReverseCents: 0, totalAccrueCents: 0, skipped: [],
  })
})

describe("GET /api/clients/[id] response security", () => {
  it("never returns the portal password hash", async () => {
    const response = await GET(getRequest(), context)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.id).toBe("client-1")
    expect(body).not.toHaveProperty("portalPassword")
    expect(clientFindUniqueMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "client-1", tenantId: "tenant-1" },
    }))
  })
})

// The client edit form writes the same income fields the extraction route does,
// so guarding only that route leaves the wider door open: an income
// overwrite on an APPROVED application breaks the immutable affordability
// snapshot and the payout cannot be repaired except by a fresh approval.
describe("PUT /api/clients/[id] approval evidence guard", () => {
  // previousClient carries monthlyIncome/grossMonthlyIncome = 1_500_000, so an
  // approval recorded at that figure is INTACT.
  const intactApproval = {
    id: "app-1",
    reference: "APP-0001",
    affordabilityResult: {
      approval: {
        inputs: { monthlyIncomeCents: 1_500_000 },
        expenses: { grossMonthlyIncomeCents: 1_500_000 },
      },
    },
  }

  it("refuses an income change that would break an intact approval", async () => {
    approvedApplicationFindManyMock.mockResolvedValue([intactApproval])

    const response = await PUT(putRequest({ monthlyIncome: 1_500_099 }), context)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("APP-0001"),
    })
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it("refuses a gross-income change that would break an intact approval", async () => {
    approvedApplicationFindManyMock.mockResolvedValue([intactApproval])

    const response = await PUT(putRequest({ grossMonthlyIncome: 2_679_901 }), context)

    expect(response.status).toBe(409)
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  // THE REPAIR PATH. When the record already disagrees with the snapshot the
  // approval is void anyway, and staff must be able to put the value back —
  // that is the only way to recover such a payout. A blanket block
  // on approved clients would make it unrecoverable.
  it("allows restoring income the snapshot expects when the record already diverged", async () => {
    clientFindUniqueMock.mockResolvedValue(baseClient({ monthlyIncome: 1_500_099 }))
    approvedApplicationFindManyMock.mockResolvedValue([intactApproval])

    const response = await PUT(putRequest({ monthlyIncome: 1_500_000 }), context)

    expect(response.status).toBe(200)
    expect(clientUpdateMock).toHaveBeenCalled()
  })

  // The condition is "don't BREAK an intact approval", not "must equal the
  // snapshot". Once the record has diverged the approval is void, so staff may
  // correct the value to whatever is actually right — a rule that only permitted
  // the exact snapshot figure would force a wrong number back onto the record.
  it("allows any income correction once the record has already diverged", async () => {
    clientFindUniqueMock.mockResolvedValue(baseClient({ monthlyIncome: 1_500_099 }))
    approvedApplicationFindManyMock.mockResolvedValue([intactApproval])

    const response = await PUT(putRequest({ monthlyIncome: 1_600_000 }), context)

    expect(response.status).toBe(200)
    expect(clientUpdateMock).toHaveBeenCalled()
  })

  it("allows any gross-income correction once the record has already diverged", async () => {
    clientFindUniqueMock.mockResolvedValue(baseClient({ grossMonthlyIncome: 2_679_901 }))
    approvedApplicationFindManyMock.mockResolvedValue([intactApproval])

    const response = await PUT(putRequest({ grossMonthlyIncome: 1_530_400 }), context)

    expect(response.status).toBe(200)
    expect(clientUpdateMock).toHaveBeenCalled()
  })

  // Declared expenses are hashed into the same decision fingerprint income is
  // (statedMonthlyExpensesCents plus every breakdown category), and like income
  // they have no lighter remedy — no document to re-verify, no biometric to
  // revoke. Guarding income while leaving expenses open reproduces the same
  // failure one field over on the identical route.
  const approvalWithExpenses = {
    ...intactApproval,
    affordabilityResult: {
      approval: {
        inputs: {
          monthlyIncomeCents: 1_500_000,
          monthlyExpensesCents: 800_000,
        },
        expenses: {
          grossMonthlyIncomeCents: 1_500_000,
          breakdown: {
            housing: 300_000, transport: 100_000, food: 200_000, education: 0,
            insurance: 50_000, clothing: 25_000, entertainment: 25_000,
            medical: 50_000, other: 50_000,
          },
        },
      },
    },
  }

  it("refuses an expense change that would break an intact approval", async () => {
    approvedApplicationFindManyMock.mockResolvedValue([approvalWithExpenses])

    const response = await PUT(putRequest({
      expenseBreakdown: {
        housing: 350_000, transport: 100_000, food: 200_000, education: 0,
        insurance: 50_000, clothing: 25_000, entertainment: 25_000,
        medical: 50_000, other: 50_000,
      },
    }), context)

    expect(response.status).toBe(409)
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  // A reshuffle that keeps the same total still moves the fingerprint, because
  // every category is hashed individually.
  it("refuses a category reshuffle that leaves the total unchanged", async () => {
    approvedApplicationFindManyMock.mockResolvedValue([approvalWithExpenses])

    const response = await PUT(putRequest({
      expenseBreakdown: {
        housing: 250_000, transport: 150_000, food: 200_000, education: 0,
        insurance: 50_000, clothing: 25_000, entertainment: 25_000,
        medical: 50_000, other: 50_000,
      },
    }), context)

    expect(response.status).toBe(409)
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  // A request that omits expenseBreakdown is not changing it. Treating the
  // absent patch as "no longer matches" would refuse every unrelated edit —
  // a phone number, a bank account, a next-of-kin — on any client holding an
  // intact approved application, which is most of the queue.
  it.each([
    ["banking only", { bankName: "ABSA", bankAccountNumber: "40987654321", bankBranchCode: "632005", accountType: "SAVINGS" }],
    ["name only", { firstName: "Nomsa" }],
    ["next of kin only", { nextOfKinName: "Thabo" }],
  ])("allows an unrelated %s edit while an approval is intact", async (_label, body) => {
    approvedApplicationFindManyMock.mockResolvedValue([approvalWithExpenses])

    const response = await PUT(putRequest(body), context)

    expect(response.status).toBe(200)
    expect(clientUpdateMock).toHaveBeenCalled()
  })

  // Imported/legacy clients carry the cached monthlyExpenses scalar with no
  // breakdown row. The per-category check cannot fire for them (there is
  // nothing to compare), so the scalar is the only thing standing between a
  // routine expense edit and a voided approval.
  it("refuses an expense change for a client that has no breakdown row", async () => {
    clientFindUniqueMock.mockResolvedValue(baseClient({ expenseBreakdown: null }))
    approvedApplicationFindManyMock.mockResolvedValue([approvalWithExpenses])

    const response = await PUT(putRequest({
      expenseBreakdown: {
        housing: 400_000, transport: 100_000, food: 200_000, education: 0,
        insurance: 50_000, clothing: 25_000, entertainment: 25_000,
        medical: 50_000, other: 50_000,
      },
    }), context)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("monthlyExpenses"),
    })
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  // A client approved with no breakdown row got a SYNTHETIC one in the snapshot:
  // createAffordabilityExpenseEvidence puts the whole declared total in `other`
  // and zeroes the rest. Giving that client their first itemised breakdown at
  // the same total is the ordinary next step — and it reshuffles every category
  // relative to that synthetic shape, moving the fingerprint. Treating "no row"
  // as "nothing to compare" let exactly that through.
  it("refuses a same-total reshuffle for a client approved without a breakdown row", async () => {
    clientFindUniqueMock.mockResolvedValue(baseClient({ expenseBreakdown: null }))
    approvedApplicationFindManyMock.mockResolvedValue([{
      id: "app-1",
      reference: "APP-0001",
      affordabilityResult: {
        approval: {
          inputs: { monthlyIncomeCents: 1_500_000, monthlyExpensesCents: 800_000 },
          expenses: {
            grossMonthlyIncomeCents: 1_500_000,
            // Synthetic: the entire declared total sits in `other`.
            breakdown: {
              housing: 0, transport: 0, food: 0, education: 0, insurance: 0,
              clothing: 0, entertainment: 0, medical: 0, other: 800_000,
            },
          },
        },
      },
    }])

    // Same R8 000 total, itemised across categories.
    const response = await PUT(putRequest({
      expenseBreakdown: {
        housing: 400_000, transport: 100_000, food: 200_000, education: 0,
        insurance: 50_000, clothing: 25_000, entertainment: 0,
        medical: 25_000, other: 0,
      },
    }), context)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("expenseBreakdown"),
    })
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  // The open-application unique index is per PRODUCT, so one client can hold two
  // approved applications at once. Checking an arbitrary one lets an edit
  // through whenever the one inspected happens to be the already-void one.
  it("refuses when ANY approved application is still intact, not just the first", async () => {
    approvedApplicationFindManyMock.mockResolvedValue([
      {
        id: "app-void",
        reference: "APP-VOID",
        // Already diverged from the client record — void on its own.
        affordabilityResult: {
          approval: {
            inputs: { monthlyIncomeCents: 999_999 },
            expenses: { grossMonthlyIncomeCents: 999_999 },
          },
        },
      },
      intactApproval,
    ])

    const response = await PUT(putRequest({ monthlyIncome: 1_500_099 }), context)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("APP-0001"),
    })
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it("allows an income change when no application is approved", async () => {
    approvedApplicationFindManyMock.mockResolvedValue([])

    const response = await PUT(putRequest({ monthlyIncome: 1_500_099 }), context)

    expect(response.status).toBe(200)
    expect(clientUpdateMock).toHaveBeenCalled()
  })

  it("scopes the approved-application lookup to the tenant and client", async () => {
    approvedApplicationFindManyMock.mockResolvedValue([intactApproval])

    await PUT(putRequest({ monthlyIncome: 1_500_099 }), context)

    expect(approvedApplicationFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: "tenant-1",
        clientId: "client-1",
        status: "APPROVED",
      }),
    }))
  })

  // An unreadable snapshot is already unusable evidence; blocking on it would
  // strand the record with no way to correct it.
  it("does not block when the approval snapshot is missing or malformed", async () => {
    approvedApplicationFindManyMock.mockResolvedValue([{
      id: "app-1", reference: "APP-0001", affordabilityResult: { approval: {} },
    }])

    const response = await PUT(putRequest({ monthlyIncome: 1_500_099 }), context)

    expect(response.status).toBe(200)
  })
})

describe("PUT /api/clients/[id] partial-update semantics", () => {
  it("requires the client revision before any write transaction starts", async () => {
    const response = await PUT(putRequest({
      expectedUpdatedAt: undefined,
      bankName: "ABSA",
    }), context)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "Validation failed",
      errors: { expectedUpdatedAt: "A valid client revision is required" },
    })
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("clears the account type when sent empty, rather than 500ing", async () => {
    // Behaviour CHANGE, pinned deliberately. The route used to write the raw
    // `data.accountType`, so "" reached Prisma as an invalid enum value and
    // threw — a 500 for a well-formed request. It now writes the same trimmed
    // value the allow-list validated, and "" trims to null.
    //
    // Clearing is right on both counts: it matches how every sibling bank field
    // in this route already behaves (`String(...).trim() || null`), and it fails
    // closed — `currentVerifiedBankDetails` requires an account type, so a
    // cleared client cannot be disbursed until one is set again.
    const response = await PUT(putRequest({ accountType: "" }), context)

    expect(response.status).toBe(200)
    expect(clientUpdateMock.mock.calls[0][0].data).toMatchObject({
      accountType: null,
    })
  })

  it("refuses an account type the dropdown does not offer", async () => {
    // PUT wrote whatever arrived straight to a Prisma enum column, unlike POST
    // which runs this same allow-list. TRANSMISSION was retired from every
    // picker in August 2026 and stayed settable here for months.
    const response = await PUT(putRequest({
      bankName: "FNB",
      bankAccountNumber: "62012345678",
      bankBranchCode: "250655",
      accountType: "TRANSMISSION",
    }), context)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "Validation failed",
      errors: { accountType: "Select a valid account type" },
    })
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it("accepts OTHER, which the dropdown DOES offer", async () => {
    // The allow-list is derived from ACCOUNT_TYPES, so it must track the
    // dropdown rather than a hand-kept list — a second copy is how this
    // codebase's canonicalisers drifted from their Postgres twins.
    const response = await PUT(putRequest({
      bankName: "FNB",
      bankAccountNumber: "62012345678",
      bankBranchCode: "250655",
      accountType: "OTHER",
    }), context)

    expect(response.status).toBe(200)
    expect(clientUpdateMock.mock.calls[0][0].data).toMatchObject({
      accountType: "OTHER",
    })
  })

  it("does not judge an account type the request never sent", async () => {
    // `effectiveBankDetails.accountType` falls back to the STORED value, so an
    // unscoped check fails a phone-number edit for any row holding a retired
    // value — an error naming a field the caller never touched.
    //
    // The stored value has to be a RETIRED one for this to discriminate. With
    // the default SAVINGS fixture the unscoped and scoped versions behave
    // identically and the test cannot fail, which is exactly what a first pass
    // at it did.
    clientFindUniqueMock.mockResolvedValue({
      ...baseClient(),
      accountType: "TRANSMISSION",
    })

    const response = await PUT(putRequest({ phone: "0710000001" }), context)

    expect(response.status).toBe(200)
  })

  it("preserves income and expenses during a banking-only update", async () => {
    const response = await PUT(putRequest({
      bankName: "FNB",
      bankAccountNumber: "62012345678",
      bankBranchCode: "250655",
      accountType: "SAVINGS",
    }), context)

    expect(response.status).toBe(200)
    const update = clientUpdateMock.mock.calls[0][0]
    expect(update.data).toEqual({
      bankName: "FNB",
      bankAccountNumber: "62012345678",
      bankBranchCode: "250655",
      accountType: "SAVINGS",
    })
    expect(update.data).not.toHaveProperty("monthlyIncome")
    expect(update.data).not.toHaveProperty("monthlyExpenses")
    expect(update.data).not.toHaveProperty("grossMonthlyIncome")
    expect(update.data).not.toHaveProperty("dateOfBirth")
    expect(syncClientConsentMock).not.toHaveBeenCalled()
    expect(clientDocumentUpdateManyMock).not.toHaveBeenCalled()
    expect(queryRawMock).toHaveBeenCalledWith(expect.objectContaining({
      values: ["affordability-client:tenant-1:client-1"],
    }))
    expect(await response.json()).not.toHaveProperty("portalPassword")
  })

  it("invalidates verified biometric KYC when provider-facing identity changes", async () => {
    clientDocumentFindManyMock.mockResolvedValueOnce([{ id: "selfie-doc-1" }])

    const response = await PUT(putRequest({ firstName: "Nomsa" }), context)

    expect(response.status).toBe(200)
    expect(clientDocumentFindManyMock).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        clientId: "client-1",
        docType: "SELFIE",
        deletedAt: null,
        verified: true,
      },
      select: { id: true },
      orderBy: { id: "asc" },
    })
    expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        firstName: "Nomsa",
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      }),
    }))
    expect(clientDocumentUpdateManyMock).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        clientId: "client-1",
        docType: "SELFIE",
        deletedAt: null,
        verified: true,
        id: { in: ["selfie-doc-1"] },
      },
      data: {
        verified: false,
        verifiedAt: null,
        verifiedById: null,
        verificationNote: "Client identity changed; repeat biometric verification before disbursement.",
      },
    })
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CLIENT_UPDATED",
        oldValue: expect.objectContaining({
          biometricIdentityEvidence: expect.objectContaining({
            subjectFingerprint: biometricSubjectFingerprint(biometricSubject),
          }),
        }),
        newValue: expect.objectContaining({
          biometricIdentityEvidence: expect.objectContaining({
            reason: "client_identity_changed",
            invalidatedDocumentIds: ["selfie-doc-1"],
            invalidatedDocumentCount: 1,
          }),
        }),
      }),
    })
  })

  it("rejects a stale full-form banking save before it can restore older expenses", async () => {
    const storedClient = await clientFindUniqueMock()
    clientFindUniqueMock.mockClear()
    clientFindUniqueMock.mockResolvedValue({
      ...storedClient,
      updatedAt: new Date("2026-07-18T12:05:00.000Z"),
      monthlyExpenses: 900_000,
      expenseBreakdown: {
        ...storedClient.expenseBreakdown,
        housing: 400_000,
      },
    })

    const response = await PUT(putRequest({
      bankName: "ABSA",
      monthlyExpenses: 800_000,
      expenseBreakdown: {
        housing: 300_000,
        transport: 100_000,
        food: 200_000,
        education: 0,
        insurance: 50_000,
        clothing: 25_000,
        entertainment: 25_000,
        medical: 50_000,
        other: 50_000,
        belowMleJustification: "",
      },
    }), context)

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/changed after this edit form was opened/i)
    expect(clientUpdateMock).not.toHaveBeenCalled()
    expect(expenseBreakdownUpsertMock).not.toHaveBeenCalled()
    expect(debtDeleteManyMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })

  it("invalidates verified bank statements atomically when banking details change", async () => {
    let persistedClient = baseClient()
    clientUpdateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      persistedClient = { ...persistedClient, ...data }
      return persistedClient
    })
    clientFindUniqueMock
      .mockResolvedValueOnce(baseClient())
      .mockResolvedValueOnce(baseClient({
        bankName: "ABSA",
        bankAccountNumber: "40987654321",
        bankBranchCode: "632005",
        accountType: "CHEQUE",
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      }))
    clientDocumentFindManyMock
      .mockResolvedValueOnce([{ id: "bank-doc-1" }])
      .mockResolvedValueOnce([
        { docType: "ID_COPY", verified: true, verificationNote: null },
        { docType: "PROOF_OF_ADDRESS", verified: true, verificationNote: null },
        { docType: "PAYSLIP", verified: true, verificationNote: null },
        {
          docType: "BANK_STATEMENT",
          verified: false,
          verificationNote: "Bank details changed; verify current evidence.",
        },
      ])

    const response = await PUT(putRequest({
      bankName: "ABSA",
      bankAccountNumber: "40987654321",
      bankBranchCode: "632005",
      accountType: "CHEQUE",
    }), context)

    expect(response.status).toBe(200)
    expect(clientDocumentUpdateManyMock).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        clientId: "client-1",
        docType: "BANK_STATEMENT",
        deletedAt: null,
        verified: true,
        id: { in: ["bank-doc-1"] },
      },
      data: {
        verified: false,
        verifiedAt: null,
        verifiedById: null,
        verificationNote: expect.stringContaining("Bank details changed"),
      },
    })
    expect(clientUpdateMock.mock.invocationCallOrder[0]).toBeLessThan(
      clientDocumentUpdateManyMock.mock.invocationCallOrder[0],
    )
    // PENDING, not FAILED. This invalidation is written by the SYSTEM when the
    // client's bank details change — it records no reviewer, so nobody refused
    // anything. A reviewer refusing a document still yields FAILED, because the
    // verify endpoint records verificationRejectedById.
    expect(clientUpdateMock).toHaveBeenLastCalledWith({
      where: { id: "client-1", tenantId: "tenant-1" },
      data: {
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      },
    })
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "KYC_STATUS_CHANGED",
        oldValue: expect.objectContaining({ kycStatus: "PENDING" }),
        newValue: expect.objectContaining({
          kycStatus: "PENDING",
          reason: "bank_evidence_invalidated",
          invalidatedDocumentIds: ["bank-doc-1"],
        }),
      }),
    })
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        oldValue: expect.objectContaining({
          bankEvidence: expect.objectContaining({
            accountNumberMasked: "*******5678",
            fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        }),
        newValue: expect.objectContaining({
          bankEvidence: expect.objectContaining({
            accountNumberMasked: "*******4321",
            fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
          bankEvidenceRevocation: {
            reason: "bank_details_changed",
            invalidatedDocumentIds: ["bank-doc-1"],
            invalidatedDocumentCount: 1,
          },
        }),
      }),
    })
  })

  it("does not rewrite an unchanged expense source during a full-form banking save", async () => {
    const response = await PUT(putRequest({
      bankName: "FNB",
      expenseBreakdown: {
        housing: 300_000,
        transport: 100_000,
        food: 200_000,
        education: 0,
        insurance: 50_000,
        clothing: 25_000,
        entertainment: 25_000,
        medical: 50_000,
        other: 50_000,
        belowMleJustification: "",
      },
    }), context)

    expect(response.status).toBe(200)
    expect(expenseBreakdownUpsertMock).not.toHaveBeenCalled()
    expect(clientUpdateMock.mock.calls[0][0].data).toEqual({
      bankName: "FNB",
      monthlyExpenses: 800_000,
    })
  })

  it("merges an incomplete nested expense payload without zeroing omitted evidence", async () => {
    const response = await PUT(putRequest({
      expenseBreakdown: {
        belowMleJustification: "Manual rationale",
      },
    }), context)

    expect(response.status).toBe(200)
    expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: { monthlyExpenses: 800_000 },
    }))
    expect(expenseBreakdownUpsertMock).toHaveBeenCalledWith({
      where: { clientId: "client-1" },
      create: {
        clientId: "client-1",
        housing: 300_000,
        transport: 100_000,
        food: 200_000,
        education: 0,
        insurance: 50_000,
        clothing: 25_000,
        entertainment: 25_000,
        medical: 50_000,
        other: 50_000,
        belowMleJustification: "Manual rationale",
      },
      update: {
        housing: 300_000,
        transport: 100_000,
        food: 200_000,
        education: 0,
        insurance: 50_000,
        clothing: 25_000,
        entertainment: 25_000,
        medical: 50_000,
        other: 50_000,
        belowMleJustification: "Manual rationale",
      },
    })
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        newValue: expect.objectContaining({
          monthlyExpenses: 800_000,
          expenseBreakdown: expect.objectContaining({
            housing: 300_000,
            other: 50_000,
            belowMleJustification: "Manual rationale",
          }),
        }),
      }),
    })
  })

  it.each([
    [null, "null"],
    ["", "empty string"],
    ["   ", "whitespace"],
    [false, "boolean"],
    [[], "array"],
    [{}, "object"],
    [-1, "negative cents"],
    [1.5, "fractional cents"],
    [2_147_483_648, "outside the database integer range"],
    [Number.MAX_SAFE_INTEGER + 1, "unsafe integer"],
  ])("rejects a %s expense amount instead of coercing it to zero (%s)", async (housing, _description) => {
    const response = await PUT(putRequest({
      expenseBreakdown: { housing },
    }), context)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "Validation failed",
      errors: {
        "expenseBreakdown.housing": "Must be a non-negative safe integer amount in cents",
      },
    })
    expect(transactionMock).not.toHaveBeenCalled()
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it("rejects an explicit monthly-expense change without its source breakdown", async () => {
    const response = await PUT(putRequest({ monthlyExpenses: 0 }), context)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(expect.objectContaining({
      errors: { expenseBreakdown: expect.stringContaining("required") },
    }))
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it("uses stored gross income for the MLE check when an all-zero breakdown omits gross income", async () => {
    const response = await PUT(putRequest({
      expenseBreakdown: {
        housing: 0,
        transport: 0,
        food: 0,
        education: 0,
        insurance: 0,
        clothing: 0,
        entertainment: 0,
        medical: 0,
        other: 0,
      },
    }), context)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(expect.objectContaining({
      errors: {
        "expenseBreakdown.belowMleJustification": expect.stringContaining("Justification required"),
      },
    }))
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it("rejects an explicit zero gross income when positive net income is declared", async () => {
    const response = await PUT(putRequest({
      grossMonthlyIncome: 0,
      monthlyIncome: 1_500_000,
    }), context)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(expect.objectContaining({
      errors: {
        grossMonthlyIncome: expect.stringContaining("greater than zero or left blank"),
      },
    }))
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it("falls back to positive net income for MLE when a legacy stored gross value is zero", async () => {
    const storedClient = await clientFindUniqueMock()
    clientFindUniqueMock.mockClear()
    clientFindUniqueMock.mockResolvedValue({
      ...storedClient,
      grossMonthlyIncome: 0,
    })

    const response = await PUT(putRequest({
      expenseBreakdown: {
        housing: 0,
        transport: 0,
        food: 0,
        education: 0,
        insurance: 0,
        clothing: 0,
        entertainment: 0,
        medical: 0,
        other: 0,
      },
    }), context)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(expect.objectContaining({
      errors: {
        "expenseBreakdown.belowMleJustification": expect.stringContaining("Justification required"),
      },
    }))
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it("audits the financial and debt evidence inside the update transaction", async () => {
    await PUT(putRequest({ bankName: "FNB" }), context)

    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        oldValue: expect.objectContaining({
          grossMonthlyIncome: 1_500_000,
          monthlyIncome: 1_500_000,
          monthlyExpenses: 800_000,
          debtObligations: [expect.objectContaining({ id: "debt-1" })],
        }),
        newValue: expect.objectContaining({
          grossMonthlyIncome: 1_500_000,
          monthlyIncome: 1_500_000,
          monthlyExpenses: 800_000,
          debtObligations: [expect.objectContaining({
            id: "debt-1",
            notes: "Preserve this note",
          })],
        }),
      }),
    })
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("reconciles an existing debt by id without dropping notes or recreating it", async () => {
    const response = await PUT(putRequest({
      bankName: "FNB",
      debtObligations: [{
        id: "debt-1",
        creditProvider: "Bank A",
        accountType: "PERSONAL_LOAN",
        outstandingBalance: 400_000,
        monthlyInstalment: 25_000,
      }],
    }), context)

    expect(response.status).toBe(200)
    expect(debtDeleteManyMock).toHaveBeenCalledWith({
      where: { clientId: "client-1", id: { notIn: ["debt-1"] } },
    })
    expect(debtUpdateManyMock).toHaveBeenCalledWith({
      where: { id: "debt-1", clientId: "client-1" },
      data: {
        creditProvider: "Bank A",
        accountType: "PERSONAL_LOAN",
        outstandingBalance: 400_000,
        monthlyInstalment: 25_000,
      },
    })
    expect(debtCreateManyMock).not.toHaveBeenCalled()
  })

  it("rejects a client-debt aggregate outside the supported monetary range", async () => {
    const response = await PUT(putRequest({
      debtObligations: [
        {
          creditProvider: "Synthetic Bank A",
          accountType: "PERSONAL_LOAN",
          outstandingBalance: 0,
          monthlyInstalment: 1_500_000_000,
        },
        {
          creditProvider: "Synthetic Bank B",
          accountType: "PERSONAL_LOAN",
          outstandingBalance: 0,
          monthlyInstalment: 1_500_000_000,
        },
      ],
    }), context)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "Validation failed",
      errors: {
        debtObligations: "Total monthly debt instalments exceed the supported monetary range",
      },
    })
    expect(transactionMock).not.toHaveBeenCalled()
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it("rejects a malformed client debt row before mapping or writing it", async () => {
    const response = await PUT(putRequest({
      debtObligations: [null],
    }), context)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "Validation failed",
      errors: { "debtObligations.0": "Must be an object" },
    })
    expect(transactionMock).not.toHaveBeenCalled()
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it("fails the whole request when the mandatory transactional audit cannot be written", async () => {
    auditLogCreateMock.mockRejectedValueOnce(new Error("audit unavailable"))

    const response = await PUT(putRequest({ bankName: "FNB" }), context)

    expect(response.status).toBe(500)
    expect(clientUpdateMock).toHaveBeenCalledOnce()
    expect(auditLogCreateMock).toHaveBeenCalledOnce()
  })
})

describe("PATCH /api/clients/[id] KYC serialization", () => {
  it("blocks manual KYC approval when the latest selfie failed liveness", async () => {
    clientFindUniqueMock.mockResolvedValueOnce({
      ...biometricSubject,
      kycStatus: "PENDING",
      kycVerifiedAt: null,
      kycVerifiedById: null,
      kycVerificationMethod: null,
    })
    clientDocumentFindFirstMock.mockResolvedValueOnce({
      deletedAt: null,
      verified: false,
      extractionStatus: "done",
      extractionResult: {
        faceDetected: { value: true },
        facesCount: { value: 1 },
        isLive: { value: false },
        quality: { value: "good" },
      },
      extractionError: null,
      validationMismatch: true,
      validationScore: 0,
      biometricMatchScore: 0,
      biometricLiveness: 0,
      biometricVerifiedAt: null,
      biometricResult: { ok: true, verified: false, matchScore: 0, livenessScore: 0 },
    })

    const response = await PATCH(patchRequest({
      kycStatus: "VERIFIED",
      kycVerificationMethod: "DIGITAL",
    }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      biometricEvidence: "vlm_liveness_failed",
    }))
    expect(clientUpdateMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "KYC_VERIFICATION_BLOCKED",
        newValue: expect.objectContaining({
          attemptedStatus: "VERIFIED",
          requestedMethod: "DIGITAL",
          blocked: true,
          biometricEvidence: "vlm_liveness_failed",
        }),
      }),
    })
  })

  it("blocks manual KYC approval when the latest selfie was deleted", async () => {
    clientFindUniqueMock.mockResolvedValueOnce({
      ...biometricSubject,
      kycStatus: "PENDING",
      kycVerifiedAt: null,
      kycVerificationMethod: null,
    })
    clientDocumentFindFirstMock.mockResolvedValueOnce({
      deletedAt: new Date("2026-07-22T11:00:00.000Z"),
      verified: true,
      extractionStatus: "done",
      extractionResult: {
        faceDetected: { value: true },
        facesCount: { value: 1 },
        isLive: { value: true },
        quality: { value: "good" },
      },
      extractionError: null,
      validationMismatch: false,
      validationScore: 98,
      biometricMatchScore: 98,
      biometricLiveness: 97,
      biometricVerifiedAt: new Date("2026-07-22T10:00:00.000Z"),
      biometricResult: {
        ok: true,
        verified: true,
        matchScore: 98,
        livenessScore: 97,
        subjectFingerprint: biometricSubjectFingerprint(biometricSubject),
      },
    })

    const response = await PATCH(patchRequest({
      kycStatus: "VERIFIED",
      kycVerificationMethod: "DIGITAL",
    }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      biometricEvidence: "document_deleted",
    }))
    expect(clientDocumentFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.not.objectContaining({ deletedAt: null }),
    }))
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it("records the requested staff verification method when composite KYC is approved", async () => {
    clientDocumentFindManyMock.mockResolvedValueOnce([
      { docType: "ID_COPY", verified: true, verificationNote: null },
      { docType: "PROOF_OF_ADDRESS", verified: true, verificationNote: null },
      { docType: "PAYSLIP", verified: true, verificationNote: null },
      { docType: "BANK_STATEMENT", verified: true, verificationNote: null },
    ])
    clientFindUniqueMock.mockResolvedValueOnce({
      ...biometricSubject,
      kycStatus: "PENDING",
      kycVerifiedAt: null,
      kycVerificationMethod: null,
    })

    const response = await PATCH(patchRequest({
      kycStatus: "VERIFIED",
      kycVerificationMethod: "DIGITAL",
    }), context)

    expect(response.status).toBe(200)
    expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        kycStatus: "VERIFIED",
        kycVerifiedById: "staff-1",
        kycVerificationMethod: "DIGITAL",
      }),
    }))
  })

  it("serializes a KYC revocation with payout and audits it transactionally", async () => {
    clientFindUniqueMock.mockResolvedValueOnce({
      ...biometricSubject,
      kycStatus: "VERIFIED",
      kycVerifiedAt: new Date("2026-07-20T08:00:00.000Z"),
      kycVerifiedById: "officer-old",
      kycVerificationMethod: "SMILE_IDENTITY",
    })

    const response = await PATCH(patchRequest({
      kycStatus: "FAILED",
      reason: "Identity evidence does not match",
    }), context)

    expect(response.status).toBe(200)
    expect(requireApiRoleMock).toHaveBeenCalledWith("CREDIT_OFFICER")
    expect(queryRawMock).toHaveBeenCalledWith(expect.objectContaining({
      values: ["affordability-client:tenant-1:client-1"],
    }))
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      clientFindUniqueMock.mock.invocationCallOrder[0],
    )
    expect(clientUpdateMock).toHaveBeenCalledWith({
      where: { id: "client-1", tenantId: "tenant-1" },
      data: expect.objectContaining({
        kycStatus: "FAILED",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
        kycManualRejectionActive: true,
        kycManualRejectionById: "staff-1",
        kycManualRejectionReason: "Identity evidence does not match",
      }),
      select: expect.objectContaining({
        id: true,
        kycStatus: true,
        kycVerifiedAt: true,
        kycVerifiedById: true,
        kycVerificationMethod: true,
        kycManualRejectionActive: true,
      }),
    })
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "KYC_REJECTED",
        oldValue: {
          kycStatus: "VERIFIED",
          kycVerifiedAt: "2026-07-20T08:00:00.000Z",
          kycVerifiedById: "officer-old",
          kycVerificationMethod: "SMILE_IDENTITY",
        },
        newValue: expect.objectContaining({
          kycStatus: "FAILED",
          kycVerifiedAt: null,
          kycVerifiedById: null,
          kycVerificationMethod: null,
          manualOverride: true,
          manualRejection: true,
          manualRejectionReason: "Identity evidence does not match",
        }),
      }),
    })
    expect(clientUpdateMock.mock.invocationCallOrder[0]).toBeLessThan(
      auditLogCreateMock.mock.invocationCallOrder[0],
    )
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("fails the KYC mutation when its transactional audit cannot be written", async () => {
    clientFindUniqueMock.mockResolvedValueOnce({
      ...biometricSubject,
      kycStatus: "VERIFIED",
      kycVerifiedAt: new Date(),
      kycVerificationMethod: "PHYSICAL",
    })
    auditLogCreateMock.mockRejectedValueOnce(new Error("audit unavailable"))

    const response = await PATCH(patchRequest({
      kycStatus: "FAILED",
      reason: "Identity evidence does not match",
    }), context)

    expect(response.status).toBe(500)
    expect(clientUpdateMock).toHaveBeenCalledOnce()
    expect(auditLogCreateMock).toHaveBeenCalledOnce()
  })

  it("returns 404 without a mutation when the locked client is absent", async () => {
    clientFindUniqueMock.mockResolvedValueOnce(null)

    const response = await PATCH(patchRequest({
      kycStatus: "FAILED",
      reason: "Identity evidence does not match",
    }), context)

    expect(response.status).toBe(404)
    expect(clientUpdateMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })

  it.each([null, "", "MANUAL", 42])(
    "rejects an explicitly invalid KYC method (%s) instead of silently using PHYSICAL",
    async (kycVerificationMethod) => {
      const response = await PATCH(patchRequest({
        kycStatus: "VERIFIED",
        kycVerificationMethod,
      }), context)

      expect(response.status).toBe(400)
      expect((await response.json()).error).toMatch(/kycVerificationMethod must be one of/)
      expect(transactionMock).not.toHaveBeenCalled()
      expect(clientUpdateMock).not.toHaveBeenCalled()
      expect(auditLogCreateMock).not.toHaveBeenCalled()
    },
  )

  it.each([undefined, null, "", "short"])(
    "requires a durable reason for a manual KYC rejection (%s)",
    async (reason) => {
      const response = await PATCH(patchRequest({
        kycStatus: "FAILED",
        ...(reason !== undefined && { reason }),
      }), context)

      expect(response.status).toBe(400)
      expect((await response.json()).error).toMatch(/rejection reason/)
      expect(transactionMock).not.toHaveBeenCalled()
      expect(clientUpdateMock).not.toHaveBeenCalled()
    },
  )

  it("does not clear an active manual rejection through an ordinary status update", async () => {
    clientFindUniqueMock.mockResolvedValueOnce({
      ...biometricSubject,
      kycStatus: "FAILED",
      kycVerifiedAt: null,
      kycVerifiedById: null,
      kycVerificationMethod: null,
      kycManualRejectionActive: true,
      kycManualRejectionAt: new Date("2026-07-23T01:00:00.000Z"),
      kycManualRejectionById: "compliance-1",
      kycManualRejectionReason: "Identity evidence requires investigation",
      kycManualRejectionResolvedAt: null,
      kycManualRejectionResolvedById: null,
      kycManualRejectionResolutionReason: null,
    })

    const response = await PATCH(patchRequest({
      kycStatus: "VERIFIED",
      kycVerificationMethod: "DIGITAL",
    }), context)

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/explicit resolution action/)
    expect(clientUpdateMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })

  it("resolves a manual rejection only with explicit actor and reason provenance", async () => {
    const rejectedAt = new Date("2026-07-23T01:00:00.000Z")
    clientDocumentFindManyMock.mockResolvedValueOnce([
      { docType: "ID_COPY", verified: true, verificationNote: null },
      { docType: "PROOF_OF_ADDRESS", verified: true, verificationNote: null },
      { docType: "PAYSLIP", verified: true, verificationNote: null },
      { docType: "BANK_STATEMENT", verified: true, verificationNote: null },
    ])
    clientFindUniqueMock.mockResolvedValueOnce({
      ...biometricSubject,
      kycStatus: "FAILED",
      kycVerifiedAt: null,
      kycVerifiedById: null,
      kycVerificationMethod: null,
      kycManualRejectionActive: true,
      kycManualRejectionAt: rejectedAt,
      kycManualRejectionById: "compliance-1",
      kycManualRejectionReason: "Identity evidence requires investigation",
      kycManualRejectionResolvedAt: null,
      kycManualRejectionResolvedById: null,
      kycManualRejectionResolutionReason: null,
    })

    const response = await PATCH(patchRequest({
      kycStatus: "VERIFIED",
      kycVerificationMethod: "DIGITAL",
      resolveManualRejection: true,
      resolutionReason: "Investigation completed against source documents",
    }), context)

    expect(response.status).toBe(200)
    expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        kycStatus: "VERIFIED",
        kycManualRejectionActive: false,
        kycManualRejectionResolvedAt: expect.any(Date),
        kycManualRejectionResolvedById: "staff-1",
        kycManualRejectionResolutionReason:
          "Investigation completed against source documents",
      }),
    }))
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "KYC_APPROVED",
        newValue: expect.objectContaining({
          manualRejectionResolved: true,
          manualRejectionResolutionReason:
            "Investigation completed against source documents",
        }),
      }),
    })
  })

  it("audits PENDING as a status change and clears stale verification provenance", async () => {
    clientFindUniqueMock.mockResolvedValueOnce({
      ...biometricSubject,
      kycStatus: "VERIFIED",
      kycVerifiedAt: new Date("2026-07-20T08:00:00.000Z"),
      kycVerifiedById: "officer-old",
      kycVerificationMethod: "PHYSICAL",
    })

    const response = await PATCH(patchRequest({ kycStatus: "PENDING" }), context)

    expect(response.status).toBe(200)
    expect(clientUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      },
    }))
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "KYC_STATUS_CHANGED",
        newValue: expect.objectContaining({
          kycStatus: "PENDING",
          kycVerifiedAt: null,
          kycVerifiedById: null,
          kycVerificationMethod: null,
        }),
      }),
    })
  })
})


// ── referral-agent attribution ────────────────────────────────────────────
// Client.referralCodeId drives agent commission on every repeat loan
// (lib/referral-agents/commission.ts), so it is money. The decision logic is unit
// tested in lib/clients/referral-update.test.ts; these assert the ROUTE wiring:
// key-presence gating, the LOAN_ADMIN floor, and the audit.
//
// No CAS assertions here — the whole-row `updatedAt` optimistic lock this route
// already applies is strictly stronger than a per-field one.
describe("PUT /api/clients/[id] — referral-agent attribution", () => {
  beforeEach(() => {
    // Moving commission requires LOAN_ADMIN; their default fixture carries no role.
    requireApiRoleMock.mockResolvedValue({
      user: { id: "staff-1", email: "staff@example.test", role: "LOAN_ADMIN" },
    })
  })

  function updateData() {
    return (clientUpdateMock.mock.calls[0][0] as { data: Record<string, unknown> }).data
  }

  it("leaves the attribution alone when the key is absent", async () => {
    // The picker omits the key whenever its agent list failed to load. Writing
    // null would erase an agent's commission trail on an unrelated edit.
    const res = await PUT(putRequest({ firstName: "Sipho" }), context)
    expect(res.status).toBe(200)
    expect(updateData()).not.toHaveProperty("referralCodeId")
  })

  it("writes a validated ACTIVE code when the key is present", async () => {
    const res = await PUT(putRequest({ referralCodeId: "code-live" }), context)
    expect(res.status).toBe(200)
    expect(updateData().referralCodeId).toBe("code-live")
    // Tenant-scoped re-validation, not blind trust of the posted id.
    expect(referralFindFirstMock).toHaveBeenCalled()
  })

  it("rejects an unresolvable code with 400 and no write", async () => {
    referralFindFirstMock.mockResolvedValue(null)
    const res = await PUT(putRequest({ referralCodeId: "code-retired" }), context)
    expect(res.status).toBe(400)
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it("forbids a CREDIT_OFFICER from moving commission to another agent", async () => {
    requireApiRoleMock.mockResolvedValue({
      user: { id: "u1", email: "officer@x.co", role: "CREDIT_OFFICER" },
    })
    clientFindUniqueMock.mockResolvedValue(baseClient({ referralCodeId: "code-old" }))
    const res = await PUT(putRequest({ referralCodeId: "code-live" }), context)
    expect(res.status).toBe(403)
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it("records old -> new in the audit trail when the code moves", async () => {
    clientFindUniqueMock.mockResolvedValue(baseClient({ referralCodeId: "code-old" }))
    await PUT(putRequest({ referralCodeId: "code-live" }), context)
    const audit = auditLogCreateMock.mock.calls[0][0] as { data: { oldValue: Record<string, unknown>; newValue: Record<string, unknown> } }
    expect(audit.data.oldValue.referralCodeId).toBe("code-old")
    expect(audit.data.newValue.referralCodeId).toBe("code-live")
  })
})

// ── Retroactive accrual on re-attribution ────────────────────────────────────
// Attaching an agent must not just set the column and stop, or a client whose loan
// had already disbursed accrues nothing, silently and permanently. Manual
// attribution is the NORMAL path, so the losing path would be the normal path. The decisions live in
// lib/referral-agents/retro-attribution*; these assert the ROUTE wiring.
describe("PUT /api/clients/[id] — retroactive referral accrual", () => {
  beforeEach(() => {
    requireApiRoleMock.mockResolvedValue({
      user: { id: "staff-1", email: "staff@example.test", role: "LOAN_ADMIN" },
    })
    clientFindUniqueMock.mockResolvedValue(baseClient({ referralCodeId: "code-old" }))
  })

  it("accrues the client's past loans for the incoming agent", async () => {
    const res = await PUT(putRequest({ referralCodeId: "code-live" }), context)

    expect(res.status).toBe(200)
    expect(loadRetroAttributionPlanMock).toHaveBeenCalledWith(expect.anything(), {
      tenantId: "tenant-1",
      clientId: "client-1",
      incomingCodeId: "code-live",
      previousCodeId: "code-old",
      subjectOverride: {},
    })
    expect(applyRetroAttributionMock).toHaveBeenCalled()
  })

  // recordDisbursementCommission reads Client.referralCodeId to decide
  // WHO earns. Accruing before the column moves would credit the outgoing agent
  // all over again.
  it("writes the new attribution before it accrues against it", async () => {
    await PUT(putRequest({ referralCodeId: "code-live" }), context)

    expect(clientUpdateMock.mock.invocationCallOrder[0])
      .toBeLessThan(applyRetroAttributionMock.mock.invocationCallOrder[0])
  })

  it("reverses and accrues nothing when the agent is cleared", async () => {
    const res = await PUT(putRequest({ referralCodeId: null }), context)

    expect(res.status).toBe(200)
    expect(loadRetroAttributionPlanMock.mock.calls[0][1]).toMatchObject({ incomingCodeId: null })
    expect(updateData().referralCodeId).toBeNull()
    expect(applyRetroAttributionMock).toHaveBeenCalled()
  })

  // The key-presence contract in lib/clients/referral-update.ts: the picker
  // omits the key whenever its agent list failed to load, and an omitted key
  // must not touch the commission ledger any more than it touches the column.
  it("touches no commission at all when the key is omitted", async () => {
    const res = await PUT(putRequest({ firstName: "Sipho" }), context)

    expect(res.status).toBe(200)
    expect(loadRetroAttributionPlanMock).not.toHaveBeenCalled()
    expect(applyRetroAttributionMock).not.toHaveBeenCalled()
  })

  it("touches no commission when the posted code is the one already on file", async () => {
    const res = await PUT(putRequest({ referralCodeId: "code-old" }), context)

    expect(res.status).toBe(200)
    expect(loadRetroAttributionPlanMock).not.toHaveBeenCalled()
    expect(applyRetroAttributionMock).not.toHaveBeenCalled()
  })

  it("refuses the whole edit with 409 when the plan is blocked, leaving the client unchanged", async () => {
    loadRetroAttributionPlanMock.mockResolvedValue({
      accrue: [], reverse: [], skipped: [],
      blockers: [{ kind: "PAID_ROW_EXISTS", loanReference: "LN-0001", agentName: "Outgoing Agent" }],
    })

    const res = await PUT(putRequest({ referralCodeId: "code-live" }), context)

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("LN-0001") })
    expect(clientUpdateMock).not.toHaveBeenCalled()
    expect(applyRetroAttributionMock).not.toHaveBeenCalled()
  })

  // The floor is checked before anything reads the ledger, so a caller who may
  // not reassign cannot use the edit form to enumerate another agent's earnings.
  it("403s a CREDIT_OFFICER before any of this runs", async () => {
    requireApiRoleMock.mockResolvedValue({
      user: { id: "u1", email: "officer@x.co", role: "CREDIT_OFFICER" },
    })

    const res = await PUT(putRequest({ referralCodeId: "code-live" }), context)

    expect(res.status).toBe(403)
    expect(loadRetroAttributionPlanMock).not.toHaveBeenCalled()
    expect(applyRetroAttributionMock).not.toHaveBeenCalled()
  })

  // MED-3. The preview and the write each build their own plan. A rate change
  // between the two silently swaps the figure the operator approved for another.
  describe("preview binding", () => {
    function accruingPlan(commissionCents: number) {
      return {
        accrue: [{ loanReference: "LN-0001", commissionCents }],
        reverse: [], skipped: [], blockers: [],
      }
    }

    it("writes when the approved totals still match", async () => {
      loadRetroAttributionPlanMock.mockResolvedValue(accruingPlan(1_000))
      const res = await PUT(putRequest({
        referralCodeId: "code-live",
        referralImpact: { totalAccrueCents: 1_000, totalReverseCents: 0 },
      }), context)

      expect(res.status).toBe(200)
      expect(applyRetroAttributionMock).toHaveBeenCalled()
    })

    it("refuses with 409 and writes nothing when the figure moved underneath", async () => {
      loadRetroAttributionPlanMock.mockResolvedValue(accruingPlan(2_500))
      const res = await PUT(putRequest({
        referralCodeId: "code-live",
        referralImpact: { totalAccrueCents: 1_000, totalReverseCents: 0 },
      }), context)

      expect(res.status).toBe(409)
      // The same formatter the preview uses, non-breaking space and all,
      // so the two figures on one screen are not in two formats.
      expect(await res.json()).toMatchObject({
        error: expect.stringContaining("R\u00A025.00"),
      })
      expect(clientUpdateMock).not.toHaveBeenCalled()
      expect(applyRetroAttributionMock).not.toHaveBeenCalled()
    })

    // An API caller that never previewed is not broken by this.
    it("writes without the key at all", async () => {
      loadRetroAttributionPlanMock.mockResolvedValue(accruingPlan(2_500))
      const res = await PUT(putRequest({ referralCodeId: "code-live" }), context)

      expect(res.status).toBe(200)
      expect(applyRetroAttributionMock).toHaveBeenCalled()
    })

    // Enforcing a malformed approval is not possible, and ignoring it would make
    // the guard silently optional for anyone who sends it wrong.
    it.each([
      ["a non-object", "nonsense"],
      ["a missing total", { totalAccrueCents: 1_000 }],
      ["a fractional total", { totalAccrueCents: 1_000.5, totalReverseCents: 0 }],
      ["a negative total", { totalAccrueCents: -1, totalReverseCents: 0 }],
    ])("400s on %s", async (_label, referralImpact) => {
      const res = await PUT(putRequest({
        referralCodeId: "code-live", referralImpact,
      }), context)

      expect(res.status).toBe(400)
      expect(clientUpdateMock).not.toHaveBeenCalled()
    })

    // The key is meaningless without a referral change and must not become a
    // second, silent way to fail an ordinary edit.
    it("ignores the key when no referral change was requested", async () => {
      const res = await PUT(putRequest({
        firstName: "Sipho",
        referralImpact: { totalAccrueCents: 999_999, totalReverseCents: 0 },
      }), context)

      expect(res.status).toBe(200)
    })
  })

  function clientUpdatedAudit() {
    return auditLogCreateMock.mock.calls
      .map((call) => call[0].data)
      .find((data: { action: string }) => data.action === "CLIENT_UPDATED")
  }

  // MED-5. The route discarded the applier's return value, so a move that
  // accrued nothing left no trace of WHY.
  describe("audit trail", () => {
    it("records what the re-attribution accrued, reversed and skipped", async () => {
      applyRetroAttributionMock.mockResolvedValue({
        reversed: 1, accrued: 0, totalReverseCents: 900, totalAccrueCents: 0,
        skipped: [{ loanReference: "LN-0003", reason: "CLAWED_BACK" }],
      })

      await PUT(putRequest({ referralCodeId: "code-live" }), context)

      const audit = auditLogCreateMock.mock.calls
        .map((call) => call[0].data)
        .find((data: { action: string }) => data.action === "CLIENT_UPDATED")
      expect(audit.newValue.referralRetroAccrual).toEqual({
        reversed: 1, accrued: 0, totalReverseCents: 900, totalAccrueCents: 0,
        skipped: [{ loanReference: "LN-0003", reason: "CLAWED_BACK" }],
        bound: false,
      })
    })

    // The totals are enforced only when the caller sends them, and the
    // form omits them whenever the preview fetch failed. Fail-open is right — an
    // API caller that never previewed must still work — but an unbound money
    // write has to be distinguishable after the fact.
    it("records that the write was bound to figures an operator approved", async () => {
      loadRetroAttributionPlanMock.mockResolvedValue({
        accrue: [{ loanReference: "LN-0001", commissionCents: 1_000 }],
        reverse: [], skipped: [], blockers: [],
      })

      await PUT(putRequest({
        referralCodeId: "code-live",
        referralImpact: { totalAccrueCents: 1_000, totalReverseCents: 0 },
      }), context)

      expect(clientUpdatedAudit().newValue.referralRetroAccrual.bound).toBe(true)
    })

    it("records an unbound write as unbound rather than leaving it indistinguishable", async () => {
      await PUT(putRequest({ referralCodeId: "code-live" }), context)

      expect(clientUpdatedAudit().newValue.referralRetroAccrual.bound).toBe(false)
    })

    it("records nothing under that key when no referral change was requested", async () => {
      await PUT(putRequest({ firstName: "Sipho" }), context)

      const audit = auditLogCreateMock.mock.calls
        .map((call) => call[0].data)
        .find((data: { action: string }) => data.action === "CLIENT_UPDATED")
      expect(audit.newValue).not.toHaveProperty("referralRetroAccrual")
    })
  })

  // The self-referral heuristic compares the client against the agent,
  // so a request that renames the client AND assigns that agent must be checked
  // against the new name, not the stored one.
  it("plans against the identity fields this request will write", async () => {
    await PUT(putRequest({
      referralCodeId: "code-live",
      firstName: "Agent",
      lastName: "Two",
      phone: "0839999999",
      email: "agent@example.invalid",
    }), context)

    expect(loadRetroAttributionPlanMock.mock.calls[0][1]).toMatchObject({
      subjectOverride: {
        firstName: "Agent",
        lastName: "Two",
        phone: "0839999999",
        email: "agent@example.invalid",
      },
    })
  })

  // Key-presence again: a field the request does not carry must not be sent as
  // an override, or it would blank a stored value the check depends on.
  it("overrides only the identity fields the request actually carries", async () => {
    await PUT(putRequest({ referralCodeId: "code-live", firstName: "Sipho" }), context)

    const override = (loadRetroAttributionPlanMock.mock.calls[0][1] as {
      subjectOverride: Record<string, unknown>
    }).subjectOverride
    expect(override).toEqual({ firstName: "Sipho" })
  })

  // MED-6. Prisma's 5s default now covers ~7 extra serial round-trips per
  // accruing loan on top of the ~25 the client edit already makes.
  it("gives the transaction an explicit, bounded timeout", async () => {
    await PUT(putRequest({ referralCodeId: "code-live" }), context)

    const options = transactionMock.mock.calls[0][1] as { timeout?: number }
    expect(options.timeout).toBe(15_000)
  })

  function updateData() {
    return (clientUpdateMock.mock.calls[0][0] as { data: Record<string, unknown> }).data
  }
})
