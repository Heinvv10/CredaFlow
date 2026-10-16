import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, it, expect, vi } from "vitest"

const { loanFindMany, formProps } = vi.hoisted(() => ({ loanFindMany: vi.fn(), formProps: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { email: "t@example.test" } })) }))
vi.mock("@/lib/session-tenant", () => ({ getPortalTenantId: vi.fn(async () => "t1") }))
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
vi.mock("@/lib/loan/settlement", () => ({ currentSettlementAmount: () => 123_456 }))

import PaymentPage from "./page"
import { formatZAR } from "@/lib/utils"

describe("portal Make Payment", () => {
  it("offers the loans a client can still pay, a loan in default included", async () => {
    loanFindMany.mockResolvedValue([])
    renderToStaticMarkup(await PaymentPage())
    expect(loanFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["ACTIVE", "DEFAULTED"] } }),
    }))
  })

  it("labels a lease's figure rentals outstanding and a loan's settlement (main's English)", async () => {
    const loan = (id: string, reference: string, contractType: string) =>
      ({ id, reference, contractType, interestModel: "AMORTISED", outstandingPrincipal: 100_000, repaymentSchedule: [] })
    loanFindMany.mockResolvedValue([loan("a", "LS-1", "OPERATING_LEASE"), loan("b", "LN-2", "TERM_LOAN")])
    // The per-loan references sit in the payment reference panel.
    for (const [k, v] of Object.entries({ STITCH_BENEFICIARY_NAME: "Acme", STITCH_BANK_NAME: "Test Bank", STITCH_ACCOUNT_NUMBER: "1", STITCH_BRANCH_CODE: "2", STITCH_ACCOUNT_TYPE: "Current" })) vi.stubEnv(k, v)
    const html = renderToStaticMarkup(await PaymentPage()).replace(/<!-- -->/g, "")
    vi.unstubAllEnvs()
    expect(html).toContain(`>${formatZAR(123_456)} rentals outstanding</span>`)
    expect(html).toContain(`>${formatZAR(123_456)} settlement</span>`)
    expect(formProps).toHaveBeenLastCalledWith(expect.objectContaining({
      loans: [expect.objectContaining({ id: "a", lease: true }), expect.objectContaining({ id: "b", lease: false })],
    }))
  })

  it("shows each loan's payment reference prominently, with a copy button, even with no bank panel", async () => {
    loanFindMany.mockResolvedValue([
      { id: "b", reference: "LN-MNSKSZ0Y-GCRU", contractType: "LOAN", interestModel: "REDUCING_BALANCE", outstandingPrincipal: 100_000, repaymentSchedule: [] },
    ])
    const html = renderToStaticMarkup(await PaymentPage()).replace(/<!-- -->/g, "")
    expect(html).not.toContain("Bank Transfer Details")
    expect(html).toContain("Your payment reference")
    expect(html).toContain(">LN-MNSKSZ0Y-GCRU<")
    expect(html).toMatch(/<button[^>]*aria-label="Copy payment reference LN-MNSKSZ0Y-GCRU"/)
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
