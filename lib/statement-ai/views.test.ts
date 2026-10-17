import type { StatementAiOutput } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { toView } from "./views"

const row = (over: Partial<StatementAiOutput>): StatementAiOutput => ({
  id: "o1", tenantId: "t1", applicationId: "a1", kind: "SUMMARY", flagCode: "", inputHash: "h1", promptVersion: "summary-p3",
  status: "OK", rejectReason: null, text: "Spend looks normal.", citations: { facts: {} }, question: null, askedById: null,
  createdAt: new Date("2026-10-17T08:00:00Z"), updatedAt: new Date("2026-10-17T08:00:00Z"), ...over,
})

describe("toView", () => {
  it("shows an OK output's text and citations, and never a rejected one's", () => {
    expect(toView(row({}), "h1", [])).toMatchObject({ status: "OK", text: "Spend looks normal.", stale: false })
    expect(toView(row({ status: "REJECTED", text: "R999.00" }), "h1", [])).toMatchObject({ status: "REJECTED", text: null, citations: null })
  })
  it("hides an output written before a flag was raised that would now read as reassurance", () => {
    expect(toView(row({}), "h2", ["GAMBLING"])).toMatchObject({ status: "REJECTED", text: null, citations: null, stale: true })
  })
})
