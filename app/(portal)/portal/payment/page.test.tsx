import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, it, expect, vi } from "vitest"

const { loanFindMany, formProps } = vi.hoisted(() => ({ loanFindMany: vi.fn(), formProps: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { email: "t@example.test" } })) }))
vi.mock("@/lib/tenant", () => ({
  getDefaultTenantId: vi.fn(async () => "t1"),
  getResolvedTenantId: vi.fn(async () => "t1"),
}))
vi.mock("@/lib/config/identity", () => ({
  getLenderIdentity: vi.fn(async () => ({
    tradingName: "Acme Lending",
    legalName: "Acme Lending (Pty) Ltd",
    publicEmail: "hello@acme-lending.example",
    publicPhone: "+27 11 000 0000",
    publicPhoneE164: "+27110000000",
  })),
}))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: { client: { findFirst: vi.fn(async () => ({ id: "c1" })) }, loan: { findMany: loanFindMany } },
}))
vi.mock("@/lib/portal/loan-charges", () => ({
  portalLoanCharges: vi.fn(async () => ({ outstanding: 0, lines: [], settlementAmount: null })),
}))
vi.mock("@/components/portal/StitchPaymentForm", () => ({
  StitchPaymentForm: (props: unknown) => { formProps(props); return null },
}))
vi.mock("@/components/portal/ManualPaymentForm", () => ({ ManualPaymentForm: () => null }))

import PaymentPage from "./page"

describe("portal Make Payment", () => {
  it("offers the loans a client can still pay, a loan in default included", async () => {
    loanFindMany.mockResolvedValue([])
    renderToStaticMarkup(await PaymentPage())
    expect(loanFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["ACTIVE", "DEFAULTED"] } }),
    }))
  })

  describe("bank transfer panel", () => {
    const BANK_ENV = {
      STITCH_BENEFICIARY_NAME: "Acme Collections Account",
      STITCH_BANK_NAME: "Test Bank",
      STITCH_ACCOUNT_NUMBER: "1234567890",
      STITCH_BRANCH_CODE: "111222",
      STITCH_ACCOUNT_TYPE: "Current",
    }
    afterEach(() => vi.unstubAllEnvs())

    async function html() {
      loanFindMany.mockResolvedValue([])
      return renderToStaticMarkup(await PaymentPage())
    }

    it("shows every bank detail, with the Stitch beneficiary as account name, when all are configured", async () => {
      for (const [k, v] of Object.entries(BANK_ENV)) vi.stubEnv(k, v)
      const out = await html()
      expect(out).toContain("Bank Transfer Details")
      expect(out).toContain("Acme Collections Account")
      for (const v of Object.values(BANK_ENV)) expect(out).toContain(v)
    })

    it.each(Object.keys(BANK_ENV))("hides the whole panel when %s is unset", async (missing) => {
      for (const [k, v] of Object.entries(BANK_ENV)) vi.stubEnv(k, k === missing ? "" : v)
      expect(await html()).not.toContain("Bank Transfer Details")
    })

    it("prints the lender's own contact details", async () => {
      const out = await html()
      expect(out).toContain("hello@acme-lending.example")
      expect(out).toContain("+27 11 000 0000")
    })
  })
})
