import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"

// Hoisted mocks — the route pulls session, DB, tenant wrapper, rate-limit,
// reference generator, audit and notifications from these modules.
const {
  auth,
  checkRateLimit,
  findFirstClient,
  findFirstProduct,
  findFirstInsuranceProduct,
  findFirstLoan,
  countLoan,
  findFirstApplication,
  createApplication,
  logAudit,
  triggerNotification,
  resolveReferralCodeById,
  recordReferralEvent,
  queryRaw,
  transaction,
  auditLogCreate,
  findFirstDocument,
  loadOwn,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  checkRateLimit: vi.fn(),
  findFirstClient: vi.fn(),
  findFirstProduct: vi.fn(),
  findFirstInsuranceProduct: vi.fn(),
  findFirstLoan: vi.fn(),
  countLoan: vi.fn(),
  findFirstApplication: vi.fn(),
  createApplication: vi.fn(),
  logAudit: vi.fn(),
  triggerNotification: vi.fn(),
  resolveReferralCodeById: vi.fn(),
  recordReferralEvent: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn(),
  auditLogCreate: vi.fn(),
  findFirstDocument: vi.fn(),
  loadOwn: vi.fn(),
}))

const tx = {
  $queryRaw: (query: unknown) => queryRaw(query),
  client: { findFirst: findFirstClient },
  loanProduct: { findFirst: findFirstProduct },
  insuranceProduct: { findFirst: findFirstInsuranceProduct },
  loan: { findFirst: findFirstLoan },
  loanApplication: { findFirst: findFirstApplication, create: createApplication },
  auditLog: { create: auditLogCreate },
  clientDocument: { findFirst: findFirstDocument },
}

// No loans with this lender here; the obligations themselves are proven in
// lib/affordability/own-lender-debt.integration.test.ts.
vi.mock("@/lib/affordability/own-lender-debt-load", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/affordability/own-lender-debt-load")>()),
  loadOwnLenderDebts: (...a: unknown[]) => loadOwn(...a),
  ownAwareSubmissionSnapshot: async (_db: unknown, _tenantId: string, _clientId: string, args: Parameters<typeof import("@/lib/affordability/snapshot").createSubmissionAffordabilitySnapshot>[0]) =>
    (await import("@/lib/affordability/snapshot")).createSubmissionAffordabilitySnapshot(args),
}))
vi.mock("@/lib/auth", () => ({ auth }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (cb: (client: typeof tx) => Promise<unknown>) => transaction(cb),
    client: { findFirst: findFirstClient },
    loanProduct: { findFirst: findFirstProduct },
    insuranceProduct: { findFirst: findFirstInsuranceProduct },
    loan: { findFirst: findFirstLoan, count: countLoan },
    loanApplication: { findFirst: findFirstApplication, create: createApplication },
    clientDocument: { findFirst: findFirstDocument },
  },
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }),
}))
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (key: string, opts: unknown) => checkRateLimit(key, opts),
  callerIp: () => "127.0.0.1",
}))
vi.mock("@/lib/utils", () => ({ generateReference: () => "APP-TEST-0001" }))
vi.mock("@/lib/notifications", () => ({
  triggerNotification: (...a: unknown[]) => triggerNotification(...a),
}))
const { screenOnSubmitMock } = vi.hoisted(() => ({ screenOnSubmitMock: vi.fn() }))
vi.mock("@/lib/screening/on-submit", () => ({ screenOnSubmit: (a: unknown) => screenOnSubmitMock(a) }))
// The helper's transaction and fallback are proven in
// lib/learning-loop/submission-refusal.test.ts; here it forwards the audit row
// to the logAudit mock and records which refusal each site logged.
const { recordRefusal } = vi.hoisted(() => ({ recordRefusal: vi.fn() }))
vi.mock("@/lib/learning-loop/submission-refusal", () => ({
  recordSubmissionRefusal: async (audit: unknown, refusal: unknown, options?: unknown) => {
    recordRefusal(refusal, options)
    await logAudit(audit)
  },
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (...a: unknown[]) => logAudit(...a),
  AuditAction: {
    APPLICATION_SUBMITTED_BY_CLIENT: "APPLICATION_SUBMITTED_BY_CLIENT",
    APPLICATION_SUBMISSION_BLOCKED: "APPLICATION_SUBMISSION_BLOCKED",
    CREDIT_LIFE_ELECTION_RECORDED: "CREDIT_LIFE_ELECTION_RECORDED",
  },
}))
vi.mock("@/lib/referral-agents/referrals", () => ({
  resolveReferralCodeById: (...a: unknown[]) => resolveReferralCodeById(...a),
  recordReferralEvent: (...a: unknown[]) => recordReferralEvent(...a),
}))

