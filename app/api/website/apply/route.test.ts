import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"

const getTenantFromRequestMock = vi.fn()
const checkRateLimitMock = vi.fn()
const resolveReferralCodeMock = vi.fn()
const recordReferralEventMock = vi.fn()
const createLeadMock = vi.fn()
const findUniqueLeadMock = vi.fn()
const updateLeadMock = vi.fn()
const txUpdateLeadMock = vi.fn()
const createCrmActivityMock = vi.fn()
const findUniqueClientMock = vi.fn()
const createClientMock = vi.fn()
const updateClientMock = vi.fn()
const findFirstLoanProductMock = vi.fn()
const findFirstLoanApplicationMock = vi.fn()
const createLoanApplicationMock = vi.fn()
const createAuditLogMock = vi.fn()
const txCreateAuditLogMock = vi.fn()
const createConsentRecordMock = vi.fn()
const resolveContactForLeadConversionMock = vi.fn()
const sendMessageMock = vi.fn()
const getOrCreateAgentMessageTemplateMock = vi.fn()
const sendEmailMock = vi.fn()
const notifyPriorLeadDuplicatesMock = vi.fn()
const createNotificationThrottleMock = vi.fn()
const deleteNotificationThrottleMock = vi.fn()
const queryRawMock = vi.fn()
const transactionMock = vi.fn()
const txClientDocumentFindManyMock = vi.fn()
const txClientDocumentUpdateManyMock = vi.fn()

const tx = {
  $queryRaw: (query: unknown) => queryRawMock(query),
  client: {
    findUnique: (a: unknown) => findUniqueClientMock(a),
    create: (a: unknown) => createClientMock(a),
    update: (a: unknown) => updateClientMock(a),
  },
  clientDocument: {
    findMany: (a: unknown) => txClientDocumentFindManyMock(a),
    updateMany: (a: unknown) => txClientDocumentUpdateManyMock(a),
  },
  loanProduct: { findFirst: (a: unknown) => findFirstLoanProductMock(a) },
  loanApplication: {
    findFirst: (a: unknown) => findFirstLoanApplicationMock(a),
    create: (a: unknown) => createLoanApplicationMock(a),
  },
  lead: {
    create: (a: unknown) => createLeadMock(a),
    update: (a: unknown) => txUpdateLeadMock(a),
  },
  crmActivity: { create: (a: unknown) => createCrmActivityMock(a) },
  auditLog: { create: (a: unknown) => txCreateAuditLogMock(a) },
  consentRecord: { create: (a: unknown) => createConsentRecordMock(a) },
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (cb: (client: typeof tx) => Promise<unknown>) => transactionMock(cb),
    lead: {
      create: (a: unknown) => createLeadMock(a),
      findUnique: (a: unknown) => findUniqueLeadMock(a),
      update: (a: unknown) => updateLeadMock(a),
    },
    crmActivity: { create: (a: unknown) => createCrmActivityMock(a) },
    client: {
      findUnique: (a: unknown) => findUniqueClientMock(a),
      create: (a: unknown) => createClientMock(a),
      update: (a: unknown) => updateClientMock(a),
    },
    loanProduct: { findFirst: (a: unknown) => findFirstLoanProductMock(a) },
    loanApplication: { findFirst: (a: unknown) => findFirstLoanApplicationMock(a), create: (a: unknown) => createLoanApplicationMock(a) },
    auditLog: { create: (a: unknown) => createAuditLogMock(a) },
    consentRecord: { create: (a: unknown) => createConsentRecordMock(a) },
    notificationThrottle: {
      create: (a: unknown) => createNotificationThrottleMock(a),
      delete: (a: unknown) => deleteNotificationThrottleMock(a),
    },
  },
}))
vi.mock("@/lib/config/identity", async () => {
  const { parseLenderIdentity } = await vi.importActual<typeof import("@/lib/config/identity")>("@/lib/config/identity")
  const { VALID_LENDER_COLUMNS } = await import("@/lib/config/__fixtures__/lender-identity")
  return { getLenderIdentity: async () => parseLenderIdentity(VALID_LENDER_COLUMNS) }
})
vi.mock("@/lib/tenant", () => ({
  getTenantFromRequest: (...args: unknown[]) => getTenantFromRequestMock(...args),
}))
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (key: string, conf: unknown) => checkRateLimitMock(key, conf),
  callerIp: () => "127.0.0.1",
}))
vi.mock("@/lib/referral-agents/referrals", () => ({
  resolveReferralCode: (...args: unknown[]) => resolveReferralCodeMock(...args),
  recordReferralEvent: (...args: unknown[]) => recordReferralEventMock(...args),
}))
vi.mock("@/lib/contact/provision", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/contact/provision")>()
  return {
    ContactPromotionConflictError: actual.ContactPromotionConflictError,
    resolveContactForLeadConversion: (...args: unknown[]) => resolveContactForLeadConversionMock(...args),
  }
})
vi.mock("@/lib/messaging/send", () => ({
  sendMessage: (a: unknown) => sendMessageMock(a),
}))
vi.mock("@/lib/messaging/agent-message-template", () => ({
  getOrCreateAgentMessageTemplate: (...args: unknown[]) => getOrCreateAgentMessageTemplateMock(...args),
}))
vi.mock("@/lib/email/service", () => ({
  sendEmail: (a: unknown) => sendEmailMock(a),
}))

vi.mock("@/lib/crm/lead-duplicate-notify", () => ({
  notifyPriorLeadDuplicatesBestEffort: (...a: unknown[]) => notifyPriorLeadDuplicatesMock(...a),
}))

// Deferral is the enumeration-safety mechanism under test: the notice must not
// run before the response exists. The stub records that the route handed it
// over WITHOUT running it; tests drain the queue afterwards, as the runtime
// does once the response has been sent.
const afterCallbacks: Array<() => unknown> = []
vi.mock("@/lib/http/after-response", () => ({
  deferAfterResponse: (fn: () => unknown) => { afterCallbacks.push(fn) },
}))

import { ContactPromotionConflictError } from "@/lib/contact/provision"
import { POST } from "./route"
import { fingerprintWebsiteSubmission } from "@/lib/applications/website-submission-idempotency"

