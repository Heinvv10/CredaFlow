import { describe, expect, it } from "vitest"
import { emptyRefundForm, refundActions, refundBody } from "./refund-model"

const file = new File(["%PDF-1.4"], "bank.pdf", { type: "application/pdf" })
const form = { ...emptyRefundForm(), accountHolder: "TEST Holder", bankName: "TEST Bank", branchCode: "123 456", accountNumber: "1234-5678-90", file }

describe("refundBody", () => {
  it("is multipart with the account digits normalised and the verification attached", () => {
    const built = refundBody(form)
    if (!("body" in built)) throw new Error(built.error)
    expect(built.body.get("branchCode")).toBe("123456")
    expect(built.body.get("accountNumber")).toBe("1234567890")
    expect(built.body.get("docType")).toBe("BANK_STATEMENT")
    expect((built.body.get("file") as File).name).toBe("bank.pdf")
  })
  it("asks for what the route would refuse", () => {
    expect(refundBody({ ...form, branchCode: "12" })).toMatchObject({ error: expect.stringMatching(/branch code/) })
    expect(refundBody({ ...form, accountNumber: "12ab" })).toMatchObject({ error: expect.stringMatching(/account number/) })
    expect(refundBody({ ...form, file: null })).toMatchObject({ error: expect.stringMatching(/confirmation/) })
  })
})

describe("refundActions", () => {
  const officer = { canManage: true, canDecide: false }
  const admin = { canManage: true, canDecide: true }
  it("lets a manager create the refund once, and nobody create a second", () => {
    expect(refundActions(null, "u-1", officer)).toEqual({ create: true, approve: false, release: false })
    expect(refundActions({ status: "PENDING_APPROVAL", createdById: "u-1", approvedById: null }, "u-1", officer).create).toBe(false)
  })
  it("never lets the creator approve, and releases only once approved", () => {
    const pending = { status: "PENDING_APPROVAL" as const, createdById: "u-1", approvedById: null }
    expect(refundActions(pending, "u-1", admin)).toMatchObject({ approve: false, release: false })
    expect(refundActions(pending, "u-2", admin)).toMatchObject({ approve: true, release: false })
    const approved = { status: "APPROVED" as const, createdById: "u-1", approvedById: "u-2" }
    expect(refundActions(approved, "u-3", admin)).toMatchObject({ approve: false, release: true })
    expect(refundActions(approved, "u-1", admin)).toMatchObject({ release: true })
    expect(refundActions(approved, "u-2", admin)).toMatchObject({ release: false })
    expect(refundActions(approved, "u-3", officer)).toMatchObject({ release: false })
  })
})
