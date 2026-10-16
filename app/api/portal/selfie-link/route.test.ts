import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ auth: vi.fn(), findFirst: vi.fn(), mint: vi.fn(), logAudit: vi.fn(), live: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: h.auth }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, callback: (tenant: { id: string }) => unknown) => callback({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: { findFirst: h.findFirst },
    $transaction: (fn: (tx: unknown) => unknown) => fn({ selfieCaptureToken: { findMany: h.live } }),
  },
}))
vi.mock("@/lib/kyc/selfie-link-token.server", () => ({ mintSelfieLinkToken: h.mint }))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAudit: h.logAudit,
}))

import { POST } from "./route"

const SECRET = "s".repeat(43)
let n = 0
// Each test its own client id: the route rate-limits per client.
const post = () => POST(new NextRequest("https://portal.example.test/api/portal/selfie-link", { method: "POST" }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("PORTAL_PUBLIC_ORIGIN", "https://portal.example.test")
  n += 1
  h.auth.mockResolvedValue({ user: { id: `client-${n}`, email: "c@example.test", role: "CLIENT", tenantId: "tenant-1" } })
  h.findFirst.mockResolvedValue({ id: "app-1", clientId: `client-${n}` })
  h.live.mockResolvedValue([])
  h.mint.mockResolvedValue({ id: "tok-1", secret: SECRET, tokenHash: "h", expiresAt: new Date("2026-10-17T10:00:00Z") })
})

// Fair Score audit 2026-10-16: a desktop with no camera had no way forward.
describe("POST /api/portal/selfie-link", () => {
  it("mints a PORTAL capture link for the client's own application, with no staff issuer, and returns it with a QR", async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(h.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1", clientId: `client-${n}`, status: { in: ["SUBMITTED", "UNDER_REVIEW", "APPROVED"] } },
    }))
    expect(h.mint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tenantId: "tenant-1", applicationId: "app-1", clientId: `client-${n}`, channel: "PORTAL", createdById: null,
    }))
    const body = await res.json() as { url: string; qr: string }
    expect(body.url).toBe(`https://portal.example.test/selfie/${SECRET}`)
    expect(body.qr).toMatch(/^data:image\/png;base64,/)
  })

  it("audits the hand-off without the secret", async () => {
    await post()
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "SELFIE_LINK_PORTAL_HANDOFF", entityId: "app-1" }))
    expect(JSON.stringify(h.logAudit.mock.calls[0][0])).not.toContain(SECRET)
  })

  it("audits the cancellation of a link staff sent earlier, and tells the client", async () => {
    h.live.mockResolvedValue([{ id: "tok-staff", channel: "WHATSAPP" }])
    const res = await post()
    expect((await res.json() as { replacedEarlierLink: boolean }).replacedEarlierLink).toBe(true)
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "SELFIE_LINK_INVALIDATED", entityId: "app-1",
      newValue: expect.objectContaining({ tokenIds: ["tok-staff"], channels: ["WHATSAPP"], replacedBy: "tok-1" }),
    }))
  })

  it("audits no cancellation when there was no earlier link", async () => {
    const res = await post()
    expect((await res.json() as { replacedEarlierLink: boolean }).replacedEarlierLink).toBe(false)
    expect(h.logAudit).toHaveBeenCalledTimes(1)
  })

  // The lookup is the only binding between the session and the application:
  // emulate it over two clients' applications in the same tenant and another
  // tenant's, and check the token can only ever name the caller's own.
  it("never mints a link for another client's application, or another tenant's", async () => {
    const apps = [
      { id: "app-other-client", tenantId: "tenant-1", clientId: "someone-else", status: "UNDER_REVIEW" },
      { id: "app-other-tenant", tenantId: "tenant-2", clientId: `client-${n}`, status: "UNDER_REVIEW" },
    ]
    h.findFirst.mockImplementation(async ({ where }: { where: { tenantId: string; clientId: string; status: { in: string[] } } }) =>
      apps.find((a) => a.tenantId === where.tenantId && a.clientId === where.clientId && where.status.in.includes(a.status)) ?? null)
    expect((await post()).status).toBe(409)
    expect(h.mint).not.toHaveBeenCalled()

    apps.push({ id: "app-own", tenantId: "tenant-1", clientId: `client-${n}`, status: "SUBMITTED" })
    expect((await post()).status).toBe(200)
    expect(h.mint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ applicationId: "app-own", clientId: `client-${n}`, tenantId: "tenant-1" }))
  })

  it("refuses staff and anonymous callers", async () => {
    h.auth.mockResolvedValue(null)
    expect((await post()).status).toBe(401)
    h.auth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", tenantId: "tenant-1" } })
    expect((await post()).status).toBe(403)
    expect(h.mint).not.toHaveBeenCalled()
  })

  it("409s when no application awaits a photo", async () => {
    h.findFirst.mockResolvedValue(null)
    expect((await post()).status).toBe(409)
    expect(h.mint).not.toHaveBeenCalled()
  })

  it("rate-limits a client", async () => {
    for (let i = 0; i < 5; i++) expect((await post()).status).toBe(200)
    expect((await post()).status).toBe(429)
  })
})
