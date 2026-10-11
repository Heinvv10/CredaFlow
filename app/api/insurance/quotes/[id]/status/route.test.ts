// app/api/insurance/quotes/[id]/status/route.test.ts
//
// The status route is where a quote is walked toward being sold, so its
// refusals matter as much as its successes. Two audit actions live here and
// both are asserted: the successful change, and the REFUSED transition — the
// latter is the row an auditor asking "did the FAIS gate ever actually fire?"
// needs to exist.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const { requireApiRole, findFirstQuote, updateManyQuote, tenantConfigFindUnique, logAudit } = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  findFirstQuote: vi.fn(),
  updateManyQuote: vi.fn(),
  tenantConfigFindUnique: vi.fn(),
  logAudit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: tenantConfigFindUnique },
    insuranceQuote: { findFirst: findFirstQuote, updateMany: updateManyQuote },
  },
}))

vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) =>
    fn({ id: "tenant-1", name: "Test Tenant" }),
}))

vi.mock("@/lib/auth-guards", () => ({ requireApiRole }))
vi.mock("@/lib/audit", () => ({ logAudit, AuditAction: new Proxy({}, { get: (_t, k) => String(k) }) }))

import { PATCH } from "./route"

const PASSED = { pass: true, failures: [] }
const ADVISED = { id: "quote-1", status: "QUOTED", quoteNumber: "QTE-1", adviceRecord: { id: "advice-1" }, eligibilityResult: PASSED, totalPremium: "83.00" }
const UNADVISED = { id: "quote-1", status: "QUOTED", quoteNumber: "QTE-1", adviceRecord: null, eligibilityResult: PASSED, totalPremium: "83.00" }

function req(body: unknown) {
  return new NextRequest("http://localhost/api/insurance/quotes/quote-1/status", {
    method: "PATCH",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

const ctx = { params: Promise.resolve({ id: "quote-1" }) }

function roleRefusal() {
  return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
}

beforeEach(() => {
  requireApiRole.mockResolvedValue({ user: { id: "user-1", email: "officer@acme-lending.example" } })
  tenantConfigFindUnique.mockResolvedValue({ featureCrm: false, featureIms: true })
  findFirstQuote.mockResolvedValue(ADVISED)
  updateManyQuote.mockResolvedValue({ count: 1 })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("PATCH status — role guard", () => {
  it("requires INSURANCE_OFFICER", async () => {
    await PATCH(req({ status: "ADVICE_RECORDED" }), ctx)
    expect(requireApiRole).toHaveBeenCalledWith("INSURANCE_OFFICER")
  })

  it("returns the guard's refusal, updates nothing and audits nothing", async () => {
    requireApiRole.mockResolvedValue(roleRefusal())

    const res = await PATCH(req({ status: "ADVICE_RECORDED" }), ctx)

    expect(res.status).toBe(403)
    expect(findFirstQuote).not.toHaveBeenCalled()
    expect(updateManyQuote).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })
})

describe("PATCH status — rejected requests write NO audit row", () => {
  it("a malformed body is 422 and unaudited", async () => {
    const res = await PATCH(req("nonsense"), ctx)
    expect(res.status).toBe(422)
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("an unknown status is 422 and unaudited", async () => {
    const res = await PATCH(req({ status: "BANANA" }), ctx)
    expect(res.status).toBe(422)
    expect(updateManyQuote).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("another tenant's quote is 404 and unaudited", async () => {
    findFirstQuote.mockResolvedValue(null)

    const res = await PATCH(req({ status: "ADVICE_RECORDED" }), ctx)

    expect(res.status).toBe(404)
    expect(updateManyQuote).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("scopes the lookup to the caller's tenant", async () => {
    await PATCH(req({ status: "ADVICE_RECORDED" }), ctx)
    expect(findFirstQuote).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "quote-1", tenantId: "tenant-1" } })
    )
  })
})

describe("PATCH status — a refused transition IS audited", () => {
  it("audits an attempt to advance without a record of advice", async () => {
    // The FAIS control. An auditor asking whether it ever fired needs this row.
    findFirstQuote.mockResolvedValue(UNADVISED)

    const res = await PATCH(req({ status: "ADVICE_RECORDED" }), ctx)

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("ADVICE_REQUIRED")
    expect(updateManyQuote).not.toHaveBeenCalled()
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSURANCE_QUOTE_TRANSITION_REFUSED",
        entity: "InsuranceQuote",
        entityId: "quote-1",
        oldValue: { status: "QUOTED" },
        newValue: expect.objectContaining({ attempted: "ADVICE_RECORDED", reason: "ADVICE_REQUIRED" }),
      })
    )
  })

  it("audits an attempt to set CONVERTED through the API", async () => {
    // CONVERTED belongs to the bind alone. Reaching for it here is exactly the
    // sort of attempt the refusal log exists to record.
    findFirstQuote.mockResolvedValue({ ...ADVISED, status: "ACCEPTED" })

    const res = await PATCH(req({ status: "CONVERTED" }), ctx)

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("BIND_ONLY")
    expect(updateManyQuote).not.toHaveBeenCalled()
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "INSURANCE_QUOTE_TRANSITION_REFUSED" })
    )
  })

  it("audits an attempt to move a terminal quote", async () => {
    findFirstQuote.mockResolvedValue({ ...ADVISED, status: "REJECTED" })

    const res = await PATCH(req({ status: "QUOTED" }), ctx)

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("TERMINAL_STATUS")
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "INSURANCE_QUOTE_TRANSITION_REFUSED" })
    )
  })
})

