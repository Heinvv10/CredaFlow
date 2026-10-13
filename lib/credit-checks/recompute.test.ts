import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("./load-facts", () => ({ loadApplicationFacts: vi.fn() }))

import type { ApplicationCheckFlag } from "@prisma/client"
import { maySupersede } from "./recompute"
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

  it("goes when its own statement was re-read into a reconciling read, and not otherwise", () => {
    const old = { documentId: "doc-1", analysisId: "an-old" }
    expect(maySupersede(flag("GAMBLING", old), facts())).toBe(true)
    expect(maySupersede(flag("GAMBLING", old), facts({ statements: [statement([], { balanceCheck: "FAIL" })] }))).toBe(false)
    expect(maySupersede(flag("GAMBLING", { documentId: "doc-1", analysisId: "an-1" }), facts())).toBe(false)
  })

  it("stays when its statement was deleted or the client record changed", () => {
    expect(maySupersede(flag("GAMBLING", { documentId: "doc-1", analysisId: "an-old" }), facts({ statements: [] }))).toBe(false)
    expect(maySupersede(flag("UNDISCLOSED_DEBIT_ORDER", { documentId: "doc-1", analysisId: "an-1" }), facts({ debts: [{ name: "X", monthlyInstalmentCents: 1, source: "DECLARED" }] }))).toBe(false)
    expect(maySupersede(flag("STATEMENT_DELETED", { documentId: "gone" }), facts())).toBe(false)
    expect(maySupersede(flag("PAYSLIP_UNVALIDATED", { payslipDocumentId: "slip-1" }), facts())).toBe(false)
  })
})
