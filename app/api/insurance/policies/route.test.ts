// app/api/insurance/policies/route.test.ts
import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { signDraftToken } from "@/lib/insurance/disclosure-token"

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const {
  findFirstClient,
  findFirstUser,
  findFirstProduct,
  findFirstLoan,
  countPolicies,
  findUniquePolicy,
  createPolicy,
  createManyPremiums,
  createCommission,
  prismaTransaction,
  logAudit,
} = vi.hoisted(() => ({
  findFirstClient: vi.fn(),
  findFirstUser: vi.fn(),
  findFirstProduct: vi.fn(),
  findFirstLoan: vi.fn(),
  countPolicies: vi.fn().mockResolvedValue(0),
  // Default: no existing policy carries this token hash — i.e. no replay.
  findUniquePolicy: vi.fn().mockResolvedValue(null),
  createPolicy: vi.fn(),
  createManyPremiums: vi.fn().mockResolvedValue({ count: 12 }),
  createCommission: vi.fn().mockResolvedValue({}),
  prismaTransaction: vi.fn(),
  logAudit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: true }) },
    client: { findFirst: findFirstClient },
    user: { findFirst: findFirstUser },
    insuranceProduct: { findFirst: findFirstProduct },
    loan: { findFirst: findFirstLoan },
    insurancePolicy: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: findUniquePolicy,
      count: countPolicies,
      create: createPolicy,
    },
    premiumPayment: { createMany: createManyPremiums },
    advisorCommission: { create: createCommission },
    $transaction: prismaTransaction,
  },
}))

// featureIms ON — the IMS API gate (requireImsEnabled) must be a no-op
// for every behaviour asserted below. The gate reads the LIVE TenantConfig
// row (uncached, so the kill switch has no fuse), so it is stubbed on the
// prisma mock rather than on getTenantConfig.
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) =>
    fn({ id: "tenant-1", name: "Test Tenant" }),
}))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn().mockResolvedValue({
    user: { id: "user-1", email: "officer@acme-lending.example" },
  }),
}))

vi.mock("@/lib/audit", () => ({
  logAudit,
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

const SECRET = "test-secret-do-not-use-in-prod-1234567890abcdef"

/**
 * Build a valid FAIS gate body for a FUNERAL_COVER policy.
 * sumAssured and premiumAmount are in CENTS (as the route expects from callers).
 * The draft token is signed with RANDS (as Task 6 produces).
 */
function buildValidBody(overrides: Record<string, unknown> = {}) {
  // Token payload in rands
  const tokenPayload = {
    tenantId: "tenant-1",
    clientId: "client-1",
    advisorId: "advisor-1",
    type: "FUNERAL_COVER",
    sumAssured: 50000,   // rands
    premiumAmount: 420,  // rands
    productId: "prod-1",
  }
  const draftToken = signDraftToken(tokenPayload)
  const faisDisclosurePdfUrl = `/api/insurance/disclosures/${draftToken}`

  return {
    // FAIS gate fields
    faisDisclosureAt: new Date().toISOString(),
    faisDisclosurePdfUrl,
    draftToken,
    // Policy fields — sumAssured/premiumAmount in CENTS
    clientId: "client-1",
    advisorId: "advisor-1",
    type: "FUNERAL_COVER",
    sumAssured: 50000 * 100,   // cents
    premiumAmount: 420 * 100,  // cents
    productId: "prod-1",
    startDate: "2026-01-01",
    ...overrides,
  }
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/insurance/policies", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

/**
 * Set up mocks for the happy path (client found, advisor found, product found,
 * policy created). The `$transaction` mock invokes the callback with a tx stub
 * that captures the create() call.
 */
function setupHappyPathMocks(policySourceCapture?: { value?: string }) {
  findFirstClient.mockResolvedValue({
    id: "client-1",
    email: "client@example.com",
    firstName: "Thandeka",
    lastName: "Mokoena",
  })
  findFirstUser.mockResolvedValue({ id: "advisor-1" })
  findFirstProduct.mockResolvedValue({ id: "prod-1", commissionRate: 0.15 })

  const createdPolicy = { id: "policy-1", policyNumber: "FUN-0001" }

  prismaTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      insurancePolicy: {
        create: vi.fn().mockImplementation((args: { data: { policySource?: string } }) => {
          if (policySourceCapture) {
            policySourceCapture.value = args.data.policySource
          }
          return Promise.resolve(createdPolicy)
        }),
      },
      premiumPayment: { createMany: vi.fn().mockResolvedValue({ count: 12 }) },
      advisorCommission: { create: vi.fn().mockResolvedValue({}) },
    }
    return fn(tx)
  })

  return createdPolicy
}

// ── Tests ─────────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
})