import { POST } from "./route"

// Two distinct rate-limit keys: an up-front request throttle and the late
// create cap. Tests distinguish them so we can assert the property (only
// genuine creates consume the CREATE budget) independently of the coarse
// request throttle.
const REQ_KEY = "portal:apply:req:c1"
const CREATE_KEY = "portal:apply:c1"
const reqThrottleCalls = () => checkRateLimit.mock.calls.filter(([k]) => k === REQ_KEY).length
const createCapCalls = () => checkRateLimit.mock.calls.filter(([k]) => k === CREATE_KEY).length

const CLIENT = {
  id: "c1",
  tenantId: "t1",
  blacklisted: false,
  idNumber: "9001011234083",
  monthlyIncome: 2_000_000,
  monthlyExpenses: 500_000,
  grossMonthlyIncome: 2_200_000,
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
const PRODUCT = {
  id: "prod1",
  minAmount: 50_000,
  maxAmount: 200_000,
  minTermDays: 30,
  maxTermDays: 30,
  name: "30-Day Micro Loan",
  code: "MICRO30",
  productType: "MICRO",
  interestRatePm: 0.05,
  interestModel: "DAILY_ACCRUAL",
  initiationFeePct: 0.15,
  initiationFeeMax: 105_000,
  monthlyServiceFee: 6_900,
}
const CREDIT_LIFE_PRODUCT = {
  id: "credit-life-1",
  name: "Acme Credit Life",
  insurerId: "insurer-1",
  insurer: {
    id: "insurer-1",
    tenantId: "t1",
    active: true,
    name: "Test Life",
  },
}
const validBody = {
  productCode: "MICRO30",
  amount: 1500,
  purpose: "Groceries and rent",
  affordabilityDeclared: true,
  pasqDeliveryUnderstood: true,
  creditLifeElection: "DECLINED",
  creditLifeDisclosureAcknowledged: true,
  creditLifeProductId: CREDIT_LIFE_PRODUCT.id,
  creditLifeProductName: CREDIT_LIFE_PRODUCT.name,
  creditLifeInsurerId: CREDIT_LIFE_PRODUCT.insurerId,
  creditLifeInsurerName: CREDIT_LIFE_PRODUCT.insurer.name,
  creditLifeMonthlyPremiumCents: 675,
  creditLifeDisclosureVersion: "credit-life-election-v1",
}

function buildReq(body: object): NextRequest {
  return new NextRequest("https://portal.acme-lending.example/api/portal/applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const ALLOW = { allowed: true, remaining: 5, retryAfterSeconds: 0 }
const ORIGINAL_CREDIT_LIFE_AUTO_BUNDLE_ENABLED =
  process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED

beforeEach(() => {
  delete process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED
  vi.clearAllMocks()
  transaction.mockImplementation((cb: (client: typeof tx) => Promise<unknown>) => cb(tx))
  queryRaw.mockResolvedValue([{ id: "locked" }])
  auth.mockResolvedValue({ user: { id: "c1", role: "CLIENT", email: "client@example.com" } })
  checkRateLimit.mockImplementation(() => ALLOW) // both keys allowed by default
  findFirstClient.mockResolvedValue(CLIENT)
  findFirstProduct.mockResolvedValue(PRODUCT)
  findFirstInsuranceProduct.mockResolvedValue(CREDIT_LIFE_PRODUCT)
  loadOwn.mockResolvedValue({ lenderNames: [], loans: [] })
  findFirstLoan.mockResolvedValue(null) // no defaulted loan
  countLoan.mockResolvedValue(0) // first-time borrower by default
  findFirstApplication.mockResolvedValue(null) // no open duplicate
  createApplication.mockResolvedValue({ id: "app1", reference: "APP-TEST-0001", status: "SUBMITTED" })
  logAudit.mockResolvedValue(undefined)
  auditLogCreate.mockResolvedValue({ id: "audit-1" })
  triggerNotification.mockResolvedValue(undefined)
  resolveReferralCodeById.mockResolvedValue(null)
  recordReferralEvent.mockResolvedValue(undefined)
})

afterEach(() => {
  if (ORIGINAL_CREDIT_LIFE_AUTO_BUNDLE_ENABLED === undefined) {
    delete process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED
  } else {
    process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED =
      ORIGINAL_CREDIT_LIFE_AUTO_BUNDLE_ENABLED
  }
})

describe("POST /api/portal/applications", () => {
  const ARREARS_OWN = {
    lenderNames: [],
    loans: [{ id: "loan-1", reference: "LN-SYN-1", daysInArrears: 60, arrearsAmount: 205_834, instalmentCents: 100_000 }],
  }

  it("refuses a client who is overdue on a loan with this lender, and writes nothing", async () => {
    loadOwn.mockResolvedValue(ARREARS_OWN)
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe("OWN_LENDER_ARREARS")
    expect(createApplication).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t1",
      entity: "LoanApplication",
      action: "APPLICATION_SUBMISSION_BLOCKED",
      newValue: expect.objectContaining({ reason: "own_lender_arrears", clientId: "c1", days: 60 }),
    }))
    expect(recordRefusal).toHaveBeenCalledWith(
      { tenantId: "t1", channel: "PORTAL", reason: "own_lender_arrears", subject: { clientId: "c1" } }, undefined,
    )
  })

  it("refuses, under the lock, a loan that fell overdue after the early check, and writes nothing", async () => {
    loadOwn.mockResolvedValueOnce({ lenderNames: [], loans: [] }).mockResolvedValue(ARREARS_OWN)
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe("OWN_LENDER_ARREARS")
    expect(transaction).toHaveBeenCalled()
    expect(createApplication).not.toHaveBeenCalled()
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t1",
      newValue: expect.objectContaining({ reason: "own_lender_arrears", clientId: "c1" }),
    }))
    expect(recordRefusal).toHaveBeenCalledOnce()
    expect(recordRefusal).toHaveBeenCalledWith(
      { tenantId: "t1", channel: "PORTAL", reason: "own_lender_arrears", subject: { clientId: "c1" } }, undefined,
    )
  })

  it("does not block when the loader cannot read an approved application (arrears unknown)", async () => {
    const { InvalidAffordabilityDebtError } = await import("@/lib/affordability/snapshot")
    loadOwn.mockRejectedValue(new InvalidAffordabilityDebtError("approvedAmount"))
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(201)
    expect(logAudit).not.toHaveBeenCalledWith(expect.objectContaining({ newValue: expect.objectContaining({ reason: "own_lender_arrears" }) }))
  })

  it("401s when there is no session", async () => {
    auth.mockResolvedValue(null)
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(401)
    expect(checkRateLimit).not.toHaveBeenCalled()
  })

  it("401s when the caller is authenticated but not a CLIENT", async () => {
    auth.mockResolvedValue({ user: { id: "c1", role: "LOAN_ADMIN", email: "staff@example.com" } })
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(401)
    expect(checkRateLimit).not.toHaveBeenCalled()
  })

  it("throttles floods up-front — request throttle 429 short-circuits before any DB work", async () => {
    checkRateLimit.mockImplementation((key: string) =>
      key === REQ_KEY ? { allowed: false, remaining: 0, retryAfterSeconds: 60 } : ALLOW,
    )
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(429)
    expect(findFirstClient).not.toHaveBeenCalled()
    expect(createApplication).not.toHaveBeenCalled()
  })

  it("a malformed request 400s WITHOUT consuming the CREATE budget", async () => {
    const res = await POST(buildReq({ ...validBody, productCode: "" }))
    expect(res.status).toBe(400)
    expect(createCapCalls()).toBe(0)
    expect(reqThrottleCalls()).toBe(1) // request throttle still applies
    expect(createApplication).not.toHaveBeenCalled()
  })

  it("rejects an amount that rounds to zero cents with 400 and creates nothing", async () => {
    findFirstProduct.mockResolvedValue({ ...PRODUCT, minAmount: 0 }) // legacy row: no floor
    const res = await POST(buildReq({ ...validBody, amount: 0.004 }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/positive number/i)
    expect(createCapCalls()).toBe(0)
    expect(createApplication).not.toHaveBeenCalled()
  })

  it("requires an explicit credit-life election and disclosure acknowledgement", async () => {
    const res = await POST(buildReq({
      ...validBody,
      creditLifeElection: undefined,
      creditLifeDisclosureAcknowledged: false,
    }))

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/accept or decline/i)
    expect(createCapCalls()).toBe(0)
    expect(findFirstClient).not.toHaveBeenCalled()
    expect(createApplication).not.toHaveBeenCalled()
  })

  it("does not record ACCEPTED while auto-bundling is contained", async () => {
    const res = await POST(buildReq({
      ...validBody,
      creditLifeElection: "ACCEPTED",
    }))

    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/not available/i)
    expect(findFirstClient).not.toHaveBeenCalled()
    expect(createApplication).not.toHaveBeenCalled()
  })

  it("does not record ACCEPTED at the no-cover amount threshold", async () => {
    process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED = "true"
    const res = await POST(buildReq({
      ...validBody,
      amount: 1000,
      creditLifeElection: "ACCEPTED",
      creditLifeMonthlyPremiumCents: 450,
    }))

    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/not available/i)
    expect(findFirstClient).not.toHaveBeenCalled()
    expect(createApplication).not.toHaveBeenCalled()
  })

  it("rejects a stale or client-tampered exact premium under the submission lock", async () => {
    const res = await POST(buildReq({
      ...validBody,
      creditLifeMonthlyPremiumCents: validBody.creditLifeMonthlyPremiumCents - 1,
    }))

    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/offer changed/i)
    expect(queryRaw).toHaveBeenCalledTimes(4)
    expect(createApplication).not.toHaveBeenCalled()
    expect(auditLogCreate).not.toHaveBeenCalled()
  })

  it("monthlyIncome <= 0 is rejected 422 before the CREATE cap is touched", async () => {
    findFirstClient.mockResolvedValue({ ...CLIENT, monthlyIncome: 0 })
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/monthly income/i)
    expect(createCapCalls()).toBe(0)
    expect(createApplication).not.toHaveBeenCalled()
  })

  it("rejects below-MLE profile expenses without justification before consuming the CREATE cap", async () => {
    findFirstClient.mockResolvedValue({
      ...CLIENT,
      monthlyExpenses: 0,
      expenseBreakdown: {
        ...CLIENT.expenseBreakdown,
        housing: 0,
        transport: 0,
        food: 0,
        insurance: 0,
        clothing: 0,
        medical: 0,
        other: 0,
        belowMleJustification: null,
      },
    })

    const res = await POST(buildReq(validBody))

    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/Regulation 23A minimum/i)
    expect(createCapCalls()).toBe(0)
    expect(createApplication).not.toHaveBeenCalled()
  })

  it("rejects an itemised expense record that contradicts the client expense total", async () => {
    findFirstClient.mockResolvedValue({
      ...CLIENT,
      expenseBreakdown: {
        ...CLIENT.expenseBreakdown,
        housing: CLIENT.expenseBreakdown.housing + 1,
      },
    })

    const res = await POST(buildReq(validBody))

    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/inconsistent/i)
    expect(createCapCalls()).toBe(0)
    expect(createApplication).not.toHaveBeenCalled()
  })

  it("blacklisted client → 422 with an audit row, no CREATE budget consumed", async () => {
    findFirstClient.mockResolvedValue({ ...CLIENT, blacklisted: true })
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(422)
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "APPLICATION_SUBMISSION_BLOCKED" }),
    )
    expect(recordRefusal).toHaveBeenCalledWith(
      { tenantId: "t1", channel: "PORTAL", reason: "client_blacklisted", subject: { clientId: "c1" } }, undefined,
    )
    expect(createCapCalls()).toBe(0)
    expect(createApplication).not.toHaveBeenCalled()
  })

  it("a recorded death refuses the submission and logs an automated refusal", async () => {
    findFirstClient.mockResolvedValue({ ...CLIENT, deceasedAt: new Date("2026-01-01T00:00:00.000Z") })
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(422)
    expect(recordRefusal).toHaveBeenCalledWith(
      { tenantId: "t1", channel: "PORTAL", reason: "client_deceased", subject: { clientId: "c1" } }, undefined,
    )
    expect(createApplication).not.toHaveBeenCalled()
  })

  it("a duplicate in-flight application 409s WITHOUT consuming the CREATE budget", async () => {
    findFirstApplication.mockResolvedValue({ id: "existing", reference: "APP-OLD", status: "SUBMITTED" })
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(409)
    expect(createCapCalls()).toBe(0)
    expect(createApplication).not.toHaveBeenCalled()
  })

  it("maps the database winner of a concurrent submission race to 409", async () => {
    findFirstApplication
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "winner", reference: "APP-WINNER", status: "SUBMITTED" })
    createApplication.mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "5.x" },
    ))

    const res = await POST(buildReq(validBody))
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.existingApplicationId).toBe("winner")
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "APPLICATION_SUBMISSION_BLOCKED",
      entityId: "winner",
      newValue: expect.objectContaining({
        reason: "open_application_exists",
        source: "portal_apply_concurrent",
      }),
    }))
    expect(recordRefusal).toHaveBeenCalledWith({
      tenantId: "t1", channel: "PORTAL", reason: "open_application_exists", subject: { clientId: "c1" }, existingApplicationId: "winner",
    }, undefined)
    expect(triggerNotification).not.toHaveBeenCalled()
    expect(screenOnSubmitMock).not.toHaveBeenCalled()
  })

  it("the CREATE cap is enforced on a genuine create — 429 blocks the create", async () => {
    checkRateLimit.mockImplementation((key: string) =>
      key === CREATE_KEY ? { allowed: false, remaining: 0, retryAfterSeconds: 1800 } : ALLOW,
    )
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(429)
    expect(createCapCalls()).toBe(1)
    expect(createApplication).not.toHaveBeenCalled()
  })

  it("accepts the REAL no-offer client payload: election is an empty string", async () => {
    // The apply screen's election state initialises to "" and is posted
    // verbatim when no offer block rendered. `?? "DECLINED"` does not catch
    // "", so a no-offer portal submission must still be accepted server-side
    // even if the client-side gate lets the blank through.
    findFirstInsuranceProduct.mockResolvedValue(null) // no offer configured
    // EXACTLY what PortalApplyProductClient posts when no offer rendered:
    // election state "" posted verbatim, acknowledgement false,
    // and every offer-identity field absent (undefined is dropped by JSON).
    const { creditLifeProductId: _p, creditLifeProductName: _n, creditLifeInsurerId: _i,
      creditLifeInsurerName: _in, creditLifeMonthlyPremiumCents: _m, ...noOfferBody } = validBody as Record<string, unknown>
    const res = await POST(buildReq({
      ...noOfferBody,
      creditLifeElection: "",
      creditLifeDisclosureAcknowledged: false,
    }))

    expect(res.status).toBe(201)
    expect(createApplication).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ creditLifeElection: "DECLINED" }),
    }))
    // A6: PEP / sanctions screening starts once the portal submission committed; no staff actor.
    expect(screenOnSubmitMock).toHaveBeenCalledWith(expect.objectContaining({ actor: null }))
  })

  it("409s when cover becomes available between the client's screen and the transaction", async () => {
    // Pre-check sees no offer (client legitimately submits with none), but by
    // the time the transaction re-reads under lock a real offer exists. The
    // applicant must see the new offer before a no-offer disclosure is
    // recorded — this 409 is the ONLY submission-time gate for that race.
    findFirstInsuranceProduct
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(CREDIT_LIFE_PRODUCT)
    const { creditLifeProductId: _p, creditLifeProductName: _n, creditLifeInsurerId: _i,
      creditLifeInsurerName: _in, creditLifeMonthlyPremiumCents: _m, ...noOfferBody } = validBody as Record<string, unknown>
    const res = await POST(buildReq({
      ...noOfferBody,
      creditLifeElection: "",
      creditLifeDisclosureAcknowledged: false,
    }))

    expect(res.status).toBe(409)
    const body = await res.json() as { error?: string }
    expect(body.error).toMatch(/became available/i)
    expect(createApplication).not.toHaveBeenCalled()
  })

  it("422s a stated election that discloses no product while an offer IS configured", async () => {
    // Defence-in-depth over the availability 409: with an offer configured,
    // a payload that elects but names no product is a broken disclosure and
    // must die before any lock or lookup work happens.
    const res = await POST(buildReq({
      ...validBody,
      creditLifeProductId: "",
    }))

    expect(res.status).toBe(422)
    const body = await res.json() as { error?: string }
    expect(body.error).toMatch(/offer is incomplete/i)
    expect(createApplication).not.toHaveBeenCalled()
  })

  it("still refuses a STATED garbage election even with no offer configured", async () => {
    findFirstInsuranceProduct.mockResolvedValue(null) // no offer configured
    const res = await POST(buildReq({
      ...validBody,
      creditLifeElection: "MAYBE",
      creditLifeDisclosureAcknowledged: false,
    }))

    expect(res.status).toBe(400)
    expect(createApplication).not.toHaveBeenCalled()
  })

  it("resolves the product by tenant-scoped unique CODE, never by type", async () => {
    // §3 A: two products can both be productType MICRO; type-based
    // resolution with a creation-order tiebreak applied against whichever
    // row was older. The exact code the portal page displayed must be the
    // binding filter.
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(201)
    // The FIRST call is the resolution the response is built from — the
    // in-tx recheck also filters by code, so a matcher over "any call"
    // would stay green if the primary resolution dropped the code filter.
    const productWhere = (findFirstProduct.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(productWhere).toEqual(expect.objectContaining({ code: "MICRO30", active: true }))
    // Never resolved BY type: the only type filter is the asset-finance exclusion.
    expect(productWhere.productType).toEqual({ not: "ASSET_FINANCE" })
  })

  it("never resolves an asset-finance product: both the lookup and the in-transaction re-read exclude it (Fair Score E4)", async () => {
    await POST(buildReq(validBody))
    for (const [args] of findFirstProduct.mock.calls as unknown as Array<[{ where: Record<string, unknown> }]>) {
      expect(args.where.productType).toEqual({ not: "ASSET_FINANCE" })
    }
    expect(findFirstProduct.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it("happy path: 201 creates the application and records exactly ONE CREATE-cap hit", async () => {
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(201)
    expect(reqThrottleCalls()).toBe(1)
    expect(createCapCalls()).toBe(1)
    expect(createApplication).toHaveBeenCalledOnce()
    expect(queryRaw).toHaveBeenCalledTimes(4)
    expect(queryRaw.mock.invocationCallOrder[2]).toBeLessThan(
      findFirstClient.mock.invocationCallOrder[1],
    )
    expect(findFirstClient.mock.invocationCallOrder[1]).toBeLessThan(
      createApplication.mock.invocationCallOrder[0],
    )
    expect(createApplication.mock.calls[0][0].data).toEqual(expect.objectContaining({
      creditLifeElection: "DECLINED",
      creditLifeProductId: CREDIT_LIFE_PRODUCT.id,
      creditLifeProductName: CREDIT_LIFE_PRODUCT.name,
      creditLifeInsurerId: CREDIT_LIFE_PRODUCT.insurerId,
      creditLifeInsurerName: CREDIT_LIFE_PRODUCT.insurer.name,
      creditLifeMonthlyPremiumCents: 675,
      creditLifeDisclosureVersion: "credit-life-election-v1",
      creditLifeDisclosureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      creditLifeDisclosureAcknowledgedAt: expect.any(Date),
      creditLifeDisclosureAcknowledgedBy: "c1",
    }))
    expect(createApplication.mock.calls[0][0].data).not.toHaveProperty("pasqAcknowledgedAt")
    expect(createApplication.mock.calls[0][0].data).not.toHaveProperty("pasqAcknowledgedBy")
    expect(findFirstInsuranceProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "t1",
          type: "CREDIT_LIFE",
          active: true,
          insurer: {
            is: {
              tenantId: "t1",
              active: true,
            },
          },
        }),
      }),
    )
    const insurerOfferLockSql = queryRaw.mock.calls
      .map(([query]) => {
        const sql = query as { strings?: readonly string[] }
        return sql.strings?.join(" ") ?? String(query)
      })
      .find((sql) => sql.includes('JOIN "Insurer" AS insurer'))
    expect(insurerOfferLockSql).toContain(`insurer."active" = TRUE`)
    expect(insurerOfferLockSql).toContain(`FOR SHARE OF product, insurer`)
    expect(createApplication.mock.calls[0][0].data.affordabilityResult).toEqual(
      expect.objectContaining({
        schemaVersion: 3,
        submission: expect.objectContaining({
          policyVersion: "submission-ndi-v3",
          capturedById: "c1",
          expenses: expect.objectContaining({
            source: "CLIENT_BREAKDOWN",
            sourceId: "expense-1",
            grossMonthlyIncomeCents: 2_200_000,
            breakdownTotalCents: 500_000,
          }),
          calculator: expect.objectContaining({
            version: "loan-calculator-v3",
            pricingFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
            contractFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        }),
      }),
    )
    expect(createApplication.mock.invocationCallOrder[0]).toBeLessThan(
      auditLogCreate.mock.invocationCallOrder[0],
    )
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "APPLICATION_SUBMITTED_BY_CLIENT",
        entityId: "app1",
        userEmail: "client@example.com",
        newValue: expect.objectContaining({
          pasqDeliveryNoticeAcceptedByClient: true,
        }),
      }),
    })
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CREDIT_LIFE_ELECTION_RECORDED",
        entityId: "app1",
        newValue: expect.objectContaining({
          election: "DECLINED",
          productId: CREDIT_LIFE_PRODUCT.id,
          insurerId: CREDIT_LIFE_PRODUCT.insurerId,
          monthlyPremiumCents: 675,
          disclosureVersion: "credit-life-election-v1",
          disclosureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          acknowledgedBy: "c1",
        }),
      }),
    })
  })

  it("rebuilds the snapshot from client and pricing evidence re-read under lock", async () => {
    const lockedClient = { ...CLIENT, monthlyIncome: 2_100_000 }
    const lockedProduct = { ...PRODUCT, interestRatePm: 0.07 }
    findFirstClient
      .mockResolvedValueOnce(CLIENT)
      .mockResolvedValueOnce(lockedClient)
    findFirstProduct
      .mockResolvedValueOnce(PRODUCT)
      .mockResolvedValueOnce(lockedProduct)

    const res = await POST(buildReq(validBody))

    expect(res.status).toBe(201)
    const submission = createApplication.mock.calls[0][0].data.affordabilityResult.submission
    expect(submission.inputs.monthlyIncomeCents).toBe(2_100_000)
    expect(submission.inputs.interestRatePm).toBe(0.07)
    expect(queryRaw.mock.invocationCallOrder[2]).toBeLessThan(
      findFirstClient.mock.invocationCallOrder[1],
    )
    expect(findFirstProduct.mock.invocationCallOrder[1]).toBeLessThan(
      createApplication.mock.invocationCallOrder[0],
    )
  })

  it("fails closed when the mandatory submission audit cannot be written", async () => {
    auditLogCreate.mockRejectedValueOnce(new Error("audit unavailable"))

    await expect(POST(buildReq(validBody))).rejects.toThrow("audit unavailable")
    expect(createApplication).toHaveBeenCalledOnce()
    expect(auditLogCreate).toHaveBeenCalledOnce()
    expect(triggerNotification).not.toHaveBeenCalled()
  })

  it("a client with no agent attribution records no referral event", async () => {
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(201)
    expect(resolveReferralCodeById).not.toHaveBeenCalled()
    expect(recordReferralEvent).not.toHaveBeenCalled()
  })

  it("a referred client's FIRST loan is NOT re-credited here (avoids double-counting the signup enquiry event)", async () => {
    findFirstClient.mockResolvedValue({ ...CLIENT, referralCodeId: "code1" })
    countLoan.mockResolvedValue(0) // no prior loan → first-time borrower
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(201)
    // gated out before we even resolve the code
    expect(resolveReferralCodeById).not.toHaveBeenCalled()
    expect(recordReferralEvent).not.toHaveBeenCalled()
  })

  it("a REPEAT loan by a referred client records a NOT_ELIGIBLE attribution event (commission accrues at disbursement)", async () => {
    findFirstClient.mockResolvedValue({ ...CLIENT, referralCodeId: "code1" })
    countLoan.mockResolvedValue(1) // holds a prior loan → genuine repeat borrower
    resolveReferralCodeById.mockResolvedValue({ id: "code1", agentId: "agent1", agent: { status: "ACTIVE" } })
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(201)
    expect(resolveReferralCodeById).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: "t1", id: "code1" },
    )
    expect(recordReferralEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "WEBSITE_APPLICATION",
        source: "PORTAL",
        commissionStatus: "NOT_ELIGIBLE",
        amountCents: 150000,
        referralCode: expect.objectContaining({ id: "code1" }),
        metadata: expect.objectContaining({ applicationId: "app1", repeatLoan: true }),
      }),
    )
  })

  it("does NOT credit the agent when the stored code/agent is no longer active", async () => {
    findFirstClient.mockResolvedValue({ ...CLIENT, referralCodeId: "code1" })
    countLoan.mockResolvedValue(1) // repeat borrower, but...
    resolveReferralCodeById.mockResolvedValue(null) // suspended agent or retired code
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(201)
    expect(resolveReferralCodeById).toHaveBeenCalledOnce()
    expect(recordReferralEvent).not.toHaveBeenCalled()
  })

  it("attribution failure is non-fatal — the application still succeeds (201)", async () => {
    findFirstClient.mockResolvedValue({ ...CLIENT, referralCodeId: "code1" })
    countLoan.mockResolvedValue(1)
    resolveReferralCodeById.mockResolvedValue({ id: "code1", agentId: "agent1", agent: { status: "ACTIVE" } })
    recordReferralEvent.mockRejectedValue(new Error("db down"))
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(201)
    expect(createApplication).toHaveBeenCalledOnce()
  })
})