function buildReq(body: object): NextRequest {
  return new NextRequest("https://staging.acme-lending.example/api/website/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

// Deliberately no email/idNumber — keeps requests out of the unrelated
// portal-registration branch of this route, which isn't this test's concern.
const validBody = {
  firstName: "Jane",
  lastName: "Doe",
  phone: "+27821234567",
  productType: "PERSONAL",
  amount: 5000,
  termDays: 60,
  turnstileToken: "any-token",
}

const snapshotReadyClient = {
  id: "client_real",
  firstName: "Jane",
  lastName: "Doe",
  email: "real.client@example.com",
  phone: "+27821234567",
  whatsapp: null,
  idNumber: "8001015000086",
  dateOfBirth: new Date("1980-01-01T00:00:00.000Z"),
  kycStatus: "VERIFIED" as const,
  kycVerifiedAt: new Date("2026-07-17T08:00:00.000Z"),
  kycVerifiedById: "officer-old",
  kycVerificationMethod: "SMILE_IDENTITY" as const,
  portalPassword: "hash",
  blacklisted: false,
  grossMonthlyIncome: 1_700_000,
  monthlyIncome: 1_500_000,
  monthlyExpenses: 500_000,
  expenseBreakdown: {
    id: "expense-1",
    updatedAt: new Date("2026-07-18T10:00:00Z"),
    housing: 200_000,
    transport: 75_000,
    food: 125_000,
    education: 0,
    insurance: 25_000,
    clothing: 25_000,
    entertainment: 0,
    medical: 25_000,
    other: 25_000,
    belowMleJustification: null,
  },
  debtObligations: [],
}

const personalProduct = {
  id: "prod_1",
  productType: "PERSONAL",
  active: true,
  minAmount: 100_000,
  maxAmount: 10_000_000,
  minTermDays: 30,
  maxTermDays: 90,
  interestRatePm: 0.03,
  interestModel: "DAILY_ACCRUAL" as const,
  initiationFeePct: 0.15,
  initiationFeeMax: 105_000,
  monthlyServiceFee: 6_900,
}

beforeEach(() => {
  vi.resetAllMocks()
  transactionMock.mockImplementation((cb: (client: typeof tx) => Promise<unknown>) => cb(tx))
  queryRawMock.mockResolvedValue([{ id: "locked" }])
  vi.unstubAllEnvs()
  vi.stubEnv("NEXT_PUBLIC_PORTAL_URL", "https://portal.lender.example")
  vi.stubEnv("TURNSTILE_SECRET_KEY", "1x0000000000000000AA")
  checkRateLimitMock.mockReturnValue({ allowed: true, remaining: 9, retryAfterSeconds: 0 })
  getTenantFromRequestMock.mockResolvedValue({ id: "tenant_acme", slug: "acme", name: "Acme Lending", domain: "acme-lending.example" })
  resolveReferralCodeMock.mockResolvedValue(null)
  recordReferralEventMock.mockResolvedValue(undefined)
  createLeadMock.mockResolvedValue({ id: "lead_1" })
  findUniqueLeadMock.mockResolvedValue(null)
  txUpdateLeadMock.mockResolvedValue({ id: "lead_1" })
  txCreateAuditLogMock.mockResolvedValue({ id: "audit_conversion" })
  createCrmActivityMock.mockResolvedValue({ id: "activity_1" })
  resolveContactForLeadConversionMock.mockResolvedValue({
    contact: {
      id: "contact_1",
      clientId: "client_real",
      leadId: "lead_1",
      status: "CLIENT",
      primaryEmail: "real.client@example.com",
      primaryPhone: "+27821234567",
      primaryWaJid: null,
    },
    created: false,
    resolution: "PROMOTED_LEAD_CONTACT",
    previous: {
      clientId: null,
      leadId: "lead_1",
      status: "LEAD",
      primaryEmail: "real.client@example.com",
      primaryPhone: "+27821234567",
      primaryWaJid: null,
    },
    preExistingIdentities: [],
    createdIdentities: [],
  })
  getOrCreateAgentMessageTemplateMock.mockResolvedValue({ id: "tpl_confirm" })
  sendMessageMock.mockResolvedValue({ id: "msg_1" })
  sendEmailMock.mockResolvedValue({ ok: true, messageId: "em_1" })
  createNotificationThrottleMock.mockResolvedValue({ id: "throttle_1" })
  deleteNotificationThrottleMock.mockResolvedValue({ id: "throttle_1" })
  txClientDocumentFindManyMock.mockResolvedValue([])
  txClientDocumentUpdateManyMock.mockResolvedValue({ count: 0 })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("POST /api/website/apply — referral signal gating", () => {
  it("rejects a submitted expense total below the Regulation 23A minimum before writing records", async () => {
    const res = await POST(buildReq({
      ...validBody,
      monthlyIncome: 10_000,
      monthlyExpenses: 0,
    }))

    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/Regulation 23A minimum/i)
    expect(createLeadMock).not.toHaveBeenCalled()
    expect(createClientMock).not.toHaveBeenCalled()
    expect(createLoanApplicationMock).not.toHaveBeenCalled()
  })

  it("personal/PO-funding application with no referral params: no referral tag, no event, still succeeds", async () => {
    const res = await POST(buildReq(validBody))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(createLeadMock).toHaveBeenCalledTimes(1)
    const leadArgs = createLeadMock.mock.calls[0][0]
    expect(leadArgs.data.tags).not.toContain("referral-application")
    expect(recordReferralEventMock).not.toHaveBeenCalled()
  })

  it("application with a referralCode: tagged referral-application + exactly one referral event", async () => {
    resolveReferralCodeMock.mockResolvedValue({ id: "code_1", agentId: "agent_1" })
    const res = await POST(buildReq({ ...validBody, referralCode: "AGENT-001" }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    const leadArgs = createLeadMock.mock.calls[0][0]
    expect(leadArgs.data.tags).toContain("referral-application")
    expect(recordReferralEventMock).toHaveBeenCalledTimes(1)
  })

  it("referral event write failure: still 200 with lead created, not a 500", async () => {
    recordReferralEventMock.mockRejectedValue(new Error("relation referral_event does not exist"))
    const res = await POST(buildReq({ ...validBody, referralCode: "AGENT-001" }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(createLeadMock).toHaveBeenCalledTimes(1)
    expect(recordReferralEventMock).toHaveBeenCalledTimes(1)
  })
})

describe("POST /api/website/apply — request idempotency", () => {
  const submissionKey = "dc7c2b90-7248-4e4f-ae85-cf63ceea66f4"
  const body = {
    ...validBody,
    email: "idempotent.client@example.com",
    idNumber: "8001015000086",
    employmentStatus: "EMPLOYED",
    employerName: "Synthetic Employer",
    monthlyIncome: 15_000,
    monthlyExpenses: 5_000,
    popiaConsent: true,
    submissionKey,
  }

  it("rejects a malformed key before creating a Lead", async () => {
    const response = await POST(buildReq({ ...validBody, submissionKey: "not-a-uuid" }))

    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/submission request/i)
    expect(createLeadMock).not.toHaveBeenCalled()
  })

  it("binds a first request's key, fingerprint and visible reference to its Lead", async () => {
    createLeadMock.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: "lead_original",
        convertedToClientId: null,
        convertedToApplicationId: null,
        ...data,
      }),
    )

    const response = await POST(buildReq({
      ...validBody,
      submissionKey,
    }))

    expect(response.status).toBe(200)
    expect(createLeadMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        submissionKey,
        submissionFingerprint: fingerprintWebsiteSubmission({
          ...validBody,
          submissionKey,
        }),
        submissionReference: expect.stringMatching(/^WEB-/),
      }),
    })
    const leadData = createLeadMock.mock.calls[0][0].data
    expect((await response.json()).reference).toBe(leadData.submissionReference)
    expect(createCrmActivityMock).toHaveBeenCalledOnce()
  })

  it("returns the original successful result for a completed retry without duplicate side effects", async () => {
    createLeadMock.mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "5.x" },
    ))
    findUniqueLeadMock.mockResolvedValue({
      id: "lead_original",
      submissionKey,
      submissionFingerprint: fingerprintWebsiteSubmission(body),
      submissionReference: "WEB-ORIGINAL",
      convertedToClientId: "client_original",
      convertedToApplicationId: "app_original",
      status: "CONVERTED",
    })
    findFirstLoanApplicationMock.mockResolvedValue({
      id: "app_original",
      reference: "WEB-ORIGINAL",
      client: { portalPassword: null },
    })

    const response = await POST(buildReq(body))
    const result = await response.json()

    expect(response.status).toBe(200)
    expect(result).toEqual({
      success: true,
      reference: "WEB-ORIGINAL",
      applicationId: "app_original",
      portalAccountStatus: "activation_required",
    })
    expect(createCrmActivityMock).not.toHaveBeenCalled()
    expect(recordReferralEventMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it("waits on a shared in-flight Lead and returns the winner's application", async () => {
    createLeadMock.mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "5.x" },
    ))
    findUniqueLeadMock.mockResolvedValue({
      id: "lead_original",
      submissionKey,
      submissionFingerprint: fingerprintWebsiteSubmission(body),
      submissionReference: "WEB-ORIGINAL",
      convertedToClientId: null,
      convertedToApplicationId: null,
      status: "NEW",
    })
    findUniqueClientMock.mockResolvedValue(null)
    findFirstLoanProductMock.mockResolvedValue(personalProduct)
    queryRawMock.mockResolvedValue([{
      id: "lead_original",
      status: "CONVERTED",
      convertedToClientId: "client_original",
      convertedToApplicationId: "app_original",
    }])
    findFirstLoanApplicationMock.mockResolvedValue({
      id: "app_original",
      reference: "WEB-ORIGINAL",
      client: { portalPassword: "hash" },
    })

    const response = await POST(buildReq(body))
    const result = await response.json()

    expect(response.status).toBe(200)
    expect(result).toEqual({
      success: true,
      reference: "WEB-ORIGINAL",
      applicationId: "app_original",
      portalAccountStatus: "ready",
    })
    expect(createCrmActivityMock).not.toHaveBeenCalled()
    expect(createClientMock).not.toHaveBeenCalled()
    expect(createLoanApplicationMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it("replays the winner when it commits before the retry's client lookup", async () => {
    createLeadMock.mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "5.x" },
    ))
    findUniqueLeadMock.mockResolvedValue({
      id: "lead_original",
      submissionKey,
      submissionFingerprint: fingerprintWebsiteSubmission(body),
      submissionReference: "WEB-ORIGINAL",
      convertedToClientId: null,
      convertedToApplicationId: null,
      status: "NEW",
    })
    findUniqueClientMock.mockResolvedValue({
      ...snapshotReadyClient,
      id: "client_original",
      email: body.email,
      idNumber: body.idNumber,
      portalPassword: null,
    })
    findFirstLoanProductMock.mockResolvedValue(personalProduct)
    findFirstLoanApplicationMock.mockResolvedValue({
      id: "app_original",
      reference: "WEB-ORIGINAL",
      status: "SUBMITTED",
      client: { portalPassword: null },
    })
    queryRawMock.mockResolvedValue([{
      id: "lead_original",
      status: "CONVERTED",
      convertedToClientId: "client_original",
      convertedToApplicationId: "app_original",
    }])

    const response = await POST(buildReq(body))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      reference: "WEB-ORIGINAL",
      applicationId: "app_original",
      portalAccountStatus: "activation_required",
    })
    expect(createAuditLogMock).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "APPLICATION_SUBMISSION_BLOCKED",
        newValue: expect.objectContaining({ reason: "open_application_exists" }),
      }),
    }))
    expect(createLoanApplicationMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it("rejects reuse of a key with a changed material payload", async () => {
    createLeadMock.mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "5.x" },
    ))
    findUniqueLeadMock.mockResolvedValue({
      id: "lead_original",
      submissionKey,
      submissionFingerprint: fingerprintWebsiteSubmission({ ...body, amount: 4_000 }),
      submissionReference: "WEB-ORIGINAL",
      convertedToClientId: null,
      convertedToApplicationId: null,
      status: "NEW",
    })

    const response = await POST(buildReq(body))

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/submission request/i)
    expect(createCrmActivityMock).not.toHaveBeenCalled()
    expect(findUniqueClientMock).not.toHaveBeenCalled()
  })
})

