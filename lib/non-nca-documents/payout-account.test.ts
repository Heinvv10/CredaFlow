import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ application: vi.fn(), create: vi.fn(), audit: vi.fn(), queryRaw: vi.fn() }))
vi.mock("@/lib/prisma", () => {
  const tx = { $queryRaw: h.queryRaw, loanApplication: { findFirst: h.application }, avsCheck: { create: h.create }, auditLog: { create: h.audit } }
  return { prisma: { loanApplication: { findFirst: h.application }, $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) } }
})

import { avsSubjectFingerprint } from "@/lib/compliance/avs-subject"
import { currentPayoutVerification, recordPayoutAccountVerification } from "./payout-account"
import { SECOND_PERSON_VERIFICATION_PROVIDER } from "./payout-terms"

const client = { id: "client-1", idNumber: "990001234", firstName: "Synthetic", lastName: "Borrower", bankName: "Demo Bank Lesotho", bankBranchCode: "100001", bankAccountNumber: "62000012345", accountType: "CHEQUE" }
const args = { tenantId: "t1", applicationId: "app-1", user: { id: "second", email: "second@test.invalid" }, note: "Confirmed with the bank by telephone today." }

describe("recording the second person's confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.create.mockResolvedValue({ id: "check-1" })
  })
  const row = (over: object) => h.application.mockResolvedValue({ clientId: "client-1", status: "APPROVED", disclosureRegime: "KEY_FACTS", client, ...over })

  it("takes the application and client evidence locks, binds the account and audits who did it", async () => {
    row({})
    expect(await recordPayoutAccountVerification(args)).toEqual({ ok: true, id: "check-1" })
    expect(h.queryRaw.mock.calls.map(([query]) => query.values[0])).toEqual(["affordability-application:t1:app-1", "affordability-client:t1:client-1"])
    expect(h.create.mock.calls[0][0].data).toMatchObject({ provider: SECOND_PERSON_VERIFICATION_PROVIDER, checkedById: "second", subjectFingerprint: avsSubjectFingerprint(client), applicationId: "app-1", passed: true })
    expect(h.audit.mock.calls[0][0].data).toMatchObject({ action: "PAYOUT_ACCOUNT_VERIFIED", userId: "second", entityId: "app-1" })
  })

  it("is refused for an NCA application, which has AVS, and writes nothing", async () => {
    row({ disclosureRegime: "NCA_PASQ" })
    expect(await recordPayoutAccountVerification(args)).toMatchObject({ ok: false, status: 409 })
    expect(h.create).not.toHaveBeenCalled()
  })

  it("is refused without a complete bank record or a note saying how", async () => {
    row({ client: { ...client, bankBranchCode: null } })
    expect(await recordPayoutAccountVerification(args)).toMatchObject({ ok: false, status: 422 })
    expect(await recordPayoutAccountVerification({ ...args, note: "ok" })).toMatchObject({ ok: false, status: 400 })
    expect(h.create).not.toHaveBeenCalled()
  })
})

describe("the confirmation a payout stands on", () => {
  const check = (over: object = {}) => ({
    id: "check-1", clientId: client.id, applicationId: "app-1", subjectFingerprint: avsSubjectFingerprint(client), passed: true, provider: SECOND_PERSON_VERIFICATION_PROVIDER, checkedById: "second", ...over,
  })
  const judge = (latest: object | null, disburserId = "disburser") =>
    currentPayoutVerification({ avsCheck: { findFirst: async () => latest } } as never, { tenantId: "t1", applicationId: "app-1", client, disburserId })

  it("holds for the same account, confirmed by someone else", async () => {
    expect(await judge(check())).toEqual({ ok: true, avsCheckId: "check-1", verifiedById: "second" })
  })
  it("is refused for none, another application, a changed account, a provider's result or an unnamed confirmer", async () => {
    for (const latest of [null, check({ applicationId: "app-2" }), check({ subjectFingerprint: "a".repeat(64) }), check({ provider: "netcash" }), check({ checkedById: null }), check({ passed: false })]) {
      expect(await judge(latest)).toMatchObject({ ok: false, error: expect.stringMatching(/second staff member/) })
    }
  })
  it("is refused for the disburser, whatever else holds", async () => {
    expect(await judge(check(), "second")).toMatchObject({ ok: false, error: expect.stringMatching(/cannot also pay it out/) })
  })
})
