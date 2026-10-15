import { describe, expect, it, vi } from "vitest"
import { parseRefundForm } from "./recovery-refund-input"

// The upload checks live beside the session helper, which this suite does not exercise.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const pdf = () => new File([new Uint8Array(Buffer.from("%PDF-1.4 synthetic"))], "confirmation.pdf", { type: "application/pdf" })
const request = (fields: Record<string, string>, file: File | null = pdf()) => {
  const form = new FormData()
  for (const [key, value] of Object.entries({ accountHolder: "TEST Debtor", bankName: "TEST Bank", branchCode: "250 655", accountNumber: "6200-0000-001", docType: "BANK_STATEMENT", ...fields })) form.set(key, value)
  if (file) form.set("file", file)
  return new Request("http://localhost/refund", { method: "POST", body: form })
}

describe("parseRefundForm", () => {
  it("reads the account like a supplier's (spaces and dashes dropped) and the evidence upload", async () => {
    const parsed = await parseRefundForm(request({}))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.bank).toMatchObject({ accountHolder: "TEST Debtor", bankName: "TEST Bank", branchCode: "250655", accountNumber: "62000000001" })
    expect(parsed.upload).toMatchObject({ docType: "BANK_STATEMENT", dealId: null })
  })

  it.each([
    ["a branch code that is not six digits", { branchCode: "12345" }, /branchCode/],
    ["an account number that is not numeric", { accountNumber: "12ab" }, /accountNumber/],
    ["a blank account holder", { accountHolder: " " }, /accountHolder/],
    ["an evidence type that is not a bank document", { docType: "CIPC_REGISTRATION" }, /docType/],
  ])("refuses %s", async (_label, fields, message) => {
    const parsed = await parseRefundForm(request(fields))
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.error).toMatch(message)
  })

  it("refuses a request with no evidence file, or a file that is not what it says", async () => {
    const none = await parseRefundForm(request({}, null))
    expect(none.ok === false && none.error).toMatch(/file/)
    const disguised = await parseRefundForm(request({}, new File([new Uint8Array(Buffer.from("not a pdf at all"))], "x.pdf", { type: "application/pdf" })))
    expect(disguised.ok === false && disguised.error).toMatch(/does not match/)
  })
})