describe("POST /api/website/apply — client linking & compliance safety", () => {
  const withIdentity = {
    ...validBody,
    email: "real.client@example.com",
    idNumber: "8001015000086",
    productType: "PERSONAL",
    amount: 5000,
  }

  beforeEach(() => {
    findFirstLoanProductMock.mockResolvedValue(null) // no product match by default, isolates client-linking behavior
    createAuditLogMock.mockResolvedValue(undefined)
  })

  it("rejects a one-sided expense declaration before any client or lead mutation", async () => {
    const res = await POST(buildReq({ ...withIdentity, monthlyExpenses: 0 }))
    const body = await res.json()

    expect(res.status).toBe(422)
    expect(body.error).toMatch(/income and monthly expenses must be submitted together/i)
    expect(createLeadMock).not.toHaveBeenCalled()
    expect(updateClientMock).not.toHaveBeenCalled()
    expect(createClientMock).not.toHaveBeenCalled()
    expect(createLoanApplicationMock).not.toHaveBeenCalled()
  })

  it("a partial identity match (only email matches a real client) does NOT update the existing client", async () => {
    const realClient = { id: "client_real", email: "real.client@example.com", idNumber: "9999999999999", portalPassword: null, blacklisted: false }
    findUniqueClientMock.mockImplementation(({ where }: { where: { email?: string; idNumber?: string } }) =>
      Promise.resolve(where.email ? realClient : null),
    )

    const res = await POST(buildReq(withIdentity))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.portalAccountStatus).toBe("unavailable")
    expect(updateClientMock).not.toHaveBeenCalled()
    expect(createClientMock).not.toHaveBeenCalled()
    expect(createAuditLogMock).toHaveBeenCalledTimes(1)
    expect(createAuditLogMock.mock.calls[0][0].data.newValue.reason).toBe("identity_conflict")
  })

  it("a partial identity match (only idNumber matches a real client) does NOT create or update a client", async () => {
    const realClient = { id: "client_real", email: "someone.else@example.com", idNumber: "8001015000086", portalPassword: null, blacklisted: false }
    findUniqueClientMock.mockImplementation(({ where }: { where: { email?: string; idNumber?: string } }) =>
      Promise.resolve(where.idNumber ? realClient : null),
    )

    const res = await POST(buildReq(withIdentity))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.portalAccountStatus).toBe("unavailable")
    expect(updateClientMock).not.toHaveBeenCalled()
    expect(createClientMock).not.toHaveBeenCalled()
    expect(createAuditLogMock).toHaveBeenCalledTimes(1)
    expect(createAuditLogMock.mock.calls[0][0].data.newValue.reason).toBe("identity_conflict")
  })

  it("does not mutate a confirmed existing client when no application is created", async () => {
    const realClient = { id: "client_real", email: "real.client@example.com", idNumber: "8001015000086", portalPassword: "hash", blacklisted: false }
    findUniqueClientMock.mockResolvedValue(realClient)
    updateClientMock.mockResolvedValue(realClient)

    const res = await POST(buildReq(withIdentity))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.portalAccountStatus).toBe("unavailable")
    expect(updateClientMock).not.toHaveBeenCalled()
    expect(resolveContactForLeadConversionMock).not.toHaveBeenCalled()
    expect(createConsentRecordMock).not.toHaveBeenCalled()
  })

  it("does not let the public form rewrite a returning client's financial master data", async () => {
    findUniqueClientMock.mockResolvedValue(snapshotReadyClient)

    const res = await POST(buildReq({
      ...withIdentity,
      monthlyIncome: 15_000,
      monthlyExpenses: 6_000,
    }))
    const body = await res.json()

    expect(res.status).toBe(422)
    expect(body.error).toMatch(/sign in to the client portal/i)
    expect(updateClientMock).not.toHaveBeenCalled()
    expect(createLoanApplicationMock).not.toHaveBeenCalled()
    expect(createAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "APPLICATION_SUBMISSION_BLOCKED",
        entityId: snapshotReadyClient.id,
        oldValue: {
          monthlyIncome: snapshotReadyClient.monthlyIncome,
          monthlyExpenses: snapshotReadyClient.monthlyExpenses,
        },
        newValue: expect.objectContaining({
          reason: "financial_profile_update_requires_authentication",
          declaredMonthlyExpenses: 600_000,
        }),
      }),
    }))
  })

  it("no existing match, consent NOT affirmed: creates the client and application atomically without a ConsentRecord", async () => {
    const newClient = { ...snapshotReadyClient, id: "client_new", portalPassword: null }
    findUniqueClientMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(newClient)
    findFirstLoanProductMock.mockResolvedValue(personalProduct)
    findFirstLoanApplicationMock.mockResolvedValue(null)
    createClientMock.mockResolvedValue(newClient)
    createLoanApplicationMock.mockResolvedValue({ id: "app_new", reference: "APP-NEW" })

    const res = await POST(buildReq({
      ...withIdentity,
      monthlyIncome: 15_000,
      monthlyExpenses: 5_000,
    })) // no popiaConsent
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.portalAccountStatus).toBe("activation_required")
    expect(createClientMock).toHaveBeenCalledTimes(1)
    const createArgs = createClientMock.mock.calls[0][0]
    // Not fabricated: recorded explicitly false, never "granted" without the box.
    expect(createArgs.data.popiaConsentGiven).toBe(false)
    expect(createArgs.data.popiaConsentAt).toBeNull()
    expect(createConsentRecordMock).not.toHaveBeenCalled()
    expect(txCreateAuditLogMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CLIENT_CREATED",
        entityId: "client_new",
        newValue: expect.objectContaining({
          leadId: "lead_1",
          contactId: "contact_1",
        }),
      }),
    })
    expect(txUpdateLeadMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        convertedToClientId: "client_new",
        convertedToApplicationId: "app_new",
      }),
    }))
    expect(resolveContactForLeadConversionMock).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        tenantId: "tenant_acme",
        leadId: "lead_1",
        clientId: "client_new",
        source: "APPLICATION_FORM",
        reuseExistingClientContact: false,
        reconcileIdentitiesOnReuse: true,
      }),
    )
    expect(txCreateAuditLogMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CONTACT_PROMOTED_LEAD_TO_CLIENT",
        entity: "Contact",
        entityId: "contact_1",
        oldValue: expect.objectContaining({ status: "LEAD" }),
        newValue: expect.objectContaining({
          source: "website_apply",
          conversionLeadId: "lead_1",
          resolution: "PROMOTED_LEAD_CONTACT",
          primaryEmail: "real.client@example.com",
          primaryPhone: "+27821234567",
          primaryWaJid: null,
        }),
      }),
    })
  })

  it("no existing match, consent AFFIRMED: sets popiaConsentGiven=true + popiaConsentAt and writes a POPIA_APPLICATION ConsentRecord", async () => {
    const newClient = { ...snapshotReadyClient, id: "client_new", portalPassword: null }
    findUniqueClientMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(newClient)
    findFirstLoanProductMock.mockResolvedValue(personalProduct)
    findFirstLoanApplicationMock.mockResolvedValue(null)
    createClientMock.mockResolvedValue(newClient)
    createLoanApplicationMock.mockResolvedValue({ id: "app_new", reference: "APP-NEW" })
    createConsentRecordMock.mockResolvedValue({ id: "consent_1" })

    const res = await POST(buildReq({
      ...withIdentity,
      monthlyIncome: 15_000,
      monthlyExpenses: 5_000,
      popiaConsent: true,
    }))
    await res.json()

    expect(res.status).toBe(200)
    const createArgs = createClientMock.mock.calls[0][0]
    expect(createArgs.data.popiaConsentGiven).toBe(true)
    expect(createArgs.data.popiaConsentAt).toBeInstanceOf(Date)
    expect(createConsentRecordMock).toHaveBeenCalledTimes(1)
    const consentArgs = createConsentRecordMock.mock.calls[0][0]
    expect(consentArgs.data).toMatchObject({
      tenantId: "tenant_acme",
      clientId: "client_new",
      type: "POPIA_APPLICATION",
      granted: true,
      method: "website_apply",
    })
    expect(consentArgs.data.ipAddress).toBeTruthy()
  })

  it("consent is only truthy-strict: a non-boolean popiaConsent does not grant consent", async () => {
    const newClient = { ...snapshotReadyClient, id: "client_new", portalPassword: null }
    findUniqueClientMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(newClient)
    findFirstLoanProductMock.mockResolvedValue(personalProduct)
    findFirstLoanApplicationMock.mockResolvedValue(null)
    createClientMock.mockResolvedValue(newClient)
    createLoanApplicationMock.mockResolvedValue({ id: "app_new", reference: "APP-NEW" })

    const res = await POST(buildReq({
      ...withIdentity,
      monthlyIncome: 15_000,
      monthlyExpenses: 5_000,
      popiaConsent: "yes",
    }))
    await res.json()

    const createArgs = createClientMock.mock.calls[0][0]
    expect(createArgs.data.popiaConsentGiven).toBe(false)
    expect(createConsentRecordMock).not.toHaveBeenCalled()
  })

  it("an invalid SA ID number (bad checksum) is rejected 400 before any DB write", async () => {
    // 8001015000087 fails the Luhn check (valid one is …086).
    const res = await POST(buildReq({ ...withIdentity, idNumber: "8001015000087" }))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(String(body.error)).toMatch(/valid 13-digit South African ID/i)
    expect(createLeadMock).not.toHaveBeenCalled()
    expect(createClientMock).not.toHaveBeenCalled()
  })

  it("a blacklisted client does NOT get a new LoanApplication, and the block is audited", async () => {
    const blacklistedClient = { id: "client_bl", email: "real.client@example.com", idNumber: "8001015000086", portalPassword: null, blacklisted: true }
    findUniqueClientMock.mockResolvedValue(blacklistedClient)
    updateClientMock.mockResolvedValue(blacklistedClient)
    findFirstLoanProductMock.mockResolvedValue({ id: "prod_1", productType: "PERSONAL", active: true, minAmount: 100000, maxAmount: 10000000, minTermDays: 30, maxTermDays: 90 })

    const res = await POST(buildReq(withIdentity))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.applicationId).toBeNull()
    expect(createLoanApplicationMock).not.toHaveBeenCalled()
    expect(findFirstLoanProductMock).not.toHaveBeenCalled()
    const auditActions = createAuditLogMock.mock.calls.map((c) => c[0].data.action)
    expect(auditActions).toContain("APPLICATION_SUBMISSION_BLOCKED")
  })

  it("a matched, non-blacklisted client within product range creates a LoanApplication WITHOUT fabricating affordability declaration", async () => {
    const realClient = snapshotReadyClient
    findUniqueClientMock.mockResolvedValue(realClient)
    updateClientMock.mockResolvedValue(realClient)
    findFirstLoanProductMock.mockResolvedValue(personalProduct)
    findFirstLoanApplicationMock.mockResolvedValue(null)
    createLoanApplicationMock.mockResolvedValue({ id: "app_1", reference: "APP-TEST-0001" })
    txUpdateLeadMock.mockResolvedValue({ id: "lead_1" })

    const res = await POST(buildReq(withIdentity))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.applicationId).toBe("app_1")
    expect(createLoanApplicationMock).toHaveBeenCalledTimes(1)
    expect(txUpdateLeadMock).toHaveBeenCalledWith({
      where: { id: "lead_1", tenantId: "tenant_acme" },
      data: expect.objectContaining({
        status: "CONVERTED",
        statusChangedAt: expect.any(Date),
        convertedToClientId: "client_real",
        convertedToApplicationId: "app_1",
      }),
    })
    expect(txCreateAuditLogMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "LEAD_CONVERTED",
        entity: "Lead",
        entityId: "lead_1",
        newValue: expect.objectContaining({
          status: "CONVERTED",
          convertedToClientId: "client_real",
          applicationId: "app_1",
          contactId: "contact_1",
        }),
      }),
    })
    expect(resolveContactForLeadConversionMock).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        tenantId: "tenant_acme",
        leadId: "lead_1",
        clientId: "client_real",
        source: "APPLICATION_FORM",
        reuseExistingClientContact: true,
        reconcileIdentitiesOnReuse: true,
      }),
    )
    expect(queryRawMock).toHaveBeenCalledTimes(5)
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      findUniqueClientMock.mock.invocationCallOrder[0],
    )
    expect(findUniqueClientMock.mock.invocationCallOrder[0]).toBeLessThan(
      findUniqueClientMock.mock.invocationCallOrder[1],
    )
    expect(findUniqueClientMock.mock.invocationCallOrder[1]).toBeLessThan(
      queryRawMock.mock.invocationCallOrder[1],
    )
    expect(queryRawMock.mock.invocationCallOrder[4]).toBeLessThan(
      createLoanApplicationMock.mock.invocationCallOrder[0],
    )
    expect(updateClientMock).toHaveBeenCalledTimes(1)
    expect(createLoanApplicationMock.mock.invocationCallOrder[0]).toBeLessThan(
      txCreateAuditLogMock.mock.invocationCallOrder.find(
        (order, index) => txCreateAuditLogMock.mock.calls[index]?.[0]?.data?.action === "APPLICATION_SUBMITTED_BY_CLIENT",
      ) ?? Number.POSITIVE_INFINITY,
    )
    expect(txCreateAuditLogMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "APPLICATION_SUBMITTED_BY_CLIENT",
        entityId: "app_1",
        userEmail: "real.client@example.com",
      }),
    })
    const applicationAuditIndex = txCreateAuditLogMock.mock.calls.findIndex(
      (call) => call[0].data.action === "APPLICATION_SUBMITTED_BY_CLIENT",
    )
    expect(applicationAuditIndex).toBeGreaterThanOrEqual(0)
    const leadAuditIndex = txCreateAuditLogMock.mock.calls.findIndex(
      (call) => call[0].data.action === "LEAD_CONVERTED",
    )
    expect(leadAuditIndex).toBeGreaterThanOrEqual(0)
    expect(txCreateAuditLogMock.mock.invocationCallOrder[applicationAuditIndex]).toBeLessThan(
      txUpdateLeadMock.mock.invocationCallOrder[0],
    )
    expect(txUpdateLeadMock.mock.invocationCallOrder[0]).toBeLessThan(
      txCreateAuditLogMock.mock.invocationCallOrder[leadAuditIndex],
    )
    expect(updateLeadMock).not.toHaveBeenCalled()
    expect(updateClientMock.mock.invocationCallOrder[0]).toBeLessThan(
      createLoanApplicationMock.mock.invocationCallOrder[0],
    )
    const clientUpdate = updateClientMock.mock.calls[0][0]
    expect(clientUpdate.data).not.toHaveProperty("monthlyIncome")
    expect(clientUpdate.data).not.toHaveProperty("monthlyExpenses")
    expect(clientUpdate.data).not.toHaveProperty("expenseBreakdown")
    const appArgs = createLoanApplicationMock.mock.calls[0][0]
    expect(appArgs.data).not.toHaveProperty("clientAffordabilityDeclaredAt")
    expect(appArgs.data).not.toHaveProperty("pasqAcknowledgedAt")
    expect(appArgs.data.affordabilityResult).toEqual(expect.objectContaining({
      schemaVersion: 3,
      submission: expect.objectContaining({
        policyVersion: "submission-ndi-v3",
        expenses: expect.objectContaining({
          sourceId: "expense-1",
          grossMonthlyIncomeCents: 1_700_000,
          breakdownTotalCents: 500_000,
        }),
        calculator: expect.objectContaining({
          version: "loan-calculator-v3",
          contractFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    }))
  })

  it("revokes verified selfies when a returning application changes the biometric name", async () => {
    findUniqueClientMock.mockResolvedValue(snapshotReadyClient)
    findFirstLoanProductMock.mockResolvedValue(personalProduct)
    findFirstLoanApplicationMock.mockResolvedValue(null)
    createLoanApplicationMock.mockResolvedValue({ id: "app_1", reference: "APP-TEST-0001" })
    txUpdateLeadMock.mockResolvedValue({ id: "lead_1" })
    txClientDocumentFindManyMock.mockResolvedValueOnce([{ id: "selfie-old" }])
    txClientDocumentUpdateManyMock.mockResolvedValueOnce({ count: 1 })
    updateClientMock.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
      ...snapshotReadyClient,
      ...data,
    }))

    const response = await POST(buildReq({ ...withIdentity, firstName: "Janet" }))

    expect(response.status).toBe(200)
    expect(updateClientMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        firstName: "Janet",
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      }),
    }))
    expect(txClientDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ["selfie-old"] } }),
      data: expect.objectContaining({ verified: false }),
    }))
    expect(txCreateAuditLogMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "KYC_STATUS_CHANGED",
        oldValue: expect.objectContaining({
          clientKyc: expect.objectContaining({ kycVerifiedById: "officer-old" }),
        }),
        newValue: expect.objectContaining({
          invalidatedDocumentIds: ["selfie-old"],
          clientKyc: expect.objectContaining({ kycVerifiedById: null }),
        }),
      }),
    })
  })

  it("rebuilds website submission evidence from the locked client and product rows", async () => {
    const lockedClient = { ...snapshotReadyClient, monthlyIncome: 1_600_000 }
    const lockedProduct = { ...personalProduct, interestRatePm: 0.04 }
    findUniqueClientMock
      .mockResolvedValueOnce(snapshotReadyClient)
      .mockResolvedValueOnce(snapshotReadyClient)
      .mockResolvedValueOnce(lockedClient)
    updateClientMock.mockResolvedValue(lockedClient)
    findFirstLoanProductMock
      .mockResolvedValueOnce(personalProduct)
      .mockResolvedValueOnce(personalProduct)
      .mockResolvedValueOnce(lockedProduct)
    findFirstLoanApplicationMock.mockResolvedValue(null)
    createLoanApplicationMock.mockResolvedValue({ id: "app_1", reference: "APP-TEST-0001" })
    txUpdateLeadMock.mockResolvedValue({ id: "lead_1" })

    const res = await POST(buildReq(withIdentity))

    expect(res.status).toBe(200)
    const submission = createLoanApplicationMock.mock.calls[0][0].data.affordabilityResult.submission
    expect(submission.inputs.monthlyIncomeCents).toBe(1_600_000)
    expect(submission.inputs.interestRatePm).toBe(0.04)
    expect(queryRawMock.mock.invocationCallOrder[4]).toBeLessThan(
      findUniqueClientMock.mock.invocationCallOrder[2],
    )
    expect(findFirstLoanProductMock.mock.invocationCallOrder[2]).toBeLessThan(
      createLoanApplicationMock.mock.invocationCallOrder[0],
    )
  })

  it("fails closed when the website submission audit cannot be written", async () => {
    findUniqueClientMock.mockResolvedValue(snapshotReadyClient)
    updateClientMock.mockResolvedValue(snapshotReadyClient)
    findFirstLoanProductMock.mockResolvedValue(personalProduct)
    findFirstLoanApplicationMock.mockResolvedValue(null)
    createLoanApplicationMock.mockResolvedValue({ id: "app_1", reference: "APP-TEST-0001" })
    txUpdateLeadMock.mockResolvedValue({ id: "lead_1" })
    txCreateAuditLogMock.mockImplementation((args: { data?: { action?: string } }) => {
      if (args.data?.action === "APPLICATION_SUBMITTED_BY_CLIENT") {
        return Promise.reject(new Error("audit unavailable"))
      }
      return Promise.resolve({ id: "audit-other" })
    })

    const response = await POST(buildReq(withIdentity))

    expect(response.status).toBe(500)
    expect(createLoanApplicationMock).toHaveBeenCalledOnce()
    expect(txCreateAuditLogMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "APPLICATION_SUBMITTED_BY_CLIENT" }),
    })
    expect(txUpdateLeadMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it("fails closed when the Contact conversion audit cannot be written", async () => {
    findUniqueClientMock.mockResolvedValue(snapshotReadyClient)
    updateClientMock.mockResolvedValue(snapshotReadyClient)
    findFirstLoanProductMock.mockResolvedValue(personalProduct)
    findFirstLoanApplicationMock.mockResolvedValue(null)
    createLoanApplicationMock.mockResolvedValue({ id: "app_1", reference: "APP-TEST-0001" })
    txCreateAuditLogMock.mockImplementation((args: { data?: { action?: string } }) => {
      if (args.data?.action === "CONTACT_PROMOTED_LEAD_TO_CLIENT") {
        return Promise.reject(new Error("contact audit unavailable"))
      }
      return Promise.resolve({ id: "audit-other" })
    })

    const response = await POST(buildReq(withIdentity))

    expect(response.status).toBe(500)
    expect(txCreateAuditLogMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CONTACT_PROMOTED_LEAD_TO_CLIENT",
        entity: "Contact",
        entityId: "contact_1",
      }),
    })
    expect(createLoanApplicationMock).not.toHaveBeenCalled()
    expect(txUpdateLeadMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it("does not report or notify success when the in-transaction lead conversion fails", async () => {
    findUniqueClientMock.mockResolvedValue(snapshotReadyClient)
    updateClientMock.mockResolvedValue(snapshotReadyClient)
    findFirstLoanProductMock.mockResolvedValue(personalProduct)
    findFirstLoanApplicationMock.mockResolvedValue(null)
    createLoanApplicationMock.mockResolvedValue({ id: "app_1", reference: "APP-TEST-0001" })
    txUpdateLeadMock.mockRejectedValueOnce(new Error("lead write failed"))

    const res = await POST(buildReq(withIdentity))

    expect(res.status).toBe(500)
    expect(createLoanApplicationMock).toHaveBeenCalledOnce()
    expect(txUpdateLeadMock).toHaveBeenCalledOnce()
    expect(txCreateAuditLogMock).toHaveBeenCalledTimes(3)
    expect(txCreateAuditLogMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "APPLICATION_SUBMITTED_BY_CLIENT" }),
    })
    expect(updateLeadMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it.each(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED"])(
    "returns 409 and emits no submission event when a %s application is already open",
    async (status) => {
      const realClient = snapshotReadyClient
      findUniqueClientMock.mockResolvedValue(realClient)
      updateClientMock.mockResolvedValue(realClient)
      findFirstLoanProductMock.mockResolvedValue(personalProduct)
      findFirstLoanApplicationMock.mockResolvedValue({
        id: "app_existing",
        reference: "APP-EXISTING",
        status,
      })

      const res = await POST(buildReq({ ...withIdentity, amount: 7_500 }))
      const body = await res.json()

      expect(res.status).toBe(409)
      expect(body).toEqual(expect.objectContaining({
        success: false,
        applicationId: "app_existing",
        reference: "APP-EXISTING",
        status,
      }))
      expect(createLoanApplicationMock).not.toHaveBeenCalled()
      expect(updateClientMock).not.toHaveBeenCalled()
      expect(updateLeadMock).not.toHaveBeenCalled()
      expect(txUpdateLeadMock).not.toHaveBeenCalled()
      expect(sendMessageMock).not.toHaveBeenCalled()
      expect(sendEmailMock).not.toHaveBeenCalled()
      expect(createCrmActivityMock).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          subject: "Online enquiry received",
          notes: expect.stringContaining("application attempt received"),
        }),
      }))

      const auditRows = createAuditLogMock.mock.calls.map((call) => call[0].data)
      expect(auditRows).toContainEqual(expect.objectContaining({
        action: "APPLICATION_SUBMISSION_BLOCKED",
        entityId: "app_existing",
        newValue: expect.objectContaining({
          reason: "open_application_exists",
          existingStatus: status,
          requestedAmount: 750_000,
        }),
      }))
      expect(auditRows).not.toContainEqual(expect.objectContaining({
        action: "APPLICATION_SUBMITTED_BY_CLIENT",
      }))
    },
  )

  it("returns 409 for a pre-existing open application after a keyed request reaches the Lead lock", async () => {
    createLeadMock.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: "lead_keyed_open",
        convertedToClientId: null,
        convertedToApplicationId: null,
        ...data,
      }),
    )
    findUniqueClientMock.mockResolvedValue(snapshotReadyClient)
    findFirstLoanProductMock.mockResolvedValue(personalProduct)
    findFirstLoanApplicationMock.mockResolvedValue({
      id: "app_existing",
      reference: "APP-EXISTING",
      status: "SUBMITTED",
    })

    const res = await POST(buildReq({
      ...withIdentity,
      submissionKey: "d47e4db5-0726-4e4c-a8d9-5e780e76229a",
    }))
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toEqual(expect.objectContaining({
      applicationId: "app_existing",
      reference: "APP-EXISTING",
      status: "SUBMITTED",
    }))
    expect(createLoanApplicationMock).not.toHaveBeenCalled()
    expect(updateClientMock).not.toHaveBeenCalled()
    expect(txUpdateLeadMock).not.toHaveBeenCalled()
    expect(createAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "APPLICATION_SUBMISSION_BLOCKED",
        newValue: expect.objectContaining({ reason: "open_application_exists" }),
      }),
    }))
  })

  it("maps a database-enforced concurrent open-application collision to 409", async () => {
    findUniqueClientMock.mockResolvedValue(snapshotReadyClient)
    updateClientMock.mockResolvedValue(snapshotReadyClient)
    findFirstLoanProductMock.mockResolvedValue(personalProduct)
    findFirstLoanApplicationMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "app_winner",
        reference: "APP-WINNER",
        status: "SUBMITTED",
      })
    createLoanApplicationMock.mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "5.x" },
    ))

    const res = await POST(buildReq(withIdentity))
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toEqual(expect.objectContaining({
      applicationId: "app_winner",
      reference: "APP-WINNER",
      status: "SUBMITTED",
    }))
    expect(updateLeadMock).not.toHaveBeenCalled()
    expect(txUpdateLeadMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
    // These writes happened on the same mocked transaction before the unique
    // application insert failed; a real PostgreSQL transaction rolls them all
    // back (covered by the DB integration test).
    expect(updateClientMock).toHaveBeenCalledOnce()
    expect(resolveContactForLeadConversionMock).toHaveBeenCalledOnce()
    expect(createConsentRecordMock).not.toHaveBeenCalled()
    expect(createAuditLogMock.mock.calls.map((call) => call[0].data)).not.toContainEqual(
      expect.objectContaining({ action: "APPLICATION_SUBMITTED_BY_CLIENT" }),
    )
    expect(createAuditLogMock.mock.calls.map((call) => call[0].data)).not.toContainEqual(
      expect.objectContaining({ action: "CLIENT_UPDATED" }),
    )
  })

  it("does not create an application when the matched client's itemised expenses contradict its total", async () => {
    const inconsistentClient = {
      ...snapshotReadyClient,
      expenseBreakdown: {
        ...snapshotReadyClient.expenseBreakdown,
        housing: snapshotReadyClient.expenseBreakdown.housing + 1,
      },
    }
    findUniqueClientMock.mockResolvedValue(inconsistentClient)
    updateClientMock.mockResolvedValue(inconsistentClient)
    findFirstLoanProductMock.mockResolvedValue(personalProduct)

    const res = await POST(buildReq(withIdentity))
    const body = await res.json()

    expect(res.status).toBe(422)
    expect(body.error).toMatch(/inconsistent/i)
    expect(createLoanApplicationMock).not.toHaveBeenCalled()
    expect(createAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "APPLICATION_SUBMISSION_BLOCKED",
        newValue: expect.objectContaining({ reason: "expense_evidence_invalid" }),
      }),
    }))
  })
})

