import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  totpRequired: true,
  findUnique: vi.fn(),
  save: vi.fn(),
  sendTest: vi.fn(),
  logAudit: vi.fn(),
  rate: true,
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/security/loan-book-guard", () => ({ refusesLoanBook: async () => false }))
vi.mock("@/lib/audit/security-events", () => ({ recordSecurityEvent: async () => undefined }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => Promise<Response>) => fn({ id: "t1" }) }))
vi.mock("@/lib/rate-limit", () => ({ callerIp: () => "10.0.0.9", checkRateLimit: () => ({ allowed: h.rate }) }))
vi.mock("@/lib/audit", () => ({ AuditAction: { AUDIT_SIEM_TEST_SENT: "AUDIT_SIEM_TEST_SENT" }, logAudit: (...a: unknown[]) => h.logAudit(...a) }))
vi.mock("@/lib/security/staff-totp-policy", () => ({ isStaffTotpRequired: async () => h.totpRequired }))
vi.mock("@/lib/prisma", () => ({ prisma: { auditPolicy: { findUnique: (...a: unknown[]) => h.findUnique(...a) } } }))
vi.mock("@/lib/audit/siem/deliver", () => ({ sendTestEvent: (...a: unknown[]) => h.sendTest(...a) }))
vi.mock("@/lib/audit/siem/policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit/siem/policy")>()),
  saveAuditPolicy: (...a: unknown[]) => h.save(...a),
  siemTarget: () => ({ transport: "HTTPS_JSON" }),
}))

import { GET, POST, PUT } from "./route"
import { AuditPolicyError } from "@/lib/audit/siem/policy"

const caller = (role: string, extra: Record<string, unknown> = {}) => ({
  user: { id: "admin-1", email: "admin@lender.example", name: "A", role, tenantId: "t1", totpVerified: true, tokenVersion: 0, ...extra },
})
const req = (method: string, body?: unknown) => new NextRequest("http://localhost/api/settings/audit-policy", {
  method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

beforeEach(() => {
  h.session = caller("SUPER_ADMIN")
  h.totpRequired = true
  h.findUnique.mockReset().mockResolvedValue(null)
  h.save.mockReset().mockResolvedValue({ retentionMonths: 24 })
  h.sendTest.mockReset().mockResolvedValue({ ok: true, error: null })
  h.logAudit.mockReset()
  h.rate = true
})

describe("/api/settings/audit-policy", () => {
  it("is for SUPER_ADMIN only: an admin, a credit officer and a signed-out caller are refused", async () => {
    for (const role of ["ADMIN", "CREDIT_OFFICER"]) {
      h.session = caller(role)
      expect((await GET(req("GET"))).status, role).toBe(403)
      expect((await PUT(req("PUT", { retentionMonths: 24 }))).status, role).toBe(403)
      expect((await POST(req("POST"))).status, role).toBe(403)
    }
    h.session = null
    expect((await GET(req("GET"))).status).toBe(401)
    expect(h.save).not.toHaveBeenCalled()
  })

  it("shows the SIEM URL as its origin only: a path or query (which may carry a key) is never returned", async () => {
    h.findUnique.mockResolvedValue({
      id: "p1", tenantId: "t1", retentionMonths: 12, hotMonths: 3, siemEnabled: true, siemTransport: "HTTPS_JSON", siemHost: null, siemPort: null,
      siemUrl: "https://siem.example.invalid/ingest/KEY123?token=abc", siemSealedToken: "enc:v1:x", siemCaCertPem: null, siemClientCert: null, siemSealedKey: null,
    })
    const body = await (await GET(req("GET"))).json()
    expect(body).toMatchObject({ siemOrigin: "https://siem.example.invalid", siemUrlHasPathOrQuery: true, siemTokenSet: true })
    expect(JSON.stringify(body)).not.toMatch(/KEY123|token=abc|siemUrl"|enc:v1/)
  })

  it("reads the default policy when the lender has none, with no secrets", async () => {
    const res = await GET(req("GET"))
    expect(await res.json()).toMatchObject({ retentionMonths: 12, hotMonths: 3, siemEnabled: false, siemTokenSet: false })
  })

  it("saves through saveAuditPolicy as the caller, with the caller's address", async () => {
    const res = await PUT(req("PUT", { retentionMonths: 24 }))
    expect(res.status).toBe(200)
    expect(h.save).toHaveBeenCalledWith("t1", { id: "admin-1", email: "admin@lender.example" }, { retentionMonths: 24 }, { ipAddress: "10.0.0.9" })
  })

  it("answers 422 with the reason when the input is refused", async () => {
    h.save.mockRejectedValue(new AuditPolicyError("retentionMonths must be a whole number from 12 to 600."))
    const res = await PUT(req("PUT", { retentionMonths: 6 }))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: "retentionMonths must be a whole number from 12 to 600." })
  })

  it("needs a session that verified TOTP where the lender requires it, and refuses a non-object body", async () => {
    h.session = caller("SUPER_ADMIN", { totpVerified: false })
    expect((await PUT(req("PUT", { retentionMonths: 24 }))).status).toBe(403)
    h.totpRequired = false
    expect((await PUT(req("PUT", { retentionMonths: 24 }))).status).toBe(200)
    expect((await PUT(req("PUT", [1]))).status).toBe(400)
  })

  it("sends a test event only while forwarding is enabled, audits it, and answers a coarse class only", async () => {
    expect((await POST(req("POST"))).status).toBe(409)
    h.findUnique.mockResolvedValue({ id: "pol-1", siemEnabled: true })
    expect((await POST(req("POST"))).status).toBe(200)
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "AUDIT_SIEM_TEST_SENT", tenantId: "t1", userId: "admin-1", newValue: { ok: true, error: null } }))
    h.sendTest.mockResolvedValue({ ok: false, error: "siem_unavailable" })
    const res = await POST(req("POST"))
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ ok: false, error: "siem_unavailable" })
  })

  it("gates the test like a change: TOTP where required, and rate-limited", async () => {
    h.findUnique.mockResolvedValue({ id: "pol-1", siemEnabled: true })
    h.session = caller("SUPER_ADMIN", { totpVerified: false })
    expect((await POST(req("POST"))).status).toBe(403)
    h.session = caller("SUPER_ADMIN")
    h.rate = false
    expect((await POST(req("POST"))).status).toBe(429)
    expect(h.sendTest).not.toHaveBeenCalled()
  })
})