describe("POST /api/portal/applications — PO funding", () => {
  const PO_PRODUCT = {
    ...PRODUCT, id: "prod-po", code: "POFUND", name: "Purchase Order Funding", productType: "PO_FUNDING",
    minAmount: 1_000_000, maxAmount: 50_000_000, minTermDays: 30, maxTermDays: 120,
    interestModel: "DAILY_ACCRUAL", initiationFeePct: 0.02, initiationFeeMax: 0, monthlyServiceFee: 0,
  }
  const poBody = {
    ...validBody, productCode: "POFUND", amount: 50_000, termDays: 60, purpose: "Supply 400 school uniforms",
    creditLifeMonthlyPremiumCents: 22_500,
    loanPurposeCategory: "BUSINESS", poNumber: "PO-2026-0412", poBuyerName: "Synthetic Schools Trust", poDocumentId: "doc-po",
  }

  beforeEach(() => {
    findFirstProduct.mockResolvedValue(PO_PRODUCT)
    findFirstDocument.mockResolvedValue({ id: "doc-po" })
  })

  it("refuses a consumer purpose: PO funding is for a business", async () => {
    const res = await POST(buildReq({ ...poBody, loanPurposeCategory: "MEDICAL" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/business/i)
    expect(createApplication).not.toHaveBeenCalled()
  })

  it.each([
    ["poNumber", { poNumber: " " }],
    ["poBuyerName", { poBuyerName: "" }],
    ["poDocumentId", { poDocumentId: undefined }],
  ])("refuses an application without %s", async (_field, missing) => {
    const res = await POST(buildReq({ ...poBody, ...missing }))
    expect(res.status).toBe(400)
    expect(createApplication).not.toHaveBeenCalled()
  })

  it("refuses a PO document that is not this client's purchase order", async () => {
    findFirstDocument.mockResolvedValue(null)
    const res = await POST(buildReq(poBody))
    expect(res.status).toBe(422)
    expect(findFirstDocument).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "doc-po", tenantId: "t1", clientId: "c1", docType: "PO_DOCUMENT", deletedAt: null },
    }))
    expect(createApplication).not.toHaveBeenCalled()
  })

  it("checks the PO document inside the create transaction, after the client evidence lock the delete route takes", async () => {
    const res = await POST(buildReq(poBody))
    expect(res.status).toBe(201)
    expect(transaction).toHaveBeenCalled()
    const lockSql = queryRaw.mock.calls.map((c) => JSON.stringify(c[0]))
    expect(lockSql.some((q) => q.includes("affordability-client:t1:c1"))).toBe(true)
    // The first raw query in the transaction is the advisory client-evidence lock.
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(findFirstDocument.mock.invocationCallOrder[0])
    expect(findFirstDocument).toHaveBeenCalledTimes(1)
  })

  it("stores the purchase-order facts with the application", async () => {
    const res = await POST(buildReq(poBody))
    expect(res.status).toBe(201)
    expect(createApplication).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        loanPurposeCategory: "BUSINESS",
        poNumber: "PO-2026-0412", poBuyerName: "Synthetic Schools Trust", poDocumentId: "doc-po",
      }),
    }))
  })

  it("ignores PO fields on a consumer product", async () => {
    findFirstProduct.mockResolvedValue(PRODUCT)
    const res = await POST(buildReq({ ...validBody, poNumber: "PO-1", poBuyerName: "X", poDocumentId: "doc-po" }))
    expect(res.status).toBe(201)
    const data = createApplication.mock.calls[0][0].data
    expect(data.poNumber).toBeUndefined()
    expect(findFirstDocument).not.toHaveBeenCalled()
  })
})

