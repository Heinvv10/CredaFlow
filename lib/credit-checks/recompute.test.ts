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
import { facts, statement, tx as row } from "./facts.test-helpers"
import { fingerprint } from "./run-checks"
import { statementKey, type StatementFacts } from "./types"

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

  it("stays when its statement was deleted or the client record changed", () => {
    expect(maySupersede(flag("GAMBLING", { documentId: "doc-1", analysisId: "an-old" }), facts({ statements: [] }))).toBe(false)
    expect(maySupersede(flag("UNDISCLOSED_DEBIT_ORDER", { documentId: "doc-1", analysisId: "an-1" }), facts({ debts: [{ name: "X", monthlyInstalmentCents: 1, source: "DECLARED" }] }))).toBe(false)
    expect(maySupersede(flag("STATEMENT_DELETED", { documentId: "gone" }), facts())).toBe(false)
    expect(maySupersede(flag("PAYSLIP_UNVALIDATED", { payslipDocumentId: "slip-1" }), facts())).toBe(false)
  })
})

describe("maySupersede: a boundary row flag once the neighbouring statement verifies the row", () => {
  /** An ABSA Transaction History statement: no opening printed, so it is derived from the first row. */
  function absa(id: string, periodStart: string, periodEnd: string, openingCents: number, amountCents: number): StatementFacts {
    const s = statement([row(periodStart, "SYNTH", amountCents, openingCents + amountCents)], {
      documentId: id, analysisId: `an-${id}`, contentSha256: `sha-${id}`, bank: "ABSA",
      authenticity: { producer: "iText 2.1.7 by 1T3XT", creator: null, createdAt: null, modifiedAt: null, incrementalUpdates: 0, signals: ["OPENING_DERIVED"] },
    })
    Object.assign(s.read!, { periodStart, periodEnd, openingBalanceCents: openingCents, closingBalanceCents: openingCents + amountCents })
    return s
  }
  const june = absa("a", "2026-06-01", "2026-06-30", 100_000, 500_000)
  const july = absa("b", "2026-07-01", "2026-07-31", 600_000, -30_000)
  const firstRow = (s: StatementFacts, key = statementKey(s)) =>
    ({ check: "MANUAL_REVIEW", code: "FIRST_ROW_UNVERIFIED", fingerprint: fingerprint({ check: "MANUAL_REVIEW", code: "FIRST_ROW_UNVERIFIED", key }), evidence: { documentId: s.documentId } } as unknown as ApplicationCheckFlag)

  it("goes once the previous statement of the account closes where this one opens", () => {
    expect(maySupersede(firstRow(july), facts({ statements: [june, july] }))).toBe(true)
  })

  it("stays while no statement chains, or when the chaining one opens a cent away", () => {
    expect(maySupersede(firstRow(july), facts({ statements: [july] }))).toBe(false)
    expect(maySupersede(firstRow(july), facts({ statements: [absa("a", "2026-06-01", "2026-06-30", 100_001, 500_000), july] }))).toBe(false)
  })

  it("stays when its statement was deleted, or the flag was raised on other bytes of the document", () => {
    expect(maySupersede(firstRow(july), facts({ statements: [june] }))).toBe(false)
    expect(maySupersede(firstRow(july, "b:sha-older"), facts({ statements: [june, july] }))).toBe(false)
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
