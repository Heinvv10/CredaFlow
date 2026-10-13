import { describe, it, expect, vi, beforeEach } from "vitest"

const authMock = vi.fn()
const getDefaultTenantIdMock = vi.fn()
const canDoMock = vi.fn()
const applyBankTransactionMock = vi.fn()
const ignoreBankTransactionMock = vi.fn()
const revalidatePathMock = vi.fn()
const importStatementMock = vi.fn()

// The error classes are declared INSIDE the factory, not referenced from the
// module scope: vi.mock is hoisted above the imports, so a factory that
// evaluates a top-level `class` binding immediately hits its TDZ. The sibling
// mocks get away with module-scope refs only because their arrow-function
// bodies are evaluated lazily, at call time. The test reads the classes back
// out of the mocked module below.
vi.mock("@/lib/bank-sync/import", async (importOriginal) => {
  class BankSyncDisabledError extends Error {}
  class StatementParseError extends Error {}
  // MAX_STATEMENT_BYTES comes from the REAL module, never a literal: a
  // hardcoded copy here would make the oversized-file test assert against
  // itself, staying green even if the real limit changed underneath it
  // (verified — it did exactly that).
  const actual = (await importOriginal()) as { MAX_STATEMENT_BYTES: number }
  return {
    importStatement: (args: unknown) => importStatementMock(args),
    BankSyncDisabledError,
    StatementParseError,
    MAX_STATEMENT_BYTES: actual.MAX_STATEMENT_BYTES,
  }
})

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }))
vi.mock("@/lib/tenant", () => ({ getDefaultTenantId: () => getDefaultTenantIdMock() }))
vi.mock("@/lib/auth-guards", () => ({
  canDo: (role: string, permission: string) => canDoMock(role, permission),
}))
vi.mock("@/lib/bank-sync/apply", () => ({
  applyBankTransaction: (args: unknown) => applyBankTransactionMock(args),
  ignoreBankTransaction: (args: unknown) => ignoreBankTransactionMock(args),
}))
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePathMock(p) }))

import { confirmMatchAction, reassignMatchAction, ignoreMatchAction, uploadStatementAction } from "./actions"
// The mocked classes, so `instanceof` in the action matches what we throw.
import { BankSyncDisabledError, StatementParseError, MAX_STATEMENT_BYTES } from "@/lib/bank-sync/import"

/** FormData carrying a CSV file, as the browser would send it. */
function formWithFile(content: string, name = "absa.csv", type = "text/csv"): FormData {
  const fd = new FormData()
  fd.set("file", new File([content], name, { type }))
  return fd
}

const SESSION = { user: { id: "u1", email: "officer@acme-lending.example", role: "CREDIT_OFFICER", tenantId: "t1" } }

