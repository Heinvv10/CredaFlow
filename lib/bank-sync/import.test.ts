import { describe, it, expect, vi, beforeEach } from "vitest"

const tenantConfigFindUniqueMock = vi.fn()
const importFindUniqueMock = vi.fn()
const importCreateMock = vi.fn()
const importUpdateMock = vi.fn()
const saveFileMock = vi.fn()
const logAuditMock = vi.fn()
const parseStatementCsvMock = vi.fn()
const matchTransactionsMock = vi.fn()
const persistTransactionsMock = vi.fn()
const buildCandidateLoansMock = vi.fn()
const applyBankTransactionMock = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: (a: unknown) => tenantConfigFindUniqueMock(a) },
    bankStatementImport: {
      findUnique: (a: unknown) => importFindUniqueMock(a),
      create: (a: unknown) => importCreateMock(a),
      update: (a: unknown) => importUpdateMock(a),
    },
  },
}))
vi.mock("@/lib/storage", () => ({ saveFile: (...a: unknown[]) => saveFileMock(...a) }))
vi.mock("@/lib/audit", () => ({
  logAudit: (a: unknown) => logAuditMock(a),
  AuditAction: { BANK_STATEMENT_IMPORTED: "BANK_STATEMENT_IMPORTED" },
}))
vi.mock("./parse", () => ({ parseStatementCsv: (a: unknown) => parseStatementCsvMock(a) }))
vi.mock("./reconcile", () => ({ matchTransactions: (...a: unknown[]) => matchTransactionsMock(...a) }))
vi.mock("./ingest", () => ({ persistTransactions: (a: unknown) => persistTransactionsMock(a) }))
vi.mock("./candidates", () => ({ buildCandidateLoans: (a: unknown) => buildCandidateLoansMock(a) }))
vi.mock("./apply", () => ({ applyBankTransaction: (a: unknown) => applyBankTransactionMock(a) }))

import { readFileSync } from "node:fs"
import { importStatement, BankSyncDisabledError, StatementParseError, MAX_STATEMENT_BYTES } from "./import"

