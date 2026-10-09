import { afterEach, describe, expect, it, vi } from "vitest"

const { updateRequest } = vi.hoisted(() => ({ updateRequest: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: { stitchPaymentRequest: { update: updateRequest } },
}))

// req.url mirrors the container's internal bind (0.0.0.0:3300) in production —
// the whole point of PORT-01b is that the redirect Location must NOT be built
// from it.
function makeReq(qs: string) {
  return new Request(`https://0.0.0.0:3300/api/portal/payment/callback${qs}`)
}

afterEach(() => { vi.clearAllMocks() })

describe("GET /api/portal/payment/callback", () => {
  it("redirects a completed payment to the success page with a RELATIVE Location", async () => {
    updateRequest.mockResolvedValue({})
    const { GET } = await import("./route")
    const res = await GET(makeReq("?status=complete&id=stitch1"))

    expect(res.status).toBe(307)
    const loc = res.headers.get("location")
    // PORT-01b: relative path only — an absolute URL built from req.url would be
    // https://0.0.0.0:3300/... which the payer's browser cannot reach.
    expect(loc).toBe("/portal/payment/success")
    expect(loc).not.toMatch(/^https?:|0\.0\.0\.0/)
  })

  it("redirects a failed payment to the failure page", async () => {
    updateRequest.mockResolvedValue({})
    const { GET } = await import("./route")
    const res = await GET(makeReq("?status=failed&id=stitch1"))

    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toBe("/portal/payment/failure")
  })

  it("treats an unknown status as failure and still emits a relative Location", async () => {
    const { GET } = await import("./route")
    const res = await GET(makeReq("?status=cancelled"))

    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toBe("/portal/payment/failure")
    expect(updateRequest).not.toHaveBeenCalled() // no id → no status write
  })
})
