import { Prisma } from "@prisma/client"
import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ application: vi.fn(), raw: vi.fn(), transaction: vi.fn(), deleteFile: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { loanApplication: { findFirst: m.application }, $queryRaw: m.raw, $transaction: m.transaction } }))
vi.mock("@/lib/audit", () => ({ AuditAction: {}, logAuditStrict: vi.fn() }))
vi.mock("@/lib/storage", () => ({ saveFile: async () => ({ storagePath: "/mem/a.pdf", fileSize: 1 }), deleteFile: m.deleteFile }))
vi.mock("./render", () => ({ renderLoanDocument: async () => ({ pdf: Buffer.from("%PDF"), kind: "LOAN_AGREEMENT" }) }))

import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import { approvedAffordabilityResult } from "./approval.integration-fixture"
import { issueLoanDocuments } from "./issue"

const client = { id: "c1", idNumber: "990000001", firstName: "Thabo", lastName: "Synthetic", dateOfBirth: null }
const affordabilityResult = approvedAffordabilityResult({ principalCents: 500_000, termDays: 90, productId: "p", interestRatePm: 0.023, interestModel: "REDUCING_BALANCE", monthlyServiceFeeCents: 6_900, borrowerIdentity: biometricSubjectFingerprint(client) })
const args = { tenantId: "t1", applicationId: "a1", staff: { id: "s1", email: "s@test.invalid" } }

describe("issueLoanDocuments when the transaction loses", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.application.mockResolvedValue({ id: "a1", clientId: "c1", status: "APPROVED", disclosureRegime: "KEY_FACTS", agreementSignedAt: null, affordabilityResult, client })
    m.raw.mockResolvedValue([{ terms: "t" }])
    m.deleteFile.mockResolvedValue(undefined)
  })

  it("answers a timeout or a lost race as a conflict and leaves no file behind", async () => {
    for (const code of ["P2028", "P2034"]) {
      m.transaction.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("timed out", { code, clientVersion: "5" }))
      expect(await issueLoanDocuments(args)).toMatchObject({ ok: false, status: 409 })
    }
    expect(m.deleteFile).toHaveBeenCalled()
  })

  it("a fault stays a fault", async () => {
    m.transaction.mockRejectedValueOnce(new Error("boom"))
    await expect(issueLoanDocuments(args)).rejects.toThrow("boom")
  })
})
