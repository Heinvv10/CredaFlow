import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/**
 * The one-time PASQ link is a borrower-facing lender surface: while the
 * lender's portal is switched off (TenantConfig.featurePortal) both of its
 * endpoints refuse a live link, before any document read or acknowledgement.
 */
const h = vi.hoisted(() => ({
  portalEnabled: true,
  resolve: vi.fn(),
  record: vi.fn(),
  documentFindFirst: vi.fn(),
}))

vi.mock("@/lib/compliance/pasq-link-token.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/compliance/pasq-link-token.server")>()),
  resolvePasqLinkToken: (...a: unknown[]) => h.resolve(...a),
}))
vi.mock("@/lib/compliance/pasq-acknowledgement.server", () => ({ recordPasqAcknowledgement: (...a: unknown[]) => h.record(...a) }))
vi.mock("@/lib/prisma", () => ({ prisma: { clientDocument: { findFirst: (...a: unknown[]) => h.documentFindFirst(...a) } } }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => ({ allowed: true }), callerIp: () => "203.0.113.9" }))
vi.mock("@/lib/portal/portal-policy", async (orig) => {
  const real = await orig<typeof import("@/lib/portal/portal-policy")>()
  return { ...real, portalOffRefusal: async () => (h.portalEnabled ? null : real.portalUnavailableResponse()) }
})

import { POST as acknowledge } from "./acknowledge/route"
import { GET as document } from "./document/route"

const LIVE = {
  ok: true,
  link: {
    tokenId: "tok1", tenantId: "t1", applicationId: "app1", clientId: "c1", clientEmail: "c@example.invalid",
    documentId: "doc1", documentSha256: "a".repeat(64),
  },
}
const ctx = { params: Promise.resolve({ token: "t" }) }

beforeEach(() => {
  h.portalEnabled = false
  h.resolve.mockReset().mockResolvedValue(LIVE)
  h.record.mockReset()
  h.documentFindFirst.mockReset()
})

describe("PASQ link while the lender's portal is off", () => {
  it("refuses the acknowledgement and records nothing", async () => {
    const res = await acknowledge(new NextRequest("http://x/api/pasq-link/t/acknowledge", { method: "POST" }), ctx)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(expect.objectContaining({ portal: "disabled" }))
    expect(h.record).not.toHaveBeenCalled()
  })

  it("refuses the document and reads nothing", async () => {
    const res = await document(new NextRequest("http://x/api/pasq-link/t/document"), ctx)
    expect(res.status).toBe(404)
    expect(h.documentFindFirst).not.toHaveBeenCalled()
  })
})