describe("POST /api/insurance/policies — FAIS gate", () => {
  it("1. returns 422 and fires gate-rejected audit when faisDisclosureAt is missing", async () => {
    process.env.NEXTAUTH_SECRET = SECRET

    const body = buildValidBody()
    delete (body as Record<string, unknown>).faisDisclosureAt

    const { POST } = await import("./route")
    const res = await POST(makeRequest(body))

    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.error).toMatch(/FAIS disclosure required/i)

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSURANCE_FAIS_GATE_REJECTED",
        entity: "InsurancePolicy",
        newValue: expect.objectContaining({ reason: "fais_required" }),
      })
    )
  })

  it("2. returns 422 when the draftToken has been tampered with", async () => {
    process.env.NEXTAUTH_SECRET = SECRET

    const body = buildValidBody({ draftToken: "tampered.garbage" })

    const { POST } = await import("./route")
    const res = await POST(makeRequest(body))

    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.error).toMatch(/invalid or expired/i)

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSURANCE_FAIS_GATE_REJECTED",
        newValue: expect.objectContaining({ reason: "invalid_token" }),
      })
    )
  })

  it("3. returns 422 with reason hash_mismatch when sum assured changed since disclosure", async () => {
    process.env.NEXTAUTH_SECRET = SECRET

    // Token was signed for 50 000 rands, but body now claims 60 000 rands (6 000 000 cents)
    const body = buildValidBody({ sumAssured: 6_000_000 })

    const { POST } = await import("./route")
    const res = await POST(makeRequest(body))

    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.error).toMatch(/do not match the FAIS disclosure/i)

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSURANCE_FAIS_GATE_REJECTED",
        newValue: expect.objectContaining({ reason: "hash_mismatch" }),
      })
    )
  })

  it("4. returns 200 and fires INSURANCE_FAIS_DISCLOSURE_ACKNOWLEDGED on a valid request", async () => {
    process.env.NEXTAUTH_SECRET = SECRET

    const createdPolicy = setupHappyPathMocks()
    countPolicies.mockResolvedValue(0)

    const { POST } = await import("./route")
    const res = await POST(makeRequest(buildValidBody()))

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.policyNumber).toBe(createdPolicy.policyNumber)

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSURANCE_FAIS_DISCLOSURE_ACKNOWLEDGED",
        entity: "InsurancePolicy",
        entityId: createdPolicy.id,
        newValue: expect.objectContaining({
          advisorId: "advisor-1",
          clientId: "client-1",
        }),
      })
    )
  })

  it("5. coerces policySource to STANDALONE even when body claims BUNDLED_CREDIT_AGREEMENT", async () => {
    process.env.NEXTAUTH_SECRET = SECRET

    const capture: { value?: string } = {}
    setupHappyPathMocks(capture)
    countPolicies.mockResolvedValue(0)

    const body = buildValidBody({ policySource: "BUNDLED_CREDIT_AGREEMENT" })

    const { POST } = await import("./route")
    const res = await POST(makeRequest(body))

    expect(res.status).toBe(200)
    // The $transaction mock captured the policySource used in create()
    expect(capture.value).toBe("STANDALONE")
  })

  it("6. server-stamps faisDisclosureAt and ignores any client-supplied value", async () => {
    process.env.NEXTAUTH_SECRET = SECRET

    findFirstClient.mockResolvedValue({
      id: "client-1",
      email: "client@example.com",
      firstName: "Thandeka",
      lastName: "Mokoena",
    })
    findFirstUser.mockResolvedValue({ id: "advisor-1" })
    findFirstProduct.mockResolvedValue({ id: "prod-1", commissionRate: 0.15 })
    countPolicies.mockResolvedValue(0)

    const created = { id: "policy-1", policyNumber: "FUN-0001" }
    const dataCapture: { value?: Record<string, unknown> } = {}
    prismaTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        insurancePolicy: {
          create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
            dataCapture.value = args.data
            return Promise.resolve(created)
          }),
        },
        premiumPayment: { createMany: vi.fn().mockResolvedValue({ count: 12 }) },
        advisorCommission: { create: vi.fn().mockResolvedValue({}) },
      }
      return fn(tx)
    })

    // Client claims a disclosure timestamp from 24 hours ago — server must ignore it.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const before = Date.now()
    const { POST } = await import("./route")
    const res = await POST(makeRequest(buildValidBody({ faisDisclosureAt: yesterday })))
    const after = Date.now()

    expect(res.status).toBe(200)

    const persisted = dataCapture.value?.faisDisclosureAt
    expect(persisted).toBeInstanceOf(Date)
    const persistedMs = (persisted as Date).getTime()
    expect(persistedMs).toBeGreaterThanOrEqual(before)
    expect(persistedMs).toBeLessThanOrEqual(after)
    // And it must NOT equal the (manipulable) client-supplied value.
    expect(persistedMs).not.toBe(new Date(yesterday).getTime())

    // Audit log records the server-stamped time, not the client value.
    const ackCall = logAudit.mock.calls.find(
      ([arg]) => (arg as { action?: string }).action === "INSURANCE_FAIS_DISCLOSURE_ACKNOWLEDGED"
    )
    expect(ackCall).toBeDefined()
    const ackPayload = (ackCall![0] as { newValue: { faisDisclosureAt: string } }).newValue
    expect(ackPayload.faisDisclosureAt).not.toBe(yesterday)
  })

  it("7. returns 422 token_replay when the same draftToken has already bound a policy", async () => {
    process.env.NEXTAUTH_SECRET = SECRET

    // The pre-check findUnique hits an existing row with this token's hash.
    findUniquePolicy.mockResolvedValueOnce({ id: "earlier-policy" })
    // (No need to set up the rest of the happy path — the route should bail
    // before reaching the transaction.)

    const { POST } = await import("./route")
    const res = await POST(makeRequest(buildValidBody()))

    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.error).toMatch(/already been used/i)

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSURANCE_FAIS_GATE_REJECTED",
        newValue: expect.objectContaining({ reason: "token_replay" }),
      })
    )
    // Importantly, the transaction must NOT have been invoked.
    expect(prismaTransaction).not.toHaveBeenCalled()
  })
})

