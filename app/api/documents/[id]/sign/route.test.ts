import { afterEach, describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const {
  getDocumentCaller,
  findFirstClientDocument,
  updateClientDocument,
  createDocumentAccessLog,
  logAudit,
  tenantConfigFindUnique,
  otpFindFirst,
  otpUpdateMany,
} = vi.hoisted(() => ({
  tenantConfigFindUnique: vi.fn(),
  otpFindFirst: vi.fn(),
  otpUpdateMany: vi.fn(),
  getDocumentCaller: vi.fn(),
  findFirstClientDocument: vi.fn(),
  updateClientDocument: vi.fn(),
  createDocumentAccessLog: vi.fn(),
  logAudit: vi.fn(),
}))

vi.mock("@/lib/document-auth", () => ({ getDocumentCaller }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }),
}))
vi.mock("@/lib/prisma", () => {
  const signingOtpChallenge = { findFirst: otpFindFirst, findFirstOrThrow: otpFindFirst, updateMany: otpUpdateMany }
  // updateClientDocument is the guarded claim (updateMany); the signed row is read back.
  const tx = {
    clientDocument: {
      updateMany: updateClientDocument,
      findFirstOrThrow: async () => ({ id: "doc1", tenantId: "t1", clientId: "client-1", signatureState: "signed" }),
    },
    signingOtpChallenge,
  }
  return {
    prisma: {
      clientDocument: { findFirst: findFirstClientDocument, update: updateClientDocument },
      documentAccessLog: { create: createDocumentAccessLog },
      tenantConfig: { findUnique: tenantConfigFindUnique },
      signingOtpChallenge,
      $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  }
})
vi.mock("@/lib/audit", () => ({
  logAudit,
  AuditAction: { DOCUMENT_SIGNED: "DOCUMENT_SIGNED" },
}))

import { POST } from "./route"

function req(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://x/api/documents/doc1/sign", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

function ctx() {
  return { params: Promise.resolve({ id: "doc1" }) }
}

const PENDING_DOC = {
  id: "doc1",
  tenantId: "t1",
  clientId: "client-1",
  deletedAt: null,
  signatureState: "pending",
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("TRUSTED_PROXY", "1")
  findFirstClientDocument.mockResolvedValue(PENDING_DOC)
  updateClientDocument.mockResolvedValue({ count: 1 })
  createDocumentAccessLog.mockResolvedValue({})
  logAudit.mockResolvedValue(undefined)
  // The signing-OTP gate has its own describe block; off for the rest.
  tenantConfigFindUnique.mockResolvedValue({ requireSigningOtp: false, signingOtpBranchExempt: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("POST /api/documents/[id]/sign", () => {
  it("returns 401 when unauthenticated", async () => {
    getDocumentCaller.mockResolvedValue(null)

    const res = await POST(req({ method: "branch" }), ctx())

    expect(res.status).toBe(401)
    expect(findFirstClientDocument).not.toHaveBeenCalled()
  })

  it("400s when method is missing/invalid", async () => {
    getDocumentCaller.mockResolvedValue({ type: "staff", userId: "u1", role: "LOAN_ADMIN", tenantId: "t1" })

    const res = await POST(req({}), ctx())

    expect(res.status).toBe(400)
    expect(findFirstClientDocument).not.toHaveBeenCalled()
    expect(updateClientDocument).not.toHaveBeenCalled()
  })

  it("staff signs successfully: 200, stamps signed + IP + audit + access log", async () => {
    getDocumentCaller.mockResolvedValue({ type: "staff", userId: "u1", role: "LOAN_ADMIN", tenantId: "t1" })

    const res = await POST(
      req({ method: "branch" }, { "x-forwarded-for": "41.1.2.3, 10.0.0.1" }),
      ctx()
    )

    expect(res.status).toBe(200)

    expect(updateClientDocument).toHaveBeenCalledWith({
      where: {
        id: "doc1",
        tenantId: "t1",
        deletedAt: null,
        contentSha256: undefined,
        OR: [{ signatureState: null }, { signatureState: { not: "signed" } }],
      },
      data: expect.objectContaining({
        signatureState: "signed",
        signedAt: expect.any(Date),
        signedByIp: "10.0.0.1",
      }),
    })

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        userId: "u1",
        action: "DOCUMENT_SIGNED",
        entity: "ClientDocument",
        entityId: "doc1",
        ipAddress: "10.0.0.1",
      })
    )

    expect(createDocumentAccessLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        documentId: "doc1",
        accessorType: "staff",
        accessorId: "u1",
        action: "signed",
        ipAddress: "10.0.0.1",
      }),
    })
  })

  it("409s when the document is already signed, without mutating", async () => {
    getDocumentCaller.mockResolvedValue({ type: "staff", userId: "u1", role: "LOAN_ADMIN", tenantId: "t1" })
    findFirstClientDocument.mockResolvedValue({ ...PENDING_DOC, signatureState: "signed" })

    const res = await POST(req({ method: "branch" }), ctx())

    expect(res.status).toBe(409)
    expect(updateClientDocument).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
    expect(createDocumentAccessLog).not.toHaveBeenCalled()
  })

  it("rejects the generic signing path for a credit agreement", async () => {
    getDocumentCaller.mockResolvedValue({ type: "client", clientId: "client-1", email: "x@y.com" })
    findFirstClientDocument.mockResolvedValue({
      ...PENDING_DOC,
      docType: "CREDIT_AGREEMENT",
    })

    const res = await POST(req({ method: "portal" }), ctx())

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual(expect.objectContaining({
      agreementIntegrity: "dedicated_signing_required",
    }))
    expect(updateClientDocument).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
    expect(createDocumentAccessLog).not.toHaveBeenCalled()
  })

  it("404s when the document doesn't exist", async () => {
    getDocumentCaller.mockResolvedValue({ type: "staff", userId: "u1", role: "LOAN_ADMIN", tenantId: "t1" })
    findFirstClientDocument.mockResolvedValue(null)

    const res = await POST(req({ method: "branch" }), ctx())

    expect(res.status).toBe(404)
    expect(updateClientDocument).not.toHaveBeenCalled()
  })

  it("403s when a CLIENT session tries to sign another client's document, without mutating", async () => {
    getDocumentCaller.mockResolvedValue({ type: "client", clientId: "someone-else", email: "x@y.com" })

    const res = await POST(req({ method: "portal" }), ctx())

    expect(res.status).toBe(403)
    expect(updateClientDocument).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
    expect(createDocumentAccessLog).not.toHaveBeenCalled()
  })

  it("allows a CLIENT session to sign their OWN document", async () => {
    getDocumentCaller.mockResolvedValue({ type: "client", clientId: "client-1", email: "x@y.com" })

    const res = await POST(req({ method: "portal" }), ctx())

    expect(res.status).toBe(200)
    expect(updateClientDocument).toHaveBeenCalled()
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: undefined, userEmail: "x@y.com" })
    )
    expect(createDocumentAccessLog).toHaveBeenCalledWith({
      data: expect.objectContaining({ accessorType: "client", accessorId: "client-1" }),
    })
  })
})

