// The bind route must judge a bind at the SAME instant it defaults the start
// date to.
//
// `bindQuote` refuses `startDate < now`. The route used to stamp `startDate`
// with its own `new Date()` and let `bindQuote` default `now` to a second
// `new Date()` read after it — so the ordinary "bind, starting today" call was
// correct only while both reads landed in the same millisecond. A DB round-trip
// or a slow event loop between them turns a valid bind into
// START_DATE_OUT_OF_RANGE.
//
// This lives in its own file, and mocks `bindQuote` rather than driving the
// real one, ON PURPOSE. The race is sub-millisecond, so no behavioural test can
// observe it: removing `now` from the route's call passes every test in
// `route.test.ts`. The only falsifiable statement is about the call itself —
// that the route hands down one instant, not two.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { POST } from "./route"
import { NextRequest } from "next/server"
import { signDraftToken } from "@/lib/insurance/disclosure-token"

const { bindQuote, logAudit, requireApiRole, tenantConfigFindUnique } = vi.hoisted(() => ({
  bindQuote: vi.fn(),
  logAudit: vi.fn(),
  requireApiRole: vi.fn(),
  tenantConfigFindUnique: vi.fn(),
}))

vi.mock("@/lib/insurance/policy/bind", () => ({ bindQuote }))
vi.mock("@/lib/prisma", () => ({
  prisma: { tenantConfig: { findUnique: tenantConfigFindUnique } },
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) =>
    fn({ id: "tenant-1", name: "Test Tenant" }),
}))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole }))
vi.mock("@/lib/audit", () => ({ logAudit, AuditAction: new Proxy({}, { get: (_t, k) => String(k) }) }))

beforeEach(() => {
  process.env.NEXTAUTH_SECRET = "test-secret-do-not-use-in-prod-1234567890abcdef"
  requireApiRole.mockResolvedValue({ user: { id: "u1", email: "officer@acme-lending.example" } })
  tenantConfigFindUnique.mockResolvedValue({ featureCrm: false, featureIms: true })
  bindQuote.mockResolvedValue({
    ok: true,
    policyId: "policy-1",
    policyNumber: "FUN-0001",
    premiumAmount: "83.00",
    sumAssured: "20000.00",
    livesActivated: 1,
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

function validToken() {
  return signDraftToken({
    quoteId: "quote-1",
    tenantId: "tenant-1",
    clientId: "client-1",
    advisorId: "advisor-1",
    type: "FUNERAL_COVER",
    sumAssured: 20000,
    premiumAmount: 83,
    productId: "product-1",
  })
}

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/insurance/quotes/quote-1/bind", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

const ctx = { params: Promise.resolve({ id: "quote-1" }) }

describe("POST bind — one instant, not two", () => {
  it("passes an explicit `now` to bindQuote rather than letting it read its own", async () => {
    await POST(request({ draftToken: validToken() }), ctx)

    expect(bindQuote).toHaveBeenCalledTimes(1)
    const args = bindQuote.mock.calls[0][1]
    // `now` absent means bindQuote falls back to its own `new Date()`, read
    // after this route's — which is the race.
    expect(args.now).toBeInstanceOf(Date)
  })

  it("defaults startDate to the very same instant it judges the bind at", async () => {
    await POST(request({ draftToken: validToken() }), ctx)

    const args = bindQuote.mock.calls[0][1]
    // Not "close to" — the SAME value. `startDate < now` can then never be true
    // by construction for a caller who did not name a start date.
    expect(args.startDate.getTime()).toBe(args.now.getTime())
  })

  it("judges a caller-supplied startDate against that same instant", async () => {
    await POST(request({ draftToken: validToken(), startDate: "2026-09-01T00:00:00Z" }), ctx)

    const args = bindQuote.mock.calls[0][1]
    expect(args.startDate.toISOString()).toBe("2026-09-01T00:00:00.000Z")
    expect(args.now).toBeInstanceOf(Date)
    // The caller's date is honoured; `now` is still the route's own reading and
    // is not silently taken from the body.
    expect(args.now.getTime()).not.toBe(args.startDate.getTime())
  })
})
