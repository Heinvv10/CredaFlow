import { describe, expect, it } from "vitest"
import { isValueAction, maskValue } from "./minimise"

describe("SIEM minimisation", () => {
  it("allows values only for security and configuration actions", () => {
    for (const a of ["SECURITY_LOGIN_FAILED", "AUDIT_POLICY_UPDATED", "USER_UPDATED", "TOTP_RESET_BY_ADMIN", "STAFF_ACCESS_REFUSED", "TENANT_SUSPENDED"]) expect(isValueAction(a), a).toBe(true)
    for (const a of ["LOAN_APPROVED", "CLIENT_UPDATED", "PAYMENT_CAPTURED", "CREDIT_CHECK_RUN", "USER_PASSWORD_VIEWED", "BANK_ACCOUNT_CHANGED"]) expect(isValueAction(a), a).toBe(false)
  })

  it("masks identity numbers, bank accounts, income, credentials and contact details by field name", () => {
    expect(maskValue({
      role: "ADMIN", idNumber: "8001015009087", bankAccountNumber: "62000000000", monthlyIncome: 25000, apiToken: "abc", password: "x",
      email: "a@b.invalid", phone: "0820000000", fullName: "A B", nested: { accountHolder: "A B", ok: true },
    })).toEqual({
      role: "ADMIN", idNumber: "[masked]", bankAccountNumber: "[masked]", monthlyIncome: "[masked]", apiToken: "[masked]", password: "[masked]",
      email: "[masked]", phone: "[masked]", fullName: "[masked]", nested: { accountHolder: "[masked]", ok: true },
    })
  })

  it("masks long digit runs inside free text, whatever the field is called", () => {
    expect(maskValue({ note: "customer 8001015009087 asked", ref: "LN-2026-1" })).toEqual({ note: "customer [masked] asked", ref: "LN-2026-1" })
  })

  it("leaves a hash alone", () => {
    const h = "6e63e9dc359b1234567890ecc4d8671cfdca1234567890e21a1b0deb042d4b15"
    expect(maskValue({ rowHash: h })).toEqual({ rowHash: h })
  })

  it("bounds depth, list length and string length", () => {
    const deep = maskValue({ a: { b: { c: { d: { e: 1 } } } } }) as { a: { b: { c: { d: unknown } } } }
    expect(deep.a.b.c.d).toBe("[masked]")
    expect((maskValue({ list: Array.from({ length: 50 }, (_, i) => i) }) as { list: unknown[] }).list).toHaveLength(20)
    expect((maskValue({ text: "y".repeat(500) }) as { text: string }).text.length).toBeLessThan(210)
  })
})
