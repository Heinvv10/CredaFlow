import { describe, expect, it } from "vitest"
import {
  parseBankAccountDecision, parseBankAccountRequest, parseSupplierCreate, parseSupplierUpdate,
} from "./supplier-input"
import { SUPPLIER_AVS_NOT_RUN_REASON, supplierAvsNotRun } from "./supplier-avs"

describe("parseSupplierCreate / parseSupplierUpdate", () => {
  it("accepts a named supplier and defaults the rest", () => {
    expect(parseSupplierCreate({ name: " TEST Plant Sales (Pty) Ltd ", vatNumber: "4000000001" })).toEqual({
      data: expect.objectContaining({ name: "TEST Plant Sales (Pty) Ltd", vatNumber: "4000000001", active: true, contactEmail: null }),
    })
  })

  it.each([
    [{ name: "" }, "name"],
    [{ name: "X", vatNumber: "5000000001" }, "vatNumber"],
    [{ name: "X", contactEmail: "not-an-email" }, "contactEmail"],
  ])("rejects %j on %s", (body, field) => {
    const parsed = parseSupplierCreate(body)
    expect("errors" in parsed && parsed.errors[field]).toBeTruthy()
  })

  it("lets an update deactivate a supplier but not a create", () => {
    expect(parseSupplierUpdate({ active: false })).toEqual({ data: { active: false } })
    expect(parseSupplierCreate({ name: "X", active: false })).toEqual({ data: expect.objectContaining({ active: true }) })
  })
})

describe("parseBankAccountRequest", () => {
  const body = { bankName: "TEST Bank", branchCode: "250 655", accountNumber: "6200-0000-001", accountHolder: "TEST Plant Sales" }

  it("normalises the branch code and account number to digits", () => {
    expect(parseBankAccountRequest(body)).toEqual({
      data: { bankName: "TEST Bank", branchCode: "250655", accountNumber: "62000000001", accountHolder: "TEST Plant Sales", accountType: null },
    })
  })

  it.each([
    [{ branchCode: "12345" }, "branchCode"],
    [{ accountNumber: "12ab" }, "accountNumber"],
    [{ accountHolder: " " }, "accountHolder"],
    [{ accountType: "CRYPTO" }, "accountType"],
  ])("rejects %j on %s", (override, field) => {
    const parsed = parseBankAccountRequest({ ...body, ...override })
    expect("errors" in parsed && parsed.errors[field]).toBeTruthy()
  })
})

describe("parseBankAccountDecision", () => {
  it("needs a decision and a note of at least 10 characters", () => {
    expect(parseBankAccountDecision({ decision: "APPROVE", note: "Bank letter dated 2026-10-10" })).toEqual({
      decision: "APPROVE", note: "Bank letter dated 2026-10-10",
    })
    expect(parseBankAccountDecision({ decision: "APPROVE", note: "  ok  " })).toMatch(/verified/)
    expect(parseBankAccountDecision({ decision: "REJECT" })).toMatch(/reason/)
    expect(parseBankAccountDecision({ decision: "MAYBE", note: "long enough note" })).toMatch(/decision/)
    expect(parseBankAccountDecision(null)).toMatch(/JSON object/)
  })
})

describe("supplierAvsNotRun", () => {
  it("records that AVS did not run, why, and the approver's manual evidence; avsPassed stays null", () => {
    const at = new Date("2026-10-13T08:00:00.000Z")
    expect(supplierAvsNotRun({ note: "Bank letter", verifiedById: "user-b", verifiedAt: at })).toEqual({
      avsResult: {
        status: "NOT_RUN",
        reason: SUPPLIER_AVS_NOT_RUN_REASON,
        manualVerification: { note: "Bank letter", verifiedById: "user-b", verifiedAt: "2026-10-13T08:00:00.000Z" },
      },
      avsPassed: null,
    })
  })
})