describe("POST /api/website/apply — confirmation email reroute (item 7)", () => {
  const realClient = snapshotReadyClient
  const withIdentity = {
    ...validBody,
    email: "real.client@example.com",
    idNumber: "8001015000086",
    productType: "PERSONAL",
    amount: 5000,
  }

  beforeEach(() => {
    findUniqueClientMock.mockResolvedValue(realClient)
    updateClientMock.mockResolvedValue(realClient)
    findFirstLoanProductMock.mockResolvedValue(personalProduct)
    findFirstLoanApplicationMock.mockResolvedValue(null)
    createLoanApplicationMock.mockResolvedValue({ id: "app_1" })
    txUpdateLeadMock.mockResolvedValue({ id: "lead_1" })
    createAuditLogMock.mockResolvedValue(undefined)
  })

  it("Contact provisioned successfully: routes the confirmation through sendMessage(), not the legacy sendEmail()", async () => {
    const res = await POST(buildReq(withIdentity))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.applicationId).toBe("app_1")
    expect(sendMessageMock).toHaveBeenCalledTimes(1)
    expect(sendEmailMock).not.toHaveBeenCalled()
    const sendArg = sendMessageMock.mock.calls[0][0] as Record<string, unknown>
    expect(sendArg.contactId).toBe("contact_1")
    expect(sendArg.channel).toBe("EMAIL")
    expect(sendArg.category).toBe("application_confirmation")
    expect(sendArg.applicationId).toBe("app_1")
    const vars = sendArg.vars as Record<string, string>
    expect(vars.subject).toContain("application received")
    expect(vars.bodyHtml).toContain("<")
    expect(vars.body).not.toContain("<") // plain-text derived from the HTML
  })

  it("does not dispatch a confirmation through a preserved blocked Contact", async () => {
    resolveContactForLeadConversionMock.mockResolvedValue({
      contact: {
        id: "contact_blocked",
        clientId: "client_real",
        leadId: "lead_1",
        status: "BLOCKED",
      },
      created: false,
      resolution: "REUSED_CLIENT_CONTACT",
      previous: {
        clientId: "client_real",
        leadId: "lead_earlier",
        status: "BLOCKED",
        primaryEmail: "real.client@example.com",
        primaryPhone: "+27821234567",
        primaryWaJid: null,
      },
      preExistingIdentities: [],
      createdIdentities: [],
    })

    const res = await POST(buildReq(withIdentity))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.applicationId).toBe("app_1")
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it("Contact provisioning failure rolls back the conversion and sends no success notification", async () => {
    resolveContactForLeadConversionMock.mockRejectedValue(new Error("P2002 unique constraint"))

    const res = await POST(buildReq(withIdentity))
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error).toMatch(/internal server error/i)
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it("maps a typed Contact conflict to an audited 409 without exposing the owner", async () => {
    resolveContactForLeadConversionMock.mockRejectedValue(
      new ContactPromotionConflictError("IDENTITY_OWNED_ELSEWHERE"),
    )

    const res = await POST(buildReq(withIdentity))
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toEqual({
      success: false,
      error: "Your application could not be submitted because the contact details need review. Please verify them or contact support.",
      reference: expect.stringMatching(/^WEB-/),
      applicationId: null,
      portalAccountStatus: "unavailable",
    })
    expect(JSON.stringify(body)).not.toContain("IDENTITY_OWNED_ELSEWHERE")
    expect(createAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "APPLICATION_SUBMISSION_BLOCKED",
        entity: "Lead",
        entityId: "lead_1",
        newValue: expect.objectContaining({
          reason: "contact_promotion_conflict",
          conflictReason: "IDENTITY_OWNED_ELSEWHERE",
          source: "website_apply",
        }),
      }),
    }))
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it("fails closed when the Contact-conflict audit cannot be persisted", async () => {
    resolveContactForLeadConversionMock.mockRejectedValue(
      new ContactPromotionConflictError("IDENTITY_OWNED_ELSEWHERE"),
    )
    createAuditLogMock.mockRejectedValueOnce(new Error("audit unavailable"))

    const res = await POST(buildReq(withIdentity))
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error).toMatch(/internal server error/i)
    expect(createAuditLogMock).toHaveBeenCalledOnce()
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it("no applicationId (e.g. blacklisted client): confirmation email is not sent at all", async () => {
    findUniqueClientMock.mockResolvedValue({ ...realClient, blacklisted: true })
    updateClientMock.mockResolvedValue({ ...realClient, blacklisted: true })

    const res = await POST(buildReq(withIdentity))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.applicationId).toBeNull()
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(sendEmailMock).not.toHaveBeenCalled()
  })
})