describe("POST /api/insurance/policies — a QUOTE's disclosure is not redeemable here", () => {
  /** A body whose token additionally names a quote, as the quote path issues. */
  function quoteTokenBody(quoteId: string) {
    const draftToken = signDraftToken({
      tenantId: "tenant-1", clientId: "client-1", advisorId: "advisor-1",
      type: "FUNERAL_COVER", sumAssured: 50000, premiumAmount: 420, productId: "prod-1",
      quoteId,
    })
    return buildValidBody({
      draftToken,
      faisDisclosurePdfUrl: `/api/insurance/disclosures/${draftToken}`,
    })
  }

  it("refuses a token carrying a quoteId, so the FAIS advice gate cannot be skipped", async () => {
    // The attack: create a quote, mint a disclosure while it is still QUOTED
    // (no advice record exists), then spend that token HERE — a route that
    // never consults the quote. The result was an ACTIVE policy with a premium
    // schedule and an advisor commission and NO record of advice, because the
    // advice gate lives on the bind path this sequence never touches.
    const { POST } = await import("./route")
    const res = await POST(makeRequest(quoteTokenBody("quote-1")))

    expect(res.status).toBe(422)
    expect((await res.json()).reason).toBe("QUOTE_TOKEN_NOT_REDEEMABLE_HERE")
    expect(createPolicy).not.toHaveBeenCalled()
  })

  it("refuses on the PRESENCE of a quoteId, whatever the quote's status", async () => {
    // Refused on presence rather than status: status-based reasoning would
    // close today's instance and leave the class open.
    const { POST } = await import("./route")
    const res = await POST(makeRequest(quoteTokenBody("any-quote-at-all")))
    expect(res.status).toBe(422)
    expect(createPolicy).not.toHaveBeenCalled()
  })

  it("audits the refusal", async () => {
    const { POST } = await import("./route")
    await POST(makeRequest(quoteTokenBody("quote-1")))
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSURANCE_FAIS_GATE_REJECTED",
        newValue: expect.objectContaining({ reason: "quote_token_on_legacy_path", quoteId: "quote-1" }),
      })
    )
  })

  it("still accepts a LEGACY token carrying no quoteId", async () => {
    // The legitimate single-life standalone path is untouched.
    const { POST } = await import("./route")
    const res = await POST(makeRequest(buildValidBody()))
    expect(res.status).not.toBe(422)
  })
})


