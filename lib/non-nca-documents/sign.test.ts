import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  application: vi.fn(), document: vi.fn(), updateMany: vi.fn(), tx: vi.fn(), audit: vi.fn(), readFile: vi.fn(), otpRequired: vi.fn(), check: vi.fn(), consume: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: { findFirst: m.application }, clientDocument: { findFirst: m.document },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({ loanApplication: { updateMany: m.updateMany } }),
  },
}))
vi.mock("@/lib/audit", () => ({ AuditAction: { KEY_FACTS_AGREEMENT_SIGNED: "KEY_FACTS_AGREEMENT_SIGNED" }, logAuditStrict: m.audit }))
vi.mock("@/lib/storage", () => ({ readFile: m.readFile }))
vi.mock("@/lib/signing-otp/policy", () => ({ isSigningOtpRequired: m.otpRequired }))
vi.mock("@/lib/signing-otp/challenge", () => ({
  checkSigningOtp: m.check, consumeSigningOtp: m.consume,
  SigningOtpRefusedError: class extends Error { constructor(readonly reason: string) { super(reason) } },
}))

import { createHash } from "node:crypto"
import { Prisma } from "@prisma/client"
import { SigningOtpRefusedError } from "@/lib/signing-otp/challenge"
import { signKeyFactsAgreement } from "./sign"

const BYTES = Buffer.from("%PDF synthetic agreement")
const SHA = createHash("sha256").update(BYTES).digest("hex")
const base = { tenantId: "t1", applicationId: "a1", clientId: "c1", clientEmail: "c1@client.invalid", agreementDocumentSha256: SHA, signature: "Thabo Synthetic", signingOtpChallengeId: "ch1", ipAddress: "203.0.113.5" }
const approved = { id: "a1", status: "APPROVED", disclosureRegime: "KEY_FACTS", agreementSignedAt: null, agreementDocumentId: "d1", agreementDocumentSha256: SHA, client: { firstName: "T", lastName: "S" } }

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.application.mockResolvedValue(approved)
  m.document.mockResolvedValue({ storagePath: "/mem/a.pdf" })
  m.readFile.mockResolvedValue(BYTES)
  m.otpRequired.mockResolvedValue(true)
  m.check.mockResolvedValue(null)
  m.updateMany.mockResolvedValue({ count: 1 })
})

describe("signKeyFactsAgreement", () => {
  it("records the signature over the digest shown, spending the one-time code in the same transaction, and audits it", async () => {
    expect(await signKeyFactsAgreement(base)).toMatchObject({ ok: true })
    expect(m.consume).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ challengeId: "ch1", purpose: "AGREEMENT", subjectId: "a1", documentSha256: SHA, clientId: "c1" }))
    expect(m.updateMany.mock.calls[0][0].data).toMatchObject({ agreementSignedMethod: "portal", agreementSignedByIp: "203.0.113.5", agreementSignatureData: "Thabo Synthetic" })
    expect(m.updateMany.mock.calls[0][0].where).toMatchObject({ status: "APPROVED", agreementSignedAt: null, agreementDocumentSha256: SHA })
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "KEY_FACTS_AGREEMENT_SIGNED", userEmail: "c1@client.invalid" }), expect.anything())
  })

  it("needs the one-time code when the lender requires one, and says why when it is not good", async () => {
    m.check.mockResolvedValue("required")
    expect(await signKeyFactsAgreement({ ...base, signingOtpChallengeId: null })).toMatchObject({ ok: false, status: 409, signingOtp: "required" })
    m.check.mockResolvedValue(null)
    m.consume.mockRejectedValue(new SigningOtpRefusedError("already_used"))
    expect(await signKeyFactsAgreement(base)).toMatchObject({ ok: false, signingOtp: "already_used" })
    expect(m.audit).not.toHaveBeenCalled()
  })

  it("asks for no code when the lender does not", async () => {
    m.otpRequired.mockResolvedValue(false)
    expect(await signKeyFactsAgreement({ ...base, signingOtpChallengeId: null })).toMatchObject({ ok: true })
    expect(m.check).not.toHaveBeenCalled()
    expect(m.consume).not.toHaveBeenCalled()
  })

  it.each([
    ["a PASQ application", { ...approved, disclosureRegime: "NCA_PASQ" }, 409],
    ["an application that is not approved", { ...approved, status: "UNDER_REVIEW" }, 409],
    ["an agreement already signed", { ...approved, agreementSignedAt: new Date() }, 409],
    ["an agreement not yet issued", { ...approved, agreementDocumentId: null, agreementDocumentSha256: null }, 422],
  ])("refuses %s", async (_label, row, status) => {
    m.application.mockResolvedValue(row)
    expect(await signKeyFactsAgreement(base)).toMatchObject({ ok: false, status })
    expect(m.updateMany).not.toHaveBeenCalled()
  })

  it("refuses a digest the borrower was not shown, a missing signature, and stored bytes that no longer match", async () => {
    expect(await signKeyFactsAgreement({ ...base, agreementDocumentSha256: "0".repeat(64) })).toMatchObject({ ok: false, status: 409 })
    expect(await signKeyFactsAgreement({ ...base, signature: "  " })).toMatchObject({ ok: false, status: 422 })
    m.readFile.mockResolvedValue(Buffer.from("tampered"))
    expect(await signKeyFactsAgreement(base)).toMatchObject({ ok: false, status: 422, error: expect.stringMatching(/does not match what was issued/) })
    expect(m.updateMany).not.toHaveBeenCalled()
  })

  it("surfaces the database gate's own sentence when it refuses the write", async () => {
    m.updateMany.mockRejectedValue(new Prisma.PrismaClientUnknownRequestError('Error occurred during query execution: ConnectorError { kind: QueryError(PostgresError { code: "23514", message: "A loan without a key facts statement and a loan agreement from an approved template cannot be signed: template version 2 is no longer the current approved version", severity: "ERROR" }) }', { clientVersion: "5.22.0" }))
    const result = await signKeyFactsAgreement(base)
    expect(result).toMatchObject({ ok: false, status: 409 })
    expect((result as { error: string }).error).toMatch(/^A loan without a key facts statement.*current approved version$/)
  })

  it("answers a fault that is not a conflict with a thrown error (a 500), not a 409", async () => {
    m.updateMany.mockRejectedValue(new TypeError("cannot read properties of undefined"))
    await expect(signKeyFactsAgreement(base)).rejects.toThrow(TypeError)
    m.updateMany.mockResolvedValue({ count: 0 })
    expect(await signKeyFactsAgreement(base)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/changed while it was being signed/) })
  })
})
