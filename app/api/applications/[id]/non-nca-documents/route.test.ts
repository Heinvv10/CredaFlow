import { NextRequest, NextResponse } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  requireApiRole: vi.fn(), requireOwnerOrStaff: vi.fn(), issue: vi.fn(), ack: vi.fn(), sign: vi.fn(), findFirst: vi.fn(), state: vi.fn(),
}))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: m.requireApiRole, requireOwnerOrStaff: m.requireOwnerOrStaff }))
vi.mock("@/lib/prisma", () => ({ prisma: { loanApplication: { findFirst: m.findFirst } } }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: async (_req: unknown, run: (t: { id: string }) => Promise<Response>) => run({ id: "t1" }) }))
vi.mock("@/lib/rate-limit", () => ({ recordedCallerIp: () => "203.0.113.7" }))
vi.mock("@/lib/non-nca-documents/issue", () => ({ issueLoanDocuments: m.issue }))
vi.mock("@/lib/non-nca-documents/acknowledge", () => ({ acknowledgeKeyFacts: m.ack }))
vi.mock("@/lib/non-nca-documents/sign", () => ({ signKeyFactsAgreement: m.sign }))
vi.mock("@/lib/non-nca-documents/state", () => ({ loanDocumentState: m.state }))

import { GET, POST } from "./route"
import { POST as ACK } from "./acknowledge/route"
import { POST as SIGN } from "./sign/route"
import { MissingTokenError, TemplateUnavailableError } from "@/lib/documents/render"

const ctx = { params: Promise.resolve({ id: "a1" }) }
const req = (body?: unknown) => new NextRequest("http://localhost/api/applications/a1/non-nca-documents", { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) })
const SHA = "a".repeat(64)
const client = { type: "client", clientId: "c1", clientEmail: "c1@client.invalid" }

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.requireApiRole.mockResolvedValue({ user: { id: "u1", email: "officer@test.invalid" } })
  m.requireOwnerOrStaff.mockResolvedValue(client)
  m.findFirst.mockResolvedValue({ clientId: "c1" })
})

describe("POST issue (staff)", () => {
  it("is a credit officer's action: below that role nothing is issued", async () => {
    m.requireApiRole.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
    expect((await POST(req(), ctx)).status).toBe(403)
    expect(m.issue).not.toHaveBeenCalled()
    expect(m.requireApiRole).toHaveBeenCalledWith("CREDIT_OFFICER")
  })

  it("issues and answers 201; a library refusal keeps its status", async () => {
    m.issue.mockResolvedValue({ ok: true, issued: [{ kind: "KEY_FACTS_STATEMENT" }] })
    expect((await POST(req(), ctx)).status).toBe(201)
    expect(m.issue).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", applicationId: "a1", staff: { id: "u1", email: "officer@test.invalid" }, ipAddress: "203.0.113.7" }))
    m.issue.mockResolvedValue({ ok: false, status: 409, error: "Loan documents are issued for an approved application" })
    expect((await POST(req(), ctx)).status).toBe(409)
  })

  it("answers an unavailable template with 409 and an unresolved token with 422", async () => {
    m.issue.mockRejectedValue(new TemplateUnavailableError("non_nca_key_facts"))
    const unavailable = await POST(req(), ctx)
    expect(unavailable.status).toBe(409)
    expect((await unavailable.json()).error).toMatch(/legal team publishes it/)
    m.issue.mockRejectedValue(new MissingTokenError(["tenant.ncrNumber"]))
    const missing = await POST(req(), ctx)
    expect(missing.status).toBe(422)
    expect((await missing.json()).missing).toEqual(["tenant.ncrNumber"])
  })
})

describe("GET state", () => {
  it("is for the application's borrower or staff, and 409 for a PASQ application", async () => {
    m.state.mockResolvedValue({ keyFacts: { documents: [] } })
    expect((await GET(req(), ctx)).status).toBe(200)
    m.state.mockResolvedValue({ keyFacts: null })
    expect((await GET(req(), ctx)).status).toBe(409)
    m.requireOwnerOrStaff.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
    expect((await GET(req(), ctx)).status).toBe(403)
  })
})

describe("POST acknowledge and sign (the borrower only)", () => {
  it("acknowledge: a bad digest is 400, staff are 403, the borrower is recorded", async () => {
    expect((await ACK(req({ documentSha256: "nope" }), ctx)).status).toBe(400)
    m.requireOwnerOrStaff.mockResolvedValue({ type: "staff", user: { id: "u1" } })
    expect((await ACK(req({ documentSha256: SHA }), ctx)).status).toBe(403)
    expect(m.ack).not.toHaveBeenCalled()
    m.requireOwnerOrStaff.mockResolvedValue(client)
    m.ack.mockResolvedValue({ ok: true, acknowledgedAt: new Date() })
    expect((await ACK(req({ documentSha256: SHA }), ctx)).status).toBe(200)
    expect(m.ack).toHaveBeenCalledWith({ tenantId: "t1", applicationId: "a1", clientId: "c1", clientEmail: "c1@client.invalid", shown: SHA, ipAddress: "203.0.113.7" })
  })

  it("sign: staff are 403; the borrower signs over the digest they were shown; an OTP refusal is passed on", async () => {
    m.requireOwnerOrStaff.mockResolvedValue({ type: "staff", user: { id: "u1" } })
    expect((await SIGN(req({ agreementDocumentSha256: SHA, signature: "A B" }), ctx)).status).toBe(403)
    m.requireOwnerOrStaff.mockResolvedValue(client)
    m.sign.mockResolvedValue({ ok: true, signedAt: new Date() })
    expect((await SIGN(req({ agreementDocumentSha256: SHA, signature: "A B", signingOtpChallengeId: "ch1" }), ctx)).status).toBe(200)
    expect(m.sign).toHaveBeenCalledWith(expect.objectContaining({ clientId: "c1", agreementDocumentSha256: SHA, signature: "A B", signingOtpChallengeId: "ch1", ipAddress: "203.0.113.7" }))
    m.sign.mockResolvedValue({ ok: false, status: 409, error: "Verify the one-time code before signing", signingOtp: "required" })
    const refused = await SIGN(req({ agreementDocumentSha256: SHA, signature: "A B" }), ctx)
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ signingOtp: "required" })
  })
})