describe("POST /api/website/apply — identity-conflict portal notice", () => {
  const typed = {
    ...validBody,
    email: "dora@acme-lending.example",
    idNumber: "8001015000086",
    productType: "PERSONAL",
    amount: 5000,
  }
  const onFileById = {
    id: "client_x", email: "dora.onfile@example.test", idNumber: "8001015000086",
    firstName: "Dora", lastName: "Testcase", reference: "CLI-X", portalPassword: "hash", blacklisted: false,
  }
  const onFileByEmail = {
    id: "client_y", email: "dora@acme-lending.example", idNumber: "9999999999999",
    firstName: "Dora", lastName: "Testcase", reference: "CLI-Y", portalPassword: null, blacklisted: false,
  }

  beforeEach(() => {
    createAuditLogMock.mockResolvedValue(undefined)
  })

  it("(a) new email + known ID: emails the ON-FILE address, never the typed one, with the typed email masked", async () => {
    findUniqueClientMock.mockImplementation(({ where }: { where: { email?: string; idNumber?: string } }) =>
      Promise.resolve(where.idNumber ? onFileById : null),
    )

    const res = await POST(buildReq(typed))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.portalAccountStatus).toBe("unavailable") // on-screen reveals nothing
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    const arg = sendEmailMock.mock.calls[0][0] as Record<string, string>
    expect(arg.to).toBe("dora.onfile@example.test")            // on-file, NOT dora@acme-lending.example
    expect(arg.category).toBe("portal-identity-notice")
    expect(arg.html).toContain("d**a@acme-lending.example") // masked typed email
    expect(arg.html).not.toContain("dora@acme-lending.example") // never the raw typed email
    const audit = createAuditLogMock.mock.calls[0][0].data.newValue
    expect(audit.reason).toBe("identity_conflict")
    expect(audit.noticeSent).toBe(true)
    expect(audit.noticeRecipientClientId).toBe("client_x")
    // The claim persists on success — it MUST NOT be released, or the cooldown
    // wouldn't hold for the window.
    expect(createNotificationThrottleMock).toHaveBeenCalledTimes(1)
    expect(deleteNotificationThrottleMock).not.toHaveBeenCalled()
  })

  it("(b) known email + different ID: emails the email-owner with the typed ID masked (last 4)", async () => {
    findUniqueClientMock.mockImplementation(({ where }: { where: { email?: string; idNumber?: string } }) =>
      Promise.resolve(where.email ? onFileByEmail : null),
    )

    const res = await POST(buildReq(typed))
    await res.json()

    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    const arg = sendEmailMock.mock.calls[0][0] as Record<string, string>
    expect(arg.to).toBe("dora@acme-lending.example")
    expect(arg.html).toContain("*********0086")            // maskIdNumber("8001015000086") — last 4 chars are "0086"
    expect(arg.html).not.toContain("8001015000086")        // never the raw typed ID
    expect(createAuditLogMock.mock.calls[0][0].data.newValue.noticeRecipientClientId).toBe("client_y")
  })

  it("(c) full mismatch: notifies the email-owner (Y) only, not the ID-owner (X)", async () => {
    findUniqueClientMock.mockImplementation(({ where }: { where: { email?: string; idNumber?: string } }) =>
      Promise.resolve(where.email ? onFileByEmail : onFileById),
    )

    const res = await POST(buildReq(typed))
    await res.json()

    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    expect((sendEmailMock.mock.calls[0][0] as Record<string, string>).to).toBe("dora@acme-lending.example")
    expect(createAuditLogMock.mock.calls[0][0].data.newValue.noticeRecipientClientId).toBe("client_y")
  })

  it("cooldown: a concurrent claim (throttle P2002) suppresses a second send", async () => {
    findUniqueClientMock.mockImplementation(({ where }: { where: { email?: string; idNumber?: string } }) =>
      Promise.resolve(where.idNumber ? onFileById : null),
    )
    // Another request already claimed this recipient's 6h window, so the unique
    // constraint rejects our insert with P2002 → we must skip the send.
    createNotificationThrottleMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "5.x",
      }),
    )

    const res = await POST(buildReq(typed))
    await res.json()

    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(deleteNotificationThrottleMock).not.toHaveBeenCalled() // we didn't win the claim, so nothing to release
    expect(createAuditLogMock.mock.calls[0][0].data.newValue.noticeSent).toBe(false)
  })

  it("best-effort: a send failure returns 200, records noticeSent=false, and RELEASES the throttle claim", async () => {
    findUniqueClientMock.mockImplementation(({ where }: { where: { email?: string; idNumber?: string } }) =>
      Promise.resolve(where.idNumber ? onFileById : null),
    )
    sendEmailMock.mockResolvedValue({ ok: false, error: "smtp down" })

    const res = await POST(buildReq(typed))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    const audit = createAuditLogMock.mock.calls[0][0].data.newValue
    expect(audit.reason).toBe("identity_conflict")
    expect(audit.noticeSent).toBe(false)
    // The claim is rolled back so a transient outage doesn't block a retry for the window.
    expect(deleteNotificationThrottleMock).toHaveBeenCalledTimes(1)
    const delWhere = deleteNotificationThrottleMock.mock.calls[0][0].where.tenantId_channelKey_windowStart
    expect(delWhere.tenantId).toBe("tenant_acme")
    expect(delWhere.channelKey).toBe("portal-identity-notice:dora.onfile@example.test")
    expect(delWhere.windowStart).toBeInstanceOf(Date)
  })

  it("best-effort: an unexpected throttle error (non-P2002) does not 500 the submission", async () => {
    findUniqueClientMock.mockImplementation(({ where }: { where: { email?: string; idNumber?: string } }) =>
      Promise.resolve(where.idNumber ? onFileById : null),
    )
    createNotificationThrottleMock.mockRejectedValue(new Error("db blip"))

    const res = await POST(buildReq(typed))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(createAuditLogMock.mock.calls[0][0].data.newValue.reason).toBe("identity_conflict")
  })

  it("injection regression: an HTML payload in the applicant's email is escaped in the notice HTML", async () => {
    findUniqueClientMock.mockImplementation(({ where }: { where: { email?: string; idNumber?: string } }) =>
      Promise.resolve(where.idNumber ? onFileById : null),
    )

    const res = await POST(buildReq({ ...typed, email: "<>@evil.com" }))
    await res.json()

    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    const arg = sendEmailMock.mock.calls[0][0] as Record<string, string>
    expect(arg.to).toBe("dora.onfile@example.test")   // on-file address only, never the typed one
    expect(arg.html).toContain("&lt;*@evil.com")     // escaped masked value
    expect(arg.html).not.toContain("<*@evil.com")    // no raw angle bracket from the payload survives
  })
})

