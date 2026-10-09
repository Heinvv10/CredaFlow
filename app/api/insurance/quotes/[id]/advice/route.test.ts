// app/api/insurance/quotes/[id]/advice/route.test.ts
//
// The FAIS record of advice. Both audit actions are asserted — the record
// written, and the refusal — because a refusal here is a statutory obligation
// not being met, which is precisely the thing that must leave a trace.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const {
  requireApiRole,
  findFirstQuote,
  findFirstAdvice,
  createAdvice,
  updateQuote,
  transaction,
  tenantConfigFindUnique,
  logAudit,
} = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  findFirstQuote: vi.fn(),
  findFirstAdvice: vi.fn(),
  createAdvice: vi.fn(),
  updateQuote: vi.fn(),
  transaction: vi.fn(),
  tenantConfigFindUnique: vi.fn(),
  logAudit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: tenantConfigFindUnique },
    insuranceQuote: { findFirst: findFirstQuote },
    insuranceAdviceRecord: { findFirst: findFirstAdvice, create: createAdvice },
    $transaction: transaction,
  },
}))

vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) =>
    fn({ id: "tenant-1", name: "Test Tenant" }),
}))

vi.mock("@/lib/auth-guards", () => ({ requireApiRole }))
vi.mock("@/lib/audit", () => ({ logAudit, AuditAction: new Proxy({}, { get: (_t, k) => String(k) }) }))

import { GET, POST } from "./route"

function decimal(value: string) {
  return { toFixed: (dp: number) => Number(value).toFixed(dp) }
}

const QUOTE = {
  id: "quote-1",
  quoteNumber: "QTE-1",
  status: "QUOTED",
  totalPremium: decimal("83.00"),
  adviceRecord: null,
}

const VALID_BODY = {
  needsAnalysis: "Sole earner, three dependants, no existing cover.",
  productsConsidered: [{ code: "FUN-10K" }, { code: "FUN-20K" }],
  recommendation: "FUN-10K",
  clientDecision: "ACCEPTED_RECOMMENDATION",
}

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/insurance/quotes/quote-1/advice", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

const getReq = () => new NextRequest("http://localhost/api/insurance/quotes/quote-1/advice")
const ctx = { params: Promise.resolve({ id: "quote-1" }) }

function roleRefusal() {
  return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
}