describe("POST /api/insurance/policies — premium schedule falls on the SAST 1st", () => {
  afterEach(() => vi.useRealTimers())

  it("writes the 1st of each SAST month, not a day out for a late-evening bind", async () => {
    // A policy bound at 22:30 SAST on 15 Aug is 20:30Z — same day either way.
    // But the schedule was built with local `setMonth` + `setDate(1)`, and the
    // container runs UTC, so for a startDate whose UTC and SAST dates differ
    // the premium fell due on the 2nd. These rows are WRITTEN, so the error is
    // durable: every one of the twelve instalments inherits it.
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-15T20:30:00Z"))
    setupHappyPathMocks()

    // The happy-path transaction mock builds its own `tx`, so the premium rows
    // are captured off that one rather than the module-level mock.
    const captured: Array<{ dueDate: Date }> = []
    prismaTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insurancePolicy: { create: vi.fn().mockResolvedValue({ id: "policy-1", policyNumber: "FUN-0001" }) },
        premiumPayment: {
          createMany: vi.fn().mockImplementation((args: { data: Array<{ dueDate: Date }> }) => {
            captured.push(...args.data)
            return Promise.resolve({ count: args.data.length })
          }),
        },
        advisorCommission: { create: vi.fn().mockResolvedValue({}) },
      }),
    )

    const { POST } = await import("./route")
    // 22:30Z on 15 Aug is already 00:30 on 16 August in Johannesburg — the
    // band where the UTC and SAST calendar dates disagree.
    const res = await POST(makeRequest(buildValidBody({ startDate: "2026-08-15T22:30:00Z" })))
    expect(res.status, "policy did not bind — fixture drifted").toBeLessThan(300)

    const rows = captured
    expect(rows).toHaveLength(12)
    for (const row of rows) {
      // SAST midnight on the 1st is 22:00Z on the last day of the month before.
      expect(row.dueDate.toISOString()).toMatch(/T22:00:00\.000Z$/)
      const sastDay = new Date(row.dueDate.getTime() + 2 * 60 * 60 * 1000).getUTCDate()
      expect(sastDay, `premium due on the ${sastDay}, not the 1st`).toBe(1)
    }
    // Start month is August in SAST, so the first premium is due 1 September
    // — SAST midnight, i.e. 22:00Z on 31 August. Local arithmetic would produce
    // 2026-09-01T22:30Z, which reads as the 2nd in Johannesburg.
    expect(rows[0].dueDate.toISOString()).toBe("2026-08-31T22:00:00.000Z")
  })
})