describe("returning-applicant duplicate notice", () => {
  // The notice is detect-only and best-effort. What must hold at this seam is
  // that it is CALLED with the new lead, and that nothing about it reaches the
  // applicant — the route deliberately hides whether we recognise someone.

  it("notifies with the newly created lead and the tenant", async () => {
    getTenantFromRequestMock.mockResolvedValue({ id: "tenant_1", name: "Acme Lending" })
    createLeadMock.mockResolvedValue({ id: "lead_new", tenantId: "tenant_1" })

    afterCallbacks.length = 0
    await POST(buildReq(validBody))
    // Deferred via after(); drain it as the runtime would once the response
    // has been sent.
    for (const cb of afterCallbacks) await cb()

    expect(notifyPriorLeadDuplicatesMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "lead_new", firstName: "Jane", lastName: "Doe", phone: "+27821234567" }),
      "tenant_1",
    )
  })

  it("defers the notice until AFTER the response — no timing signal", async () => {
    // The enumeration hole this closes: on a match the notice does a throttle
    // write, a bell insert and a real SMTP send. Awaited, that made a
    // recognised submission measurably slower than an unrecognised one — the
    // response body is identical but the clock is not, and three of the five
    // wired routes send no email at all when there is no match.
    //
    // Asserting the notice has NOT run by the time the response exists is what
    // makes this falsifiable: revert to `await` and it fails.
    getTenantFromRequestMock.mockResolvedValue({ id: "tenant_1", name: "Acme Lending" })
    createLeadMock.mockResolvedValue({ id: "lead_new", tenantId: "tenant_1" })
    afterCallbacks.length = 0

    const response = await POST(buildReq(validBody))

    expect(afterCallbacks).toHaveLength(1)
    expect(notifyPriorLeadDuplicatesMock).not.toHaveBeenCalled()

    // Draining it afterwards is what the runtime does once the response is sent.
    await afterCallbacks[0]()
    expect(notifyPriorLeadDuplicatesMock).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(200)
  })
})