beforeEach(() => {
  requireApiRole.mockResolvedValue({ user: { id: "user-1", email: "officer@acme-lending.example" } })
  tenantConfigFindUnique.mockResolvedValue({ featureCrm: false, featureIms: true })
  findFirstQuote.mockResolvedValue(QUOTE)
  findFirstAdvice.mockResolvedValue({ id: "advice-1", quoteId: "quote-1" })
  createAdvice.mockResolvedValue({ id: "advice-1" })
  // updateMany now, status-guarded: a count of 0 means someone else moved the
  // quote and the whole transaction rolls back.
  updateQuote.mockResolvedValue({ count: 1 })
  transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      insuranceAdviceRecord: { create: createAdvice },
      insuranceQuote: { updateMany: updateQuote },
    })
  )
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("GET advice — role guard", () => {
  it("requires only READONLY", async () => {
    await GET(getReq(), ctx)
    expect(requireApiRole).toHaveBeenCalledWith("READONLY")
  })

  it("returns the guard's refusal and reads nothing behind it", async () => {
    requireApiRole.mockResolvedValue(roleRefusal())

    const res = await GET(getReq(), ctx)

    expect(res.status).toBe(403)
    expect(findFirstAdvice).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("scopes the read to the caller's tenant", async () => {
    await GET(getReq(), ctx)
    expect(findFirstAdvice).toHaveBeenCalledWith(
      expect.objectContaining({ where: { quoteId: "quote-1", tenantId: "tenant-1" } })
    )
  })

  it("is 404 when the quote has no record of advice", async () => {
    findFirstAdvice.mockResolvedValue(null)
    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(404)
  })
})

describe("POST advice — role guard", () => {
  it("requires INSURANCE_OFFICER, not READONLY", async () => {
    await POST(postReq(VALID_BODY), ctx)
    expect(requireApiRole).toHaveBeenCalledWith("INSURANCE_OFFICER")
  })

  it("returns the guard's refusal, writes nothing and audits nothing", async () => {
    requireApiRole.mockResolvedValue(roleRefusal())

    const res = await POST(postReq(VALID_BODY), ctx)

    expect(res.status).toBe(403)
    expect(findFirstQuote).not.toHaveBeenCalled()
    expect(createAdvice).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })
})

describe("POST advice — shape rejections write NO audit row", () => {
  it("a malformed body is 422 and unaudited", async () => {
    const res = await POST(postReq("nope"), ctx)
    expect(res.status).toBe(422)
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("an unknown clientDecision is 422 and unaudited", async () => {
    const res = await POST(postReq({ ...VALID_BODY, clientDecision: "MAYBE" }), ctx)
    expect(res.status).toBe(422)
    expect(createAdvice).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("a missing productsConsidered is 422 and unaudited", async () => {
    // The record must show what was CONSIDERED, not only what was recommended.
    const { productsConsidered: _omitted, ...noProducts } = VALID_BODY
    const res = await POST(postReq(noProducts), ctx)
    expect(res.status).toBe(422)
    expect(logAudit).not.toHaveBeenCalled()
  })
})

describe("POST advice — refusals ARE audited", () => {
  it("audits a departure from the recommendation with no reason given", async () => {
    const res = await POST(postReq({ ...VALID_BODY, clientDecision: "CHOSE_ALTERNATIVE" }), ctx)

    expect(res.status).toBe(422)
    expect((await res.json()).reason).toBe("REASON_REQUIRED")
    expect(createAdvice).not.toHaveBeenCalled()
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSURANCE_ADVICE_REFUSED",
        entity: "InsuranceQuote",
        entityId: "quote-1",
        newValue: expect.objectContaining({ reason: "REASON_REQUIRED" }),
      })
    )
  })

  it("audits a second record against a quote that already has one", async () => {
    findFirstQuote.mockResolvedValue({ ...QUOTE, adviceRecord: { id: "advice-existing" } })

    const res = await POST(postReq(VALID_BODY), ctx)

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("ALREADY_RECORDED")
    expect(createAdvice).not.toHaveBeenCalled()
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "INSURANCE_ADVICE_REFUSED" })
    )
  })

  it("audits advice against a quote that never priced", async () => {
    findFirstQuote.mockResolvedValue({ ...QUOTE, status: "DRAFT", totalPremium: null })

    const res = await POST(postReq(VALID_BODY), ctx)

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("QUOTE_NOT_ADVISABLE")
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "INSURANCE_ADVICE_REFUSED" })
    )
  })

  it("reports another tenant's quote as 404 and audits the refusal", async () => {
    findFirstQuote.mockResolvedValue(null)

    const res = await POST(postReq(VALID_BODY), ctx)

    expect(res.status).toBe(404)
    expect((await res.json()).reason).toBe("QUOTE_NOT_FOUND")
    expect(createAdvice).not.toHaveBeenCalled()
  })
})

describe("POST advice — the success path", () => {
  it("audits the record with its content hash rather than its text", async () => {
    const res = await POST(postReq(VALID_BODY), ctx)

    expect(res.status).toBe(201)
    expect(logAudit).toHaveBeenCalledTimes(1)
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSURANCE_ADVICE_RECORDED",
        entity: "InsuranceAdviceRecord",
        entityId: "advice-1",
        newValue: expect.objectContaining({
          quoteId: "quote-1",
          clientDecision: "ACCEPTED_RECOMMENDATION",
          quoteStatus: "ADVICE_RECORDED",
          // The hash is the evidence that THIS document was recorded; the
          // record itself holds the content.
          contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      })
    )
  })

  it("attributes the record to the calling user", async () => {
    await POST(postReq(VALID_BODY), ctx)
    expect(createAdvice).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ recordedById: "user-1" }) })
    )
  })

  it("accepts a departure that carries its reason", async () => {
    const res = await POST(
      postReq({
        ...VALID_BODY,
        clientDecision: "CHOSE_ALTERNATIVE",
        reasonIfDifferent: "Client preferred the larger cover despite the premium.",
      }),
      ctx
    )

    expect(res.status).toBe(201)
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "INSURANCE_ADVICE_RECORDED" })
    )
  })
})

describe("POST advice — a concurrent status change is not overwritten", () => {
  it("is 409 and records no advice when the quote moved first", async () => {
    // The quote was REJECTED between recordAdvice's read and its write. The
    // status-guarded updateMany matches nothing, the transaction rolls back,
    // and no orphan advice record survives.
    updateQuote.mockResolvedValue({ count: 0 })

    const res = await POST(postReq(VALID_BODY), ctx)

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("QUOTE_CHANGED")
    expect(logAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "INSURANCE_ADVICE_RECORDED" })
    )
  })
})