describe("POST /api/documents/[id]/sign — signing OTP gate", () => {
  const DIGEST = "c".repeat(64)
  const now = Date.now()
  const verified = {
    id: "otp-1", tenantId: "t1", clientId: "client-1", purpose: "DOCUMENT", subjectId: "doc1",
    documentSha256: DIGEST, channel: "WHATSAPP", maskedDestination: "+27 *** *** 4567",
    deliveryStatus: "ACCEPTED", sentAt: new Date(now - 60_000), expiresAt: new Date(now + 240_000),
    attempts: 2, maxAttempts: 5, verifiedAt: new Date(now - 30_000), consumedAt: null,
  }
  const client = { type: "client", clientId: "client-1", email: "x@y.com" }

  beforeEach(() => {
    tenantConfigFindUnique.mockResolvedValue({ requireSigningOtp: true, signingOtpBranchExempt: true })
    findFirstClientDocument.mockResolvedValue({ ...PENDING_DOC, contentSha256: DIGEST })
    otpFindFirst.mockResolvedValue(verified)
    otpUpdateMany.mockResolvedValue({ count: 1 })
  })

  it("refuses a portal signature without a code and changes nothing", async () => {
    getDocumentCaller.mockResolvedValue(client)

    const res = await POST(req({ method: "portal" }), ctx())

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual(expect.objectContaining({ signingOtp: "required" }))
    expect(updateClientDocument).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("does not let a CLIENT session claim the branch exemption", async () => {
    getDocumentCaller.mockResolvedValue(client)

    const res = await POST(req({ method: "branch" }), ctx())

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual(expect.objectContaining({ signingOtp: "required" }))
    expect(updateClientDocument).not.toHaveBeenCalled()
  })

  it("lets a witnessed staff branch signing through while the exemption is on", async () => {
    getDocumentCaller.mockResolvedValue({ type: "staff", userId: "u1", role: "LOAN_ADMIN", tenantId: "t1" })

    const res = await POST(req({ method: "branch" }), ctx())

    expect(res.status).toBe(200)
    expect(otpUpdateMany).not.toHaveBeenCalled()
  })

  it("refuses a code issued for other bytes of the document", async () => {
    getDocumentCaller.mockResolvedValue(client)
    otpFindFirst.mockResolvedValue({ ...verified, documentSha256: "d".repeat(64) })

    const res = await POST(req({ method: "portal", signingOtpChallengeId: "otp-1" }), ctx())

    expect(res.status).toBe(409)
    expect(updateClientDocument).not.toHaveBeenCalled()
  })

  it("refuses a document with no content digest to bind a code to", async () => {
    getDocumentCaller.mockResolvedValue(client)
    findFirstClientDocument.mockResolvedValue({ ...PENDING_DOC, contentSha256: null })

    const res = await POST(req({ method: "portal", signingOtpChallengeId: "otp-1" }), ctx())

    expect(res.status).toBe(422)
    expect(updateClientDocument).not.toHaveBeenCalled()
  })

  it("spends a verified code with the signature and audits its evidence", async () => {
    getDocumentCaller.mockResolvedValue(client)

    const res = await POST(req({ method: "portal", signingOtpChallengeId: "otp-1" }), ctx())

    expect(res.status).toBe(200)
    expect(otpUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "otp-1", clientId: "client-1", purpose: "DOCUMENT", subjectId: "doc1", documentSha256: DIGEST, consumedAt: null,
      }),
      data: expect.objectContaining({ signingMethod: "portal" }),
    }))
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      newValue: expect.objectContaining({
        signingOtp: expect.objectContaining({ challengeId: "otp-1", channel: "WHATSAPP", attempts: 2 }),
      }),
    }))
  })

  it("does not sign when the code is spent concurrently", async () => {
    getDocumentCaller.mockResolvedValue(client)
    otpUpdateMany.mockResolvedValue({ count: 0 })
    otpFindFirst
      .mockResolvedValueOnce(verified)
      .mockResolvedValueOnce({ ...verified, consumedAt: new Date() })

    const res = await POST(req({ method: "portal", signingOtpChallengeId: "otp-1" }), ctx())

    expect(res.status).toBe(403)
    expect(updateClientDocument).not.toHaveBeenCalled()
  })
})

