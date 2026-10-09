import { beforeEach, describe, expect, it, vi } from "vitest"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"

const { readFileMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
}))

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  readFile: (...args: unknown[]) => readFileMock(...args),
}))

import {
  currentDebitMandateBankDetails,
  currentVerifiedBankDetails,
  findVerifiedBankStatementForMandate,
} from "./debit-mandate.server"

const bytes = Buffer.from("%PDF-1.4 verified bank statement")
const digest = sha256DocumentBytes(bytes)
const bankDetails = {
  bankName: "FNB",
  branchCode: "250655",
  accountNumber: "62012345678",
  accountType: "CHEQUE" as const,
}
const statement = {
  id: "statement-bound",
  contentSha256: digest,
  storagePath: "/managed/statement-bound.pdf",
  verifiedAt: new Date("2026-07-23T10:00:00.000Z"),
  extractionResult: {
    bankName: { value: "First National Bank" },
    branchCode: { value: "250655" },
    accountNumber: { value: "620 1234 5678" },
    accountType: { value: "Current" },
  },
  validationMismatch: false,
}

describe("findVerifiedBankStatementForMandate", () => {
  beforeEach(() => {
    readFileMock.mockReset()
    readFileMock.mockResolvedValue(bytes)
  })

  it("queries an already-bound statement by id instead of losing it behind a newest-20 limit", async () => {
    const findMany = vi.fn().mockResolvedValue([statement])

    const result = await findVerifiedBankStatementForMandate(
      { clientDocument: { findMany } },
      {
        tenantId: "tenant-1",
        clientId: "client-1",
        bankDetails,
        documentId: statement.id,
      },
    )

    expect(result).toEqual({
      ok: true,
      evidence: {
        documentId: statement.id,
        documentSha256: digest,
        verifiedAt: statement.verifiedAt.toISOString(),
      },
    })
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: statement.id }),
      take: 1,
    }))
    expect(readFileMock).toHaveBeenCalledWith(statement.storagePath)
  })

  it("rejects a syntactically valid database digest when stored bytes are tampered", async () => {
    readFileMock.mockResolvedValue(Buffer.from("tampered"))
    const findMany = vi.fn().mockResolvedValue([statement])

    const result = await findVerifiedBankStatementForMandate(
      { clientDocument: { findMany } },
      {
        tenantId: "tenant-1",
        clientId: "client-1",
        bankDetails,
      },
    )

    expect(result).toEqual({
      ok: false,
      reason: "verified_bank_statement_integrity_missing",
    })
  })

  it("rejects a missing stored statement file", async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }))
    const findMany = vi.fn().mockResolvedValue([statement])

    const result = await findVerifiedBankStatementForMandate(
      { clientDocument: { findMany } },
      {
        tenantId: "tenant-1",
        clientId: "client-1",
        bankDetails,
      },
    )

    expect(result).toEqual({
      ok: false,
      reason: "verified_bank_statement_integrity_missing",
    })
  })
})

// The EFT payout tuple reader and its debit-order twin.
//
// These two functions were a single alias until OTHER split them, and NOTHING
// executed either body: `debit-mandate.server.test.ts` did not import them and
// `disburse/route.test.ts` replaces them with `vi.fn()`. Deleting the OTHER
// branch from currentVerifiedBankDetails left 234 tests green — it is the only
// thing deciding whether an OTHER-account client can be paid at all, so a
// mutation that silently passes means the decision is untested.
//
// They are asserted TOGETHER on purpose. The pair carries the rule "OTHER may
// be paid by EFT but may never reach a debit order", and that rule is only
// visible in the difference between them. Testing one alone would let the other
// drift back into agreement without anything failing.
describe("payout vs debit-order bank tuple readers", () => {
  const client = {
    bankName: "Discovery Bank",
    bankBranchCode: "679000",
    bankAccountNumber: "10000020011",
    accountType: "OTHER",
  }
  const application = (accountType: string) =>
    ({ client: { ...client, accountType } }) as unknown as
      Parameters<typeof currentVerifiedBankDetails>[0]

  it("gives an OTHER account a payout tuple", () => {
    expect(currentVerifiedBankDetails(application("OTHER"))).toEqual({
      bankName: "Discovery Bank",
      branchCode: "679000",
      accountNumber: "10000020011",
      accountType: "OTHER",
    })
  })

  it("refuses an OTHER account a DEBIT-ORDER tuple", () => {
    // The Netcash AVS wire has no value for OTHER, so a mandate must never be
    // prepared for one. This is the TypeScript half of that bar; the DB half is
    // the `IN ('CHEQUE','SAVINGS')` allow-list in the DISBURSED guard.
    expect(currentDebitMandateBankDetails(application("OTHER"))).toBeNull()
  })

  it.each(["CHEQUE", "SAVINGS"])("gives %s both tuples", (accountType) => {
    expect(currentVerifiedBankDetails(application(accountType)))
      .toMatchObject({ accountType })
    expect(currentDebitMandateBankDetails(application(accountType)))
      .toMatchObject({ accountType })
  })

  it("refuses a retired TRANSMISSION account BOTH tuples", () => {
    // Retired 2026-08-05 and inert. Failing closed here keeps it that way even
    // if a legacy row surfaces.
    expect(currentVerifiedBankDetails(application("TRANSMISSION"))).toBeNull()
    expect(currentDebitMandateBankDetails(application("TRANSMISSION"))).toBeNull()
  })

  it.each([
    ["bankName", { bankName: null }],
    ["bankBranchCode", { bankBranchCode: null }],
    ["bankAccountNumber", { bankAccountNumber: null }],
  ])("refuses a payout tuple when %s is missing", (_label, missing) => {
    // A branch code is no longer matched against the statement, but it is still
    // REQUIRED on file — an EFT cannot be routed without one.
    expect(currentVerifiedBankDetails(
      { client: { ...client, ...missing } } as unknown as
        Parameters<typeof currentVerifiedBankDetails>[0],
    )).toBeNull()
  })
})