describe("MAX_STATEMENT_BYTES", () => {
  // Pinned to an absolute value on purpose. A test that sizes its fixture off
  // the constant proves the guard fires, but scales with the limit and so can
  // never notice the limit itself changing — which is what has to stay in sync
  // with the two things below.
  it("is 5MB", () => {
    expect(MAX_STATEMENT_BYTES).toBe(5 * 1024 * 1024)
  })

  // The bug this exists for: Next caps Server Action bodies at 1MB by DEFAULT
  // and aborts the multipart stream before the action runs. With no override,
  // the staff upload advertised "max 5MB" while dying at 1MB with an opaque
  // framework error — our own check never even executed. Assert the override is
  // present and not below our limit, so removing or shrinking it fails here
  // rather than in front of an officer holding a real statement.
  it("is not above Next's Server Action body limit in next.config.ts", () => {
    const cfg = readFileSync("next.config.ts", "utf-8")
    const m = cfg.match(/bodySizeLimit:\s*["'](\d+)mb["']/i)
    expect(m, "next.config.ts must set experimental.serverActions.bodySizeLimit").toBeTruthy()
    expect(Number(m![1]) * 1024 * 1024).toBeGreaterThanOrEqual(MAX_STATEMENT_BYTES)
  })
})

const BASE = {
  tenantId: "t1",
  raw: "Date,Description,Amount,Balance\n20260716,LN-1,100.00,500.00\n",
  contentType: "text/csv",
  accountRef: "",
  format: "CSV",
  periodStart: null,
  periodEnd: null,
  actorEmail: "officer@acme-lending.example",
}

/** A persisted row as persistTransactions returns it. */
function created(over: Partial<{ id: string; confidence: string; matchedLoanId: string | null }> = {}) {
  return { id: "txn1", confidence: "HIGH", matchedLoanId: "loanA", ...over }
}

describe("importStatement", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tenantConfigFindUniqueMock.mockResolvedValue({ bankSyncEnabled: true, absaAutoApplyHighConfidence: false })
    importFindUniqueMock.mockResolvedValue(null)
    importCreateMock.mockResolvedValue({ id: "imp1" })
    importUpdateMock.mockResolvedValue({})
    saveFileMock.mockResolvedValue({ storagePath: "/tmp/x.csv" })
    parseStatementCsvMock.mockReturnValue([{ line: 1 }, { line: 2 }])
    buildCandidateLoansMock.mockResolvedValue([])
    matchTransactionsMock.mockReturnValue([])
    persistTransactionsMock.mockResolvedValue({ newTxnCount: 2, created: [] })
    applyBankTransactionMock.mockResolvedValue({ paymentId: "pay1" })
  })

  it("runs the pipeline and reports the summary", async () => {
    const res = await importStatement(BASE)

    expect(res).toEqual({ importId: "imp1", lineCount: 2, newTxnCount: 2, autoApplied: 0, deduplicated: false })
    expect(importUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "imp1", tenantId: "t1" } }),
    )
  })

  it("throws BankSyncDisabledError and persists nothing when the tenant flag is off", async () => {
    tenantConfigFindUniqueMock.mockResolvedValue({ bankSyncEnabled: false })

    await expect(importStatement(BASE)).rejects.toThrow(BankSyncDisabledError)
    expect(importCreateMock).not.toHaveBeenCalled()
    expect(saveFileMock).not.toHaveBeenCalled()
  })

  it("throws BankSyncDisabledError when the tenant has no config row at all", async () => {
    tenantConfigFindUniqueMock.mockResolvedValue(null)

    await expect(importStatement(BASE)).rejects.toThrow(BankSyncDisabledError)
    expect(importCreateMock).not.toHaveBeenCalled()
  })

  // Parse must fail BEFORE anything is written — a malformed file leaves no
  // orphan import row and no stored file.
  it("throws StatementParseError before persisting anything", async () => {
    parseStatementCsvMock.mockImplementation(() => {
      throw new Error("bad date on line 3")
    })

    await expect(importStatement(BASE)).rejects.toThrow(StatementParseError)
    expect(saveFileMock).not.toHaveBeenCalled()
    expect(importCreateMock).not.toHaveBeenCalled()
  })

  it("returns the prior import without re-persisting when the same file hash was already imported", async () => {
    importFindUniqueMock.mockResolvedValue({ id: "impOld", lineCount: 9, newTxnCount: 4 })

    const res = await importStatement(BASE)

    expect(res).toEqual({ importId: "impOld", lineCount: 9, newTxnCount: 4, autoApplied: 0, deduplicated: true })
    expect(parseStatementCsvMock).not.toHaveBeenCalled()
    expect(importCreateMock).not.toHaveBeenCalled()
  })

  it("scopes the dedup lookup to the tenant", async () => {
    await importStatement(BASE)

    const arg = importFindUniqueMock.mock.calls[0][0] as { where: { tenantId_fileHash: { tenantId: string } } }
    expect(arg.where.tenantId_fileHash.tenantId).toBe("t1")
  })

  it("audits the import against the caller's actor", async () => {
    await importStatement(BASE)

    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        userEmail: "officer@acme-lending.example",
        entity: "BankStatementImport",
        entityId: "imp1",
      }),
    )
  })

  describe("auto-apply (absaAutoApplyHighConfidence)", () => {
    beforeEach(() => {
      tenantConfigFindUniqueMock.mockResolvedValue({ bankSyncEnabled: true, absaAutoApplyHighConfidence: true })
    })

    it("does NOT apply anything while the flag is off", async () => {
      tenantConfigFindUniqueMock.mockResolvedValue({ bankSyncEnabled: true, absaAutoApplyHighConfidence: false })
      persistTransactionsMock.mockResolvedValue({ newTxnCount: 1, created: [created()] })

      const res = await importStatement(BASE)

      expect(applyBankTransactionMock).not.toHaveBeenCalled()
      expect(res.autoApplied).toBe(0)
    })

    it("applies HIGH-confidence matches and counts them", async () => {
      persistTransactionsMock.mockResolvedValue({
        newTxnCount: 2,
        created: [created({ id: "a" }), created({ id: "b" })],
      })

      const res = await importStatement(BASE)

      expect(applyBankTransactionMock).toHaveBeenCalledTimes(2)
      expect(res.autoApplied).toBe(2)
    })

    // An auto-applied Payment was booked by the matcher, not reviewed by the
    // uploader. Stamping their email on it would claim a review that never
    // happened.
    it("attributes an auto-applied match to the SYSTEM, never the uploading human", async () => {
      persistTransactionsMock.mockResolvedValue({ newTxnCount: 1, created: [created()] })

      await importStatement(BASE)

      expect(applyBankTransactionMock).toHaveBeenCalledWith(
        expect.objectContaining({ txnId: "txn1", loanId: "loanA", tenantId: "t1", userEmail: "system@bank-sync" }),
      )
      const arg = applyBankTransactionMock.mock.calls[0][0] as { userEmail: string }
      expect(arg.userEmail).not.toBe("officer@acme-lending.example")
    })

    it("skips non-HIGH confidence and unmatched rows", async () => {
      persistTransactionsMock.mockResolvedValue({
        newTxnCount: 3,
        created: [
          created({ id: "a", confidence: "MEDIUM" }),
          created({ id: "b", matchedLoanId: null }),
          created({ id: "c" }),
        ],
      })

      const res = await importStatement(BASE)

      expect(applyBankTransactionMock).toHaveBeenCalledTimes(1)
      expect((applyBankTransactionMock.mock.calls[0][0] as { txnId: string }).txnId).toBe("c")
      expect(res.autoApplied).toBe(1)
    })

    // Best-effort: one bad row leaves that row PROPOSED for review; it must not
    // abort the import or lose the rows that did apply.
    it("keeps going and does not count a row whose apply throws", async () => {
      persistTransactionsMock.mockResolvedValue({
        newTxnCount: 2,
        created: [created({ id: "a" }), created({ id: "b" })],
      })
      applyBankTransactionMock.mockRejectedValueOnce(new Error("loan not ACTIVE"))
      vi.spyOn(console, "error").mockImplementation(() => {})

      const res = await importStatement(BASE)

      expect(res.autoApplied).toBe(1)
      expect(importUpdateMock).toHaveBeenCalled() // import still finalised
    })

    it("reports autoApplied in the audit payload", async () => {
      persistTransactionsMock.mockResolvedValue({ newTxnCount: 1, created: [created()] })

      await importStatement(BASE)

      expect(logAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({ newValue: expect.objectContaining({ autoApplied: 1 }) }),
      )
    })
  })
})
