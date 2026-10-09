/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const findUniqueMock = vi.fn()
const upsertMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (r: string) => requireApiRoleMock(r) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: { emailConfig: { findUnique: (...a: any[]) => findUniqueMock(...a), upsert: (...a: any[]) => upsertMock(...a) } },
}))
vi.mock("@/lib/config/identity", () => ({ getLenderBrandName: async () => "Acme Lending" }))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(), AuditAction: { EMAIL_CONFIG_UPDATED: "EMAIL_CONFIG_UPDATED" } }))

import { GET, POST } from "./route"
import { isSealed, openSecret } from "@/lib/crypto/secret-box"

const KEY = Buffer.alloc(32, 9).toString("base64")
const MASK = "••••••••"

function post(body: Record<string, unknown>) {
  return POST(
    new NextRequest("http://localhost/api/email/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
}

const validBody = {
  provider: "IMAP_SMTP",
  fromName: "Acme Lending",
  fromAddress: "noreply@acme-lending.example",
  smtpHost: "smtp.mailtrap.io",
  smtpUser: "u",
  smtpPass: "smtp-pw",
  imapHost: "imap.mailtrap.io",
  imapUser: "u",
  imapPass: "imap-pw",
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "admin@acme-lending.example" } })
  findUniqueMock.mockResolvedValue(null)
  upsertMock.mockImplementation(({ create }: any) => Promise.resolve({ id: "c1", tenantId: "t1", ...create }))
  process.env.EMAIL_DELIVERY_MODE = "unrestricted"
  process.env.WABA_ENC_KEY = KEY
})
afterEach(() => {
  delete process.env.EMAIL_DELIVERY_MODE
  delete process.env.EMAIL_INBOUND_ALLOWED_HOSTS
  delete process.env.WABA_ENC_KEY
})

describe("GET /api/email/config", () => {
  it("masks every secret — never returns a sealed or plaintext value", async () => {
    const { sealSecret } = await import("@/lib/crypto/secret-box")
    findUniqueMock.mockResolvedValue({
      tenantId: "t1",
      smtpPass: sealSecret("smtp-pw", KEY),
      imapPass: "legacy-plaintext",
      clientSecret: sealSecret("cs", KEY),
      fromAddress: "noreply@acme-lending.example",
    })
    const body = await (await GET(new NextRequest("http://localhost/api/email/config"))).json()
    expect(body.smtpPass).toBe(MASK)
    expect(body.imapPass).toBe(MASK)
    expect(body.clientSecret).toBe(MASK)
    expect(JSON.stringify(body)).not.toContain("enc:v1:")
    expect(JSON.stringify(body)).not.toContain("legacy-plaintext")
  })

  it("is ADMIN-only", async () => {
    requireApiRoleMock.mockResolvedValue({ error: new Response("no", { status: 403 }) })
    expect((await GET(new NextRequest("http://localhost/api/email/config"))).status).toBe(403)
  })
})

describe("POST /api/email/config — secrets at rest", () => {
  it("seals smtpPass, imapPass and clientSecret before they reach the DB", async () => {
    await post({ ...validBody, clientSecret: "cs" })
    const created = upsertMock.mock.calls[0][0].create
    expect(isSealed(created.smtpPass)).toBe(true)
    expect(isSealed(created.imapPass)).toBe(true)
    expect(isSealed(created.clientSecret)).toBe(true)
    expect(openSecret(created.smtpPass, KEY)).toBe("smtp-pw")
    expect(openSecret(created.imapPass, KEY)).toBe("imap-pw")
  })

  it("never returns the stored secret to the client", async () => {
    const res = await post(validBody)
    const body = await res.json()
    expect(body.smtpPass).toBe(MASK)
    expect(JSON.stringify(body)).not.toContain("enc:v1:")
  })

  it("the placeholder PRESERVES the existing sealed value and does not double-seal it", async () => {
    const { sealSecret } = await import("@/lib/crypto/secret-box")
    const stored = sealSecret("existing-pw", KEY)
    findUniqueMock.mockResolvedValue({ tenantId: "t1", smtpPass: stored, imapPass: stored, clientSecret: null })
    await post({ ...validBody, smtpPass: MASK, imapPass: MASK })
    const update = upsertMock.mock.calls[0][0].update
    expect(update.smtpPass).toBe(stored)
    expect(openSecret(update.smtpPass, KEY)).toBe("existing-pw")
  })

  it("FAILS CLOSED with no key — refuses to store a plaintext secret", async () => {
    delete process.env.WABA_ENC_KEY
    const res = await post(validBody)
    expect(res.status).toBe(500)
    expect(upsertMock).not.toHaveBeenCalled()
  })
})

describe("POST /api/email/config — inbound host allowlist", () => {
  it("refuses to SAVE an imapHost outside the allowlist in restricted mode", async () => {
    delete process.env.EMAIL_DELIVERY_MODE
    process.env.EMAIL_INBOUND_ALLOWED_HOSTS = "imap.mailtrap.io"
    const res = await post({ ...validBody, imapHost: "mail.acme-lending.example" })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("EMAIL_INBOUND_ALLOWED_HOSTS")
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it("allows any imapHost in unrestricted mode — production is unaffected", async () => {
    const res = await post({ ...validBody, imapHost: "mail.acme-lending.example" })
    expect(res.status).toBe(200)
    expect(upsertMock).toHaveBeenCalled()
  })

  it("allows an empty imapHost (IMAP simply not configured)", async () => {
    delete process.env.EMAIL_DELIVERY_MODE
    process.env.EMAIL_INBOUND_ALLOWED_HOSTS = "imap.mailtrap.io"
    const res = await post({ ...validBody, imapHost: "" })
    expect(res.status).toBe(200)
  })
})

describe("POST /api/email/config — audit", () => {
  it("writes an audit row for the config change", async () => {
    const { logAudit } = await import("@/lib/audit")
    await post(validBody)
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "EMAIL_CONFIG_UPDATED", tenantId: "t1" }))
  })
})
