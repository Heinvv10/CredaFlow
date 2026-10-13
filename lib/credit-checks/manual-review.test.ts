import { describe, expect, it } from "vitest"
import { manualReview } from "./manual-review"
import { codes, facts, statement } from "./facts.test-helpers"

describe("manualReview", () => {
  it("raises nothing for a verified text read", () => {
    expect(manualReview(facts())).toEqual([])
  })

  it("raises NO_STATEMENT when the application has no bank statement", () => {
    expect(codes(manualReview(facts({ statements: [] })))).toEqual(["NO_STATEMENT"])
  })

  it("raises UNVERIFIED_READ for a vision read that fails or cannot run the balance check", () => {
    expect(codes(manualReview(facts({ statements: [statement([], { method: "VLM", balanceCheck: "FAIL" })] })))).toEqual(["UNVERIFIED_READ"])
    expect(codes(manualReview(facts({ statements: [statement([], { method: "VLM", balanceCheck: "NOT_APPLICABLE" })] })))).toEqual(["UNVERIFIED_READ"])
    expect(manualReview(facts({ statements: [statement([], { method: "VLM", balanceCheck: "PASS" })] }))).toEqual([])
  })

  it("raises UNVERIFIED_READ for a text read without both balances", () => {
    expect(codes(manualReview(facts({ statements: [statement([], { balanceCheck: "NOT_APPLICABLE" })] })))).toEqual(["UNVERIFIED_READ"])
  })

  it("raises UNREADABLE for a statement no reader could read, or one too long to read", () => {
    const unreadable = statement([], { state: "UNREADABLE", read: null, balanceCheck: "NOT_APPLICABLE", method: "VLM" })
    const unsupported = statement([], { state: "UNSUPPORTED", read: null, balanceCheck: "NOT_APPLICABLE", method: "VLM", documentId: "doc-2", analysisId: "an-2" })
    expect(codes(manualReview(facts({ statements: [unreadable, unsupported] })))).toEqual(["UNREADABLE", "UNREADABLE"])
  })

  it("raises NOT_READ for a statement still waiting for the vision reader", () => {
    const pending = statement([], { state: "PENDING", read: null, analysisId: null, method: null, balanceCheck: null, authenticity: null })
    expect(codes(manualReview(facts({ statements: [pending] })))).toEqual(["NOT_READ"])
  })
})