describe("POST /api/portal/applications — credit life at or below the R1,000 threshold (B6)", () => {
  // Cover cannot be added to a principal of R1,000 or less, so a configured
  // product is not an offer here: the application records the no-offer
  // disclosure, never "DECLINED" against a product the consumer could not take.
  const small = { ...validBody, amount: 800 }

  it("records the no-offer state although a product is configured", async () => {
    const res = await POST(buildReq(small))
    expect(res.status).toBe(201)
    expect(createApplication).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        creditLifeElection: "DECLINED",
        creditLifeDisclosureVersion: "credit-life-no-offer-v1",
        creditLifeProductId: null,
        creditLifeProductName: null,
        creditLifeInsurerId: null,
        creditLifeInsurerName: null,
        creditLifeMonthlyPremiumCents: 0,
      }),
    }))
  })

  it("needs no election or acknowledgement, as when nothing is configured", async () => {
    const { creditLifeProductId: _p, creditLifeProductName: _n, creditLifeInsurerId: _i,
      creditLifeInsurerName: _in, creditLifeMonthlyPremiumCents: _m, ...noOffer } = small as Record<string, unknown>
    const res = await POST(buildReq({ ...noOffer, creditLifeElection: "", creditLifeDisclosureAcknowledged: false }))
    expect(res.status).toBe(201)
    expect(createApplication).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ creditLifeDisclosureVersion: "credit-life-no-offer-v1" }),
    }))
  })

  it("still refuses ACCEPTED", async () => {
    const res = await POST(buildReq({ ...small, creditLifeElection: "ACCEPTED" }))
    expect(res.status).toBe(422)
    expect(createApplication).not.toHaveBeenCalled()
  })

  it("keeps recording DECLINED against the offer above the threshold", async () => {
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(201)
    expect(createApplication).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ creditLifeDisclosureVersion: "credit-life-election-v1", creditLifeProductId: CREDIT_LIFE_PRODUCT.id }),
    }))
  })
})