describe("POST /api/documents/[id]/sign — guarded claim and session-decided method", () => {
  it("409s and writes no audit or access log when the claim misses (signed or replaced concurrently)", async () => {
    getDocumentCaller.mockResolvedValue({ type: "staff", userId: "u1", role: "LOAN_ADMIN", tenantId: "t1" })
    updateClientDocument.mockResolvedValue({ count: 0 })

    const res = await POST(req({ method: "branch" }), ctx())

    expect(res.status).toBe(409)
    expect(logAudit).not.toHaveBeenCalled()
    expect(createDocumentAccessLog).not.toHaveBeenCalled()
  })

  it("restates the bytes that were checked in the claim", async () => {
    getDocumentCaller.mockResolvedValue({ type: "staff", userId: "u1", role: "LOAN_ADMIN", tenantId: "t1" })
    findFirstClientDocument.mockResolvedValue({ ...PENDING_DOC, contentSha256: "e".repeat(64) })

    await POST(req({ method: "branch" }), ctx())

    expect(updateClientDocument).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ contentSha256: "e".repeat(64) }),
    }))
  })

  it("treats a staff caller as a branch witness even when the body says portal", async () => {
    tenantConfigFindUnique.mockResolvedValue({ requireSigningOtp: true, signingOtpBranchExempt: true })
    getDocumentCaller.mockResolvedValue({ type: "staff", userId: "u1", role: "LOAN_ADMIN", tenantId: "t1" })
    findFirstClientDocument.mockResolvedValue({ ...PENDING_DOC, contentSha256: "e".repeat(64) })

    const res = await POST(req({ method: "portal" }), ctx())

    expect(res.status).toBe(200)
    expect(otpUpdateMany).not.toHaveBeenCalled()
  })
})
