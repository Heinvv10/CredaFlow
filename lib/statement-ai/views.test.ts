import type { StatementAiOutput } from "@prisma/client"
import { describe, expect, it, vi } from "vitest"

const plan = vi.hoisted(() => ({ explanations: [] as Array<{ flagId: string | null; flagCode: string; text: string | null }> }))
vi.mock("./generate", () => ({ planOutputs: async () => plan }))

import { flagExplanations, toView } from "./views"

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
    expect(toView(row({ kind: "ANSWER" }), "h2", ["GAMBLING"])).toMatchObject({ status: "REJECTED", text: null, citations: null, stale: true })
  })
})

describe("toView: a summary missing a flag raised since", () => {
  it("is not shown", () => {
    const text = "Flags raised by the credit checks: GAMBLING (RISK_BEHAVIOUR, 3 evidence rows). An officer reviews each before a decision."
    expect(toView(row({ text }), "h2", ["GAMBLING"])).toMatchObject({ status: "OK", text })
    expect(toView(row({ text }), "h2", ["GAMBLING", "RETURNED_DEBIT"])).toMatchObject({ status: "PENDING", text: null, stale: true })
    expect(toView(row({ kind: "ANSWER", text: "[q1] Rows for all rows: 3." }), "h2", ["RETURNED_DEBIT"])).toMatchObject({ status: "OK" })
    // A payee named like the new flag's code does not count as naming it.
    expect(toView(row({ text: `Largest payees by money out: "GAMBLING" R1.00 (1 payment). ${text}` }), "h2", ["GAMBLING", "UNREADABLE"])).toMatchObject({ text: null })
    expect(toView(row({ text: `Largest payees by money out: "UNREADABLE" R1.00 (1 payment). ${text}` }), "h2", ["GAMBLING", "UNREADABLE"])).toMatchObject({ status: "PENDING", text: null })
  })
})

describe("flagExplanations", () => {
  it("maps each explained flag to its own row, and leaves out one with no spec, no text or no row", async () => {
    plan.explanations = [
      { flagId: "f1", flagCode: "GAMBLING", text: "Betting is compared with income." },
      { flagId: "f2", flagCode: "SOMETHING_NEW", text: "A rule raised this for an officer to review by hand." },
      { flagId: "f3", flagCode: "BALANCE_MISMATCH", text: null },
      { flagId: null, flagCode: "RETURNED_DEBIT", text: "Debits returned unpaid are listed." },
      { flagId: "f5", flagCode: "toString", text: "Not a code." },
    ]
    expect([...(await flagExplanations("t1", "a1"))]).toEqual([["f1", "Betting is compared with income."]])
  })
})
