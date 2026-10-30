import { beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { Prisma } from "@prisma/client"

const m = vi.hoisted(() => ({ application: vi.fn(), issuance: vi.fn(), updateMany: vi.fn(), audit: vi.fn(), readFile: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: { findFirst: m.application }, loanDocumentIssuance: { findFirst: m.issuance },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({ loanDocumentIssuance: { updateMany: m.updateMany } }),
  },
}))
vi.mock("@/lib/audit", () => ({ AuditAction: { KEY_FACTS_ACKNOWLEDGED: "KEY_FACTS_ACKNOWLEDGED" }, logAuditStrict: m.audit }))
vi.mock("@/lib/storage", () => ({ readFile: m.readFile }))

import { acknowledgeKeyFacts } from "./acknowledge"

const BYTES = Buffer.from("%PDF synthetic key facts")
const SHA = createHash("sha256").update(BYTES).digest("hex")
const args = { tenantId: "t1", applicationId: "a1", clientId: "c1", clientEmail: "c1@client.invalid", shown: SHA, ipAddress: "203.0.113.5" }
const approved = { id: "a1", status: "APPROVED", disclosureRegime: "KEY_FACTS", agreementSignedAt: null }
const standing = { id: "i1", pdfSha256: SHA, templateVersionNumber: 2, acknowledgedAt: null, clientDocument: { storagePath: "/mem/k.pdf", deletedAt: null } }

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.application.mockResolvedValue(approved)
  m.issuance.mockResolvedValue(standing)
  m.readFile.mockResolvedValue(BYTES)
  m.updateMany.mockResolvedValue({ count: 1 })
})

describe("acknowledgeKeyFacts", () => {
  it("records the borrower's acknowledgement of exactly the bytes shown, and audits it with the borrower's email", async () => {
    expect(await acknowledgeKeyFacts(args)).toMatchObject({ ok: true })
    expect(m.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "i1", supersededAt: null, acknowledgedAt: null }, data: { acknowledgedById: "c1", acknowledgedSha256: SHA } })
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "KEY_FACTS_ACKNOWLEDGED", userEmail: "c1@client.invalid" }), expect.anything())
  })

  it("refuses when the stored file is no longer the issued one (a tampered, replaced or unreadable file), recording nothing", async () => {
    m.readFile.mockResolvedValue(Buffer.from("tampered"))
    expect(await acknowledgeKeyFacts(args)).toMatchObject({ ok: false, status: 422, error: expect.stringMatching(/does not match what was issued/) })
    m.readFile.mockRejectedValue(new Error("ENOENT"))
    expect(await acknowledgeKeyFacts(args)).toMatchObject({ ok: false, status: 422 })
    m.readFile.mockResolvedValue(BYTES)
    m.issuance.mockResolvedValue({ ...standing, clientDocument: { storagePath: "/mem/k.pdf", deletedAt: new Date() } })
    expect(await acknowledgeKeyFacts(args)).toMatchObject({ ok: false, status: 422 })
    m.issuance.mockResolvedValue({ ...standing, clientDocument: { storagePath: null, deletedAt: null } })
    expect(await acknowledgeKeyFacts(args)).toMatchObject({ ok: false, status: 422 })
    expect(m.updateMany).not.toHaveBeenCalled()
  })

  it("refuses a digest the borrower was not shown", async () => {
    expect(await acknowledgeKeyFacts({ ...args, shown: "0".repeat(64) })).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/replaced after this page loaded/) })
    expect(m.updateMany).not.toHaveBeenCalled()
  })

  it.each([
    ["an application that is not the borrower's", () => m.application.mockResolvedValue(null), 404],
    ["a PASQ application", () => m.application.mockResolvedValue({ ...approved, disclosureRegime: "NCA_PASQ" }), 409],
    ["an unapproved application", () => m.application.mockResolvedValue({ ...approved, status: "UNDER_REVIEW" }), 409],
    ["a signed application", () => m.application.mockResolvedValue({ ...approved, agreementSignedAt: new Date() }), 409],
    ["nothing issued yet", () => m.issuance.mockResolvedValue(null), 409],
  ])("refuses %s", async (_label, arrange, status) => {
    arrange()
    expect(await acknowledgeKeyFacts(args)).toMatchObject({ ok: false, status })
    expect(m.updateMany).not.toHaveBeenCalled()
  })

  it("is idempotent: an already acknowledged statement answers ok without a second write", async () => {
    const at = new Date()
    m.issuance.mockResolvedValue({ ...standing, acknowledgedAt: at })
    expect(await acknowledgeKeyFacts(args)).toEqual({ ok: true, acknowledgedAt: at })
    expect(m.updateMany).not.toHaveBeenCalled()
  })

  it("answers only a lost race or a database refusal as a conflict; a fault is thrown", async () => {
    m.updateMany.mockResolvedValue({ count: 0 })
    expect(await acknowledgeKeyFacts(args)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/changed while it was being acknowledged/) })
    m.updateMany.mockRejectedValue(new Prisma.PrismaClientUnknownRequestError('ConnectorError { kind: QueryError(PostgresError { code: "23514", message: "A key facts statement is acknowledged by the borrower", severity: "ERROR" }) }', { clientVersion: "5.22.0" }))
    expect(await acknowledgeKeyFacts(args)).toMatchObject({ ok: false, status: 409, error: "A key facts statement is acknowledged by the borrower" })
    m.updateMany.mockRejectedValue(new TypeError("boom"))
    await expect(acknowledgeKeyFacts(args)).rejects.toThrow(TypeError)
  })
})
