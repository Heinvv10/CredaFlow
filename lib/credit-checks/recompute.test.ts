import { describe, expect, it, vi } from "vitest"

const tx = {
  $queryRaw: vi.fn(async () => [{ status: "UNDER_REVIEW" }]),
  applicationCheckFlag: { findMany: vi.fn(async () => []) },
}
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: (fn: (t: unknown) => unknown) => fn(tx) } }))
vi.mock("./load-facts", () => ({ loadApplicationFacts: vi.fn() }))

import type { ApplicationCheckFlag } from "@prisma/client"
import { loadApplicationFacts } from "./load-facts"
import { maySupersede, recomputeApplicationFlags } from "./recompute"
import { facts, statement } from "./facts.test-helpers"

const flag = (code: string, evidence: Record<string, unknown> = {}) => ({ code, evidence } as unknown as ApplicationCheckFlag)
const pending = statement([], { state: "PENDING", read: null, analysisId: null, contentSha256: null, method: null, balanceCheck: null, authenticity: null })

describe("maySupersede: an OPEN flag that is no longer raised", () => {
  it("goes when the evidence it said was missing has arrived", () => {
    expect(maySupersede(flag("NO_STATEMENT"), facts())).toBe(true)
    expect(maySupersede(flag("NO_PAYSLIP"), facts())).toBe(true)
  })

  it("goes for an unread statement once it is read, but not when it is deleted or still unread", () => {
    expect(maySupersede(flag("NOT_READ", { documentId: "doc-1" }), facts())).toBe(true)
    expect(maySupersede(flag("NOT_READ_NO_CONSENT", { documentId: "doc-1" }), facts({ statements: [pending] }))).toBe(false)
    expect(maySupersede(flag("NOT_READ", { documentId: "doc-1" }), facts({ statements: [] }))).toBe(false)
  })

  it("stays even when a newer parser re-read its statement: the finding may have gone for other reasons", () => {
    expect(maySupersede(flag("GAMBLING", { documentId: "doc-1", analysisId: "an-old" }), facts())).toBe(false)
  })

  it("lets PAYSLIP_NOT_READ go once that payslip has been extracted, and not before", () => {
    const f = flag("PAYSLIP_NOT_READ", { payslipDocumentId: "slip-1" })
    expect(maySupersede(f, facts({ extractedPayslipIds: ["slip-1"] }))).toBe(true)
    expect(maySupersede(f, facts({ extractedPayslipIds: ["slip-2"] }))).toBe(false)
  })

  it("lets an older LIVING_SPEND_ABOVE_DECLARED go once its successor is raised, and not before", () => {
    const older = flag("LIVING_SPEND_ABOVE_DECLARED", { declaredCents: 300_000, documentIds: ["doc-1"] })
    expect(maySupersede(older, facts(), new Set(["LIVING_SPEND_ABOVE_DECLARED"]))).toBe(true)
    // Not raised again in any form (a higher declaration, say): an officer clears it.
    expect(maySupersede(older, facts(), new Set(["GAMBLING"]))).toBe(false)
    expect(maySupersede(older, facts())).toBe(false)
    // Only that code: another check's finding is not replaced by a sibling.
    expect(maySupersede(flag("GAMBLING", { documentId: "doc-1" }), facts(), new Set(["GAMBLING"]))).toBe(false)
  })

  it("stays when its statement was deleted or the client record changed", () => {
    expect(maySupersede(flag("GAMBLING", { documentId: "doc-1", analysisId: "an-old" }), facts({ statements: [] }))).toBe(false)
    expect(maySupersede(flag("UNDISCLOSED_DEBIT_ORDER", { documentId: "doc-1", analysisId: "an-1" }), facts({ debts: [{ name: "X", monthlyInstalmentCents: 1, source: "DECLARED" }] }))).toBe(false)
    expect(maySupersede(flag("STATEMENT_DELETED", { documentId: "gone" }), facts())).toBe(false)
    expect(maySupersede(flag("PAYSLIP_UNVALIDATED", { payslipDocumentId: "slip-1" }), facts())).toBe(false)
  })
})

describe("recomputeApplicationFlags under the lock", () => {
  it("reloads the facts on the locking transaction, not a second pool connection", async () => {
    const load = vi.mocked(loadApplicationFacts)
    load.mockResolvedValueOnce({ facts: facts(), status: "UNDER_REVIEW", payslipSnapshot: [], statementSnapshot: [], since: new Date() })
    load.mockResolvedValueOnce(null)
    await recomputeApplicationFlags("t1", "app-1", null)
    expect(load).toHaveBeenLastCalledWith("t1", "app-1", expect.objectContaining({ persistedOnly: true, db: tx }))
  })
})
