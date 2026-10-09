import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { signUnsubToken } from "@/lib/unsubscribe/token"

const tenantFindUnique = vi.fn()
const transactionMock = vi.fn()
const logAuditMock = vi.fn()
const updateManyMock = vi.fn()
const createConsentMock = vi.fn()
const queryRawUnsafeMock = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: (args: unknown) => tenantFindUnique(args) },
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => transactionMock(cb),
  },
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => logAuditMock(...args),
}))

import { GET, POST } from "./route"

const SECRET = "test-unsub-secret"
const FUTURE_EXP = Date.now() + 90 * 24 * 60 * 60 * 1000
const validPayload = { contactId: "ct_abc", channel: "EMAIL" as const, purpose: "MARKETING_GENERAL" as const, exp: FUTURE_EXP }

function txClient() {
  return {
    $queryRawUnsafe: (...args: unknown[]) => queryRawUnsafeMock(...args),
    contactConsent: {
      updateMany: (...args: unknown[]) => updateManyMock(...args),
      create: (...args: unknown[]) => createConsentMock(...args),
    },
  }
}

describe("POST /api/messaging/unsubscribe (RFC 8058 one-click)", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.UNSUB_TOKEN_SECRET = SECRET
    process.env.NEXT_PUBLIC_TENANT_SLUG = "acme"
    tenantFindUnique.mockResolvedValue({ id: "tenant_acme", slug: "acme" })
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(txClient()))
    updateManyMock.mockResolvedValue({ count: 1 })
    createConsentMock.mockResolvedValue({ id: "csn_new" })
    queryRawUnsafeMock.mockResolvedValue([{ id: "ct_abc" }])
  })

  it("valid token: 200 + REVOKED row + audit", async () => {
    const token = signUnsubToken(validPayload, SECRET)
    const req = new NextRequest("https://app.acme-lending.example/api/messaging/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `uns=${encodeURIComponent(token)}&List-Unsubscribe=One-Click`,
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { contactId: "ct_abc", channel: "EMAIL", purpose: "MARKETING_GENERAL", effectiveTo: null },
      data: { effectiveTo: expect.any(Date) },
    })
    expect(queryRawUnsafeMock).toHaveBeenCalledWith(
      expect.stringMatching(/FROM "Contact"[\s\S]*FOR UPDATE/),
      "ct_abc",
      "tenant_acme",
    )
    expect(queryRawUnsafeMock.mock.invocationCallOrder[0]).toBeLessThan(
      createConsentMock.mock.invocationCallOrder[0],
    )
    expect(createConsentMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant_acme",
        contactId: "ct_abc",
        channel: "EMAIL",
        purpose: "MARKETING_GENERAL",
        status: "REVOKED",
        source: "EMAIL_LIST_UNSUBSCRIBE",
      }),
    })
    expect(logAuditMock).toHaveBeenCalledTimes(1)
    expect(logAuditMock.mock.calls[0][0]).toMatchObject({
      action: "CONSENT_REVOKED_VIA_UNSUBSCRIBE",
      entity: "ContactConsent",
      entityId: "csn_new",
    })
  })

  it("tampered token: 400 + no DB writes", async () => {
    const token = signUnsubToken(validPayload, "wrong-secret")
    const req = new NextRequest("https://app.acme-lending.example/api/messaging/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `uns=${encodeURIComponent(token)}`,
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    expect(transactionMock).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("expired token: 400 + no DB writes", async () => {
    const token = signUnsubToken({ ...validPayload, exp: Date.now() - 1000 }, SECRET)
    const req = new NextRequest("https://app.acme-lending.example/api/messaging/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `uns=${encodeURIComponent(token)}`,
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("missing uns field: 400", async () => {
    const req = new NextRequest("https://app.acme-lending.example/api/messaging/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it("missing UNSUB_TOKEN_SECRET: 500", async () => {
    delete process.env.UNSUB_TOKEN_SECRET
    const token = signUnsubToken(validPayload, SECRET)
    const req = new NextRequest("https://app.acme-lending.example/api/messaging/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `uns=${encodeURIComponent(token)}`,
    })
    const res = await POST(req)
    expect(res.status).toBe(500)
  })

  it("idempotent re-click: 200 even when no rows are updated", async () => {
    updateManyMock.mockResolvedValue({ count: 0 })
    const token = signUnsubToken(validPayload, SECRET)
    const req = new NextRequest("https://app.acme-lending.example/api/messaging/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `uns=${encodeURIComponent(token)}`,
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    // A new REVOKED row is still inserted — the append-only model means each
    // revoke click writes a new row even when the previous click already
    // closed the prior open consent. That's the audit trail.
    expect(createConsentMock).toHaveBeenCalledTimes(1)
  })
})

describe("GET /api/messaging/unsubscribe", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.UNSUB_TOKEN_SECRET = SECRET
    process.env.NEXT_PUBLIC_TENANT_SLUG = "acme"
    tenantFindUnique.mockResolvedValue({ id: "tenant_acme", slug: "acme" })
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(txClient()))
    updateManyMock.mockResolvedValue({ count: 1 })
    createConsentMock.mockResolvedValue({ id: "csn_new" })
    queryRawUnsafeMock.mockResolvedValue([{ id: "ct_abc" }])
  })

  it("valid token: 200 + HTML body + REVOKED row + audit", async () => {
    const token = signUnsubToken(validPayload, SECRET)
    const req = new NextRequest(`https://app.acme-lending.example/api/messaging/unsubscribe?uns=${encodeURIComponent(token)}`)
    const res = await GET(req)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toMatch(/text\/html/)
    const body = await res.text()
    expect(body).toContain("unsubscribed")
    expect(createConsentMock).toHaveBeenCalledTimes(1)
    expect(logAuditMock).toHaveBeenCalledTimes(1)
  })

  it("bad token: 400 HTML error page", async () => {
    const req = new NextRequest("https://app.acme-lending.example/api/messaging/unsubscribe?uns=invalid")
    const res = await GET(req)
    expect(res.status).toBe(400)
    expect(res.headers.get("content-type")).toMatch(/text\/html/)
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("missing uns query param: 400", async () => {
    const req = new NextRequest("https://app.acme-lending.example/api/messaging/unsubscribe")
    const res = await GET(req)
    expect(res.status).toBe(400)
  })
})