describe("PATCH status — the success path", () => {
  it("audits the change with both the old and the new status", async () => {
    const res = await PATCH(req({ status: "ADVICE_RECORDED" }), ctx)

    expect(res.status).toBe(200)
    expect(logAudit).toHaveBeenCalledTimes(1)
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSURANCE_QUOTE_STATUS_CHANGED",
        entity: "InsuranceQuote",
        entityId: "quote-1",
        oldValue: { status: "QUOTED" },
        newValue: expect.objectContaining({ status: "ADVICE_RECORDED", quoteNumber: "QTE-1" }),
      })
    )
  })

  it("re-checks the status inside the UPDATE, not only in the read", async () => {
    // The read above the write is the friendly rejection; the WHERE clause is
    // the actual guard, because two concurrent requests can both read QUOTED.
    await PATCH(req({ status: "ADVICE_RECORDED" }), ctx)

    expect(updateManyQuote).toHaveBeenCalledWith({
      where: { id: "quote-1", tenantId: "tenant-1", status: "QUOTED" },
      data: { status: "ADVICE_RECORDED" },
    })
  })

  it("refuses with 409 when another request changed the status first", async () => {
    updateManyQuote.mockResolvedValue({ count: 0 })

    const res = await PATCH(req({ status: "ADVICE_RECORDED" }), ctx)

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("CONCURRENT_UPDATE")
    // No success row: nothing changed, so nothing is recorded as changed.
    expect(logAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "INSURANCE_QUOTE_STATUS_CHANGED" })
    )
  })
})

describe("PATCH status — a screened-out DRAFT cannot be promoted", () => {
  it("refuses DRAFT -> QUOTED when the quote FAILED the insurer's terms", async () => {
    // The laundering path. createQuote refused to WRITE this quote as QUOTED;
    // nothing stopped a later PATCH from setting the status the writer had
    // refused, after which it could be advised on, accepted and bound.
    findFirstQuote.mockResolvedValue({
      id: "quote-1", status: "DRAFT", quoteNumber: "QTE-1", adviceRecord: null,
      eligibilityResult: { pass: false, failures: [{ code: "MAX_ENTRY_AGE" }] },
      // Rating SUCCEEDED, so a premium is present — this is the case the
      // bind's NOT_PRICED guard does not catch.
      totalPremium: "83.00",
    })

    const res = await PATCH(req({ status: "QUOTED" }), ctx)

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("NOT_SELLABLE")
    expect(updateManyQuote).not.toHaveBeenCalled()
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "INSURANCE_QUOTE_TRANSITION_REFUSED" })
    )
  })

  it("refuses DRAFT -> QUOTED when the quote has no price", async () => {
    // Otherwise the quote takes a statutory Record of Advice whose content
    // hash covers `totalPremium: null` — a signed record about no price.
    findFirstQuote.mockResolvedValue({
      id: "quote-1", status: "DRAFT", quoteNumber: "QTE-1", adviceRecord: null,
      eligibilityResult: { pass: true, failures: [] }, totalPremium: null,
    })

    const res = await PATCH(req({ status: "QUOTED" }), ctx)

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("NOT_SELLABLE")
    expect(updateManyQuote).not.toHaveBeenCalled()
  })

  it("treats an unreadable eligibilityResult as a FAIL, not a pass", async () => {
    findFirstQuote.mockResolvedValue({
      id: "quote-1", status: "DRAFT", quoteNumber: "QTE-1", adviceRecord: null,
      eligibilityResult: null, totalPremium: "83.00",
    })

    const res = await PATCH(req({ status: "QUOTED" }), ctx)
    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("NOT_SELLABLE")
  })

  it("still refuses a DRAFT that failed on a malformed pass value", async () => {
    findFirstQuote.mockResolvedValue({
      id: "quote-1", status: "DRAFT", quoteNumber: "QTE-1", adviceRecord: null,
      eligibilityResult: { pass: "yes" }, totalPremium: "83.00",
    })
    const res = await PATCH(req({ status: "QUOTED" }), ctx)
    expect((await res.json()).reason).toBe("NOT_SELLABLE")
  })

  it("allows DRAFT -> REJECTED regardless — abandoning is never blocked", async () => {
    findFirstQuote.mockResolvedValue({
      id: "quote-1", status: "DRAFT", quoteNumber: "QTE-1", adviceRecord: null,
      eligibilityResult: { pass: false, failures: [] }, totalPremium: null,
    })

    const res = await PATCH(req({ status: "REJECTED" }), ctx)
    expect(res.status).toBe(200)
  })
})