describe("POST /api/website/apply — loan term is required, never defaulted", () => {
  const applying = {
    ...validBody,
    email: "real.client@example.com",
    idNumber: "8001015000086",
    productType: "PERSONAL",
    amount: 5000,
  }
  const { termDays: _omitted, ...applyingNoTerm } = applying
  const fixedTermProduct = { ...personalProduct, minTermDays: 30, maxTermDays: 30 }

  function expectNothingWritten() {
    expect(createLeadMock).not.toHaveBeenCalled()
    expect(createCrmActivityMock).not.toHaveBeenCalled()
    expect(createClientMock).not.toHaveBeenCalled()
    expect(createLoanApplicationMock).not.toHaveBeenCalled()
  }

  function readyToApply(product: typeof personalProduct) {
    findUniqueClientMock.mockResolvedValue(snapshotReadyClient)
    updateClientMock.mockResolvedValue(snapshotReadyClient)
    findFirstLoanProductMock.mockResolvedValue(product)
    findFirstLoanApplicationMock.mockResolvedValue(null)
    createLoanApplicationMock.mockResolvedValue({ id: "app_1", reference: "APP-TEST-0001" })
  }

  it("refuses a missing term for a variable-term product and writes nothing", async () => {
    findFirstLoanProductMock.mockResolvedValue(personalProduct)

    const res = await POST(buildReq(applyingNoTerm))

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toMatch(/loan term/i)
    expectNothingWritten()
  })

  it.each([
    ["non-numeric text", "abc"],
    ["zero", 0],
    ["a negative number", -5],
    ["a fraction", 30.5],
    ["a fractional string", "30.5"],
    ["an empty string", ""],
    ["null", null],
    ["a boolean", true],
  ])("refuses %s as the term and writes nothing", async (_label, termDays) => {
    findFirstLoanProductMock.mockResolvedValue(personalProduct)

    const res = await POST(buildReq({ ...applying, termDays }))

    expect(res.status).toBe(400)
    expectNothingWritten()
  })

  it("accepts a fixed-term product without a term and applies the product's term", async () => {
    readyToApply(fixedTermProduct)

    const res = await POST(buildReq(applyingNoTerm))

    expect(res.status).toBe(200)
    expect(createLoanApplicationMock).toHaveBeenCalledTimes(1)
    expect(createLoanApplicationMock.mock.calls[0][0].data.appliedTermDays).toBe(30)
  })

  it("succeeds when the form sent the catalogue's fixed 30 days but the route's product is variable-term", async () => {
    readyToApply(personalProduct) // 30-90 days: the form's catalogue said fixed-30

    const res = await POST(buildReq({ ...applying, termDays: "30" }))

    expect(res.status).toBe(200)
    expect(createLoanApplicationMock.mock.calls[0][0].data.appliedTermDays).toBe(30)
  })

  it("records only a valid submitted term in the lead notes and referral metadata", async () => {
    findFirstLoanProductMock.mockResolvedValue(null)
    await POST(buildReq({ ...validBody, termDays: "abc", referralCode: "REF1" }))
    const notes = createLeadMock.mock.calls[0][0].data.notes as string
    expect(notes).not.toMatch(/Term:/)
    expect(notes).not.toMatch(/NaN/)
    expect(recordReferralEventMock.mock.calls[0][1].metadata.termDays).toBeNull()
  })

  it("accepts a fixed-term product given an invalid term, still using the product's term", async () => {
    readyToApply(fixedTermProduct)

    const res = await POST(buildReq({ ...applying, termDays: "abc" }))

    expect(res.status).toBe(200)
    expect(createLoanApplicationMock.mock.calls[0][0].data.appliedTermDays).toBe(30)
  })

  it("does not default the term if the product became variable-term after the pre-check", async () => {
    readyToApply(fixedTermProduct)
    findFirstLoanProductMock.mockReset()
    findFirstLoanProductMock.mockResolvedValueOnce(fixedTermProduct).mockResolvedValue(personalProduct)

    const res = await POST(buildReq(applyingNoTerm))

    expect(res.status).toBe(422)
    expect(createLoanApplicationMock).not.toHaveBeenCalled()
  })

  it("stores the submitted term for a variable-term product", async () => {
    readyToApply(personalProduct)

    const res = await POST(buildReq({ ...applying, termDays: "60" }))

    expect(res.status).toBe(200)
    expect(createLoanApplicationMock.mock.calls[0][0].data.appliedTermDays).toBe(60)
  })

  it("still clamps an out-of-range term into the product's range", async () => {
    readyToApply(personalProduct)

    const res = await POST(buildReq({ ...applying, termDays: 5000 }))

    expect(res.status).toBe(200)
    expect(createLoanApplicationMock.mock.calls[0][0].data.appliedTermDays).toBe(personalProduct.maxTermDays)
  })

  it("still captures a lead-only enquiry (no ID number) without a term", async () => {
    findFirstLoanProductMock.mockResolvedValue(personalProduct)

    const res = await POST(buildReq({ ...applyingNoTerm, idNumber: undefined }))

    expect(res.status).toBe(200)
    expect(createLeadMock).toHaveBeenCalledTimes(1)
    expect(createLoanApplicationMock).not.toHaveBeenCalled()
  })

  it("still captures a lead when the amount is outside the product range, without a term", async () => {
    findFirstLoanProductMock.mockResolvedValue(personalProduct)

    const res = await POST(buildReq({ ...applyingNoTerm, amount: 1 }))

    expect(res.status).toBe(200)
    expect(createLeadMock).toHaveBeenCalledTimes(1)
    expect(createLoanApplicationMock).not.toHaveBeenCalled()
  })
})
