import { describe, expect, it } from "vitest"
import { parseAssetFinanceSettings, parseVatConfig } from "./settings-input"

describe("parseAssetFinanceSettings", () => {
  it("accepts the switch and the threshold, alone or together", () => {
    expect(parseAssetFinanceSettings({ featureAssetFinance: true })).toEqual({ data: { featureAssetFinance: true } })
    expect(parseAssetFinanceSettings({ assetPayoutDualApprovalCents: 0 })).toEqual({ data: { assetPayoutDualApprovalCents: 0 } })
    expect(parseAssetFinanceSettings({ featureAssetFinance: false, assetPayoutDualApprovalCents: 50_000_000 }))
      .toEqual({ data: { featureAssetFinance: false, assetPayoutDualApprovalCents: 50_000_000 } })
  })

  it("refuses the legal-wording Confirmation Gate, even alongside valid fields", () => {
    const parsed = parseAssetFinanceSettings({ featureAssetFinance: true, assetFinanceLegalWordingApproved: true })
    expect(parsed).toEqual({ errors: { assetFinanceLegalWordingApproved: expect.stringMatching(/set by CredaFlow/) } })
  })

  it.each([
    [{ featureAssetFinance: "true" }, "featureAssetFinance"],
    [{ assetPayoutDualApprovalCents: -1 }, "assetPayoutDualApprovalCents"],
    [{ assetPayoutDualApprovalCents: 1.5 }, "assetPayoutDualApprovalCents"],
    [{ assetPayoutDualApprovalCents: "100" }, "assetPayoutDualApprovalCents"],
    [{ assetPayoutDualApprovalCents: 2_147_483_648 }, "assetPayoutDualApprovalCents"],
    [{}, "body"],
    [null, "body"],
  ])("refuses %j on %s", (body, field) => {
    const parsed = parseAssetFinanceSettings(body)
    expect("errors" in parsed && parsed.errors[field]).toBeTruthy()
  })
})

describe("parseVatConfig", () => {
  const ok = { vatNumber: "4123456789", registeredName: "TEST Lender (Pty) Ltd", address: "1 Test Street, Testville" }

  it("accepts a ten-digit number starting with 4, ignoring spaces, and trims the text", () => {
    expect(parseVatConfig({ ...ok, vatNumber: "4123 456 789", registeredName: "  TEST Lender (Pty) Ltd " }))
      .toEqual({ data: ok })
  })

  it.each(["5123456789", "412345678", "41234567890", "41234S6789", ""])("refuses VAT number %j", (vatNumber) => {
    const parsed = parseVatConfig({ ...ok, vatNumber })
    expect("errors" in parsed && parsed.errors.vatNumber).toMatch(/ten digits starting with 4/)
  })

  it("requires the registered name and address", () => {
    const parsed = parseVatConfig({ vatNumber: ok.vatNumber, registeredName: " ", address: "x".repeat(501) })
    expect(parsed).toEqual({ errors: { registeredName: "is required", address: "must be at most 500 characters" } })
  })
})