describe("bank-reconciliation actions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authMock.mockResolvedValue(SESSION)
    getDefaultTenantIdMock.mockResolvedValue("default-tenant")
    canDoMock.mockReturnValue(true)
    applyBankTransactionMock.mockResolvedValue({ paymentId: "pay1" })
    ignoreBankTransactionMock.mockResolvedValue(undefined)
    importStatementMock.mockResolvedValue({
      importId: "imp1",
      lineCount: 5,
      newTxnCount: 3,
      autoApplied: 0,
      deduplicated: false,
    })
  })

  describe("confirmMatchAction", () => {
    it("applies the transaction for the resolved tenant + user, then revalidates", async () => {
      await confirmMatchAction("txn1", "loanA")

      expect(canDoMock).toHaveBeenCalledWith("CREDIT_OFFICER", "record_payment")
      expect(applyBankTransactionMock).toHaveBeenCalledWith({
        txnId: "txn1",
        loanId: "loanA",
        tenantId: "t1",
        userId: "u1",
        userEmail: "officer@acme-lending.example",
      })
      expect(revalidatePathMock).toHaveBeenCalledWith("/payments/bank-reconciliation")
    })

    it("throws Insufficient permissions and never calls applyBankTransaction when canDo is false", async () => {
      canDoMock.mockReturnValue(false)

      await expect(confirmMatchAction("txn1", "loanA")).rejects.toThrow("Insufficient permissions")
      expect(applyBankTransactionMock).not.toHaveBeenCalled()
      expect(revalidatePathMock).not.toHaveBeenCalled()
    })

    it("throws Insufficient permissions when there is no session", async () => {
      authMock.mockResolvedValue(null)

      await expect(confirmMatchAction("txn1", "loanA")).rejects.toThrow("Insufficient permissions")
      expect(applyBankTransactionMock).not.toHaveBeenCalled()
    })
  })

  describe("reassignMatchAction", () => {
    it("delegates to the same apply path as confirmMatchAction (UNMATCHED row assignment)", async () => {
      await reassignMatchAction("txn2", "loanB")

      expect(applyBankTransactionMock).toHaveBeenCalledWith({
        txnId: "txn2",
        loanId: "loanB",
        tenantId: "t1",
        userId: "u1",
        userEmail: "officer@acme-lending.example",
      })
      expect(revalidatePathMock).toHaveBeenCalledWith("/payments/bank-reconciliation")
    })
  })

  describe("ignoreMatchAction", () => {
    it("ignores the transaction with the given reason and the resolved ctx", async () => {
      await ignoreMatchAction("txn1", "not mine")

      expect(ignoreBankTransactionMock).toHaveBeenCalledWith({
        txnId: "txn1",
        reason: "not mine",
        tenantId: "t1",
        userId: "u1",
        userEmail: "officer@acme-lending.example",
      })
      expect(revalidatePathMock).toHaveBeenCalledWith("/payments/bank-reconciliation")
    })

    it("throws Insufficient permissions and never calls ignoreBankTransaction when canDo is false", async () => {
      canDoMock.mockReturnValue(false)

      await expect(ignoreMatchAction("txn1", "not mine")).rejects.toThrow("Insufficient permissions")
      expect(ignoreBankTransactionMock).not.toHaveBeenCalled()
      expect(revalidatePathMock).not.toHaveBeenCalled()
    })
  })

  describe("uploadStatementAction", () => {
    it("imports the file for the resolved tenant and revalidates", async () => {
      const res = await uploadStatementAction(formWithFile("Date,Description,Amount,Balance\n"))

      expect(canDoMock).toHaveBeenCalledWith("CREDIT_OFFICER", "record_payment")
      expect(importStatementMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "t1",
          raw: "Date,Description,Amount,Balance\n",
          format: "CSV",
        }),
      )
      expect(res).toEqual({ ok: true, importId: "imp1", lineCount: 5, newTxnCount: 3, autoApplied: 0, deduplicated: false })
      expect(revalidatePathMock).toHaveBeenCalledWith("/payments/bank-reconciliation")
    })

    // POPIA/NCA: an auditor asking "who loaded this statement" must get the
    // person, not the worker's service account. Attributing a human upload to
    // "system@bank-sync" would be a false audit record.
    it("attributes the import to the STAFF user, never the worker service account", async () => {
      await uploadStatementAction(formWithFile("Date,Description,Amount,Balance\n"))

      const arg = importStatementMock.mock.calls[0][0] as { actorEmail: string }
      expect(arg.actorEmail).toBe("officer@acme-lending.example")
      expect(arg.actorEmail).not.toBe("system@bank-sync")
    })

    it("throws Insufficient permissions and never imports when canDo is false", async () => {
      canDoMock.mockReturnValue(false)

      await expect(uploadStatementAction(formWithFile("x"))).rejects.toThrow("Insufficient permissions")
      expect(importStatementMock).not.toHaveBeenCalled()
      expect(revalidatePathMock).not.toHaveBeenCalled()
    })

    it("throws Insufficient permissions when there is no session", async () => {
      authMock.mockResolvedValue(null)

      await expect(uploadStatementAction(formWithFile("x"))).rejects.toThrow("Insufficient permissions")
      expect(importStatementMock).not.toHaveBeenCalled()
    })

    it("rejects a missing file without importing", async () => {
      const res = await uploadStatementAction(new FormData())

      expect(res).toEqual({ ok: false, error: "Choose a CSV file to upload." })
      expect(importStatementMock).not.toHaveBeenCalled()
    })

    it("rejects an empty file without importing", async () => {
      const res = await uploadStatementAction(formWithFile(""))

      expect(res).toEqual({ ok: false, error: "That file is empty." })
      expect(importStatementMock).not.toHaveBeenCalled()
    })

    // Sized off the REAL constant, so shrinking the limit cannot leave this
    // green. NOTE: this calls the action directly, so it cannot see Next's own
    // Server-Action body cap upstream — that ceiling is held equal in
    // next.config.ts (serverActions.bodySizeLimit) and is not testable here.
    it("rejects an oversized file without importing", async () => {
      const res = await uploadStatementAction(formWithFile("x".repeat(MAX_STATEMENT_BYTES + 1)))

      expect(res).toEqual({ ok: false, error: "That file is too large (max 5MB)." })
      expect(importStatementMock).not.toHaveBeenCalled()
    })

    it("accepts a file exactly at the limit", async () => {
      const res = await uploadStatementAction(formWithFile("x".repeat(MAX_STATEMENT_BYTES)))

      expect(res).toMatchObject({ ok: true })
      expect(importStatementMock).toHaveBeenCalled()
    })

    it("surfaces a parse failure as a readable error, not a crash", async () => {
      importStatementMock.mockRejectedValue(new StatementParseError("Parse failed: bad date on line 3"))

      const res = await uploadStatementAction(formWithFile("garbage"))

      expect(res).toEqual({ ok: false, error: "Parse failed: bad date on line 3" })
      expect(revalidatePathMock).not.toHaveBeenCalled()
    })

    it("surfaces the tenant flag being off as a readable error", async () => {
      importStatementMock.mockRejectedValue(new BankSyncDisabledError("nope"))

      const res = await uploadStatementAction(formWithFile("Date,Description,Amount,Balance\n"))

      expect(res).toEqual({ ok: false, error: "Bank sync is not enabled for this tenant." })
    })

    it("reports a re-uploaded file as deduplicated rather than importing it twice", async () => {
      importStatementMock.mockResolvedValue({
        importId: "imp1",
        lineCount: 5,
        newTxnCount: 0,
        autoApplied: 0,
        deduplicated: true,
      })

      const res = await uploadStatementAction(formWithFile("Date,Description,Amount,Balance\n"))

      expect(res).toMatchObject({ ok: true, deduplicated: true, newTxnCount: 0 })
    })

    // An unexpected fault must not be swallowed into a friendly message —
    // that would hide a real bug behind "something went wrong".
    it("rethrows an unexpected error rather than reporting it as a user error", async () => {
      importStatementMock.mockRejectedValue(new Error("DB exploded"))

      await expect(uploadStatementAction(formWithFile("Date,Description,Amount,Balance\n"))).rejects.toThrow("DB exploded")
    })
  })

  describe("tenant source", () => {
    it("uses the staff session's tenant, not the default, for every action", async () => {
      await confirmMatchAction("txn1", "loan1")
      await ignoreMatchAction("txn1", "duplicate")
      await uploadStatementAction(formWithFile("a,b\n1,2"))

      expect(applyBankTransactionMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1" }))
      expect(ignoreBankTransactionMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1" }))
      expect(importStatementMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1" }))
      expect(getDefaultTenantIdMock).not.toHaveBeenCalled()
    })

    it("refuses a session with no tenant instead of falling back to the default", async () => {
      authMock.mockResolvedValue({ user: { id: "u1", email: "o@acme-lending.example", role: "CREDIT_OFFICER" } })

      await expect(confirmMatchAction("txn1", "loan1")).rejects.toThrow("Insufficient permissions")
      await expect(uploadStatementAction(formWithFile("a,b\n1,2"))).rejects.toThrow("Insufficient permissions")
      expect(applyBankTransactionMock).not.toHaveBeenCalled()
      expect(importStatementMock).not.toHaveBeenCalled()
    })
  })
})
