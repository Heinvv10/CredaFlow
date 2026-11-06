import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { tenantConfigFindUnique, tenantFindUnique } = vi.hoisted(() => ({
  tenantConfigFindUnique: vi.fn(),
  tenantFindUnique: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: { tenantConfig: { findUnique: tenantConfigFindUnique }, tenant: { findUnique: tenantFindUnique } },
}))

import { createStitchPayment, loadStitchAccount, loadStitchWebhookSecret, StitchCurrencyError, stitchConfigured, stitchCurrencyRefusal } from "./stitch"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"

// The STITCH_* environment is one lender's Stitch account: it serves only the
// tenant ENV_CREDENTIALS_TENANT_SLUG names, whatever the other tenants' statuses.
describe("Stitch environment fallback", () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries({
      STITCH_CLIENT_ID: "env-client", STITCH_CLIENT_SECRET: "env-secret", STITCH_WEBHOOK_SECRET: "env-whsec",
      STITCH_BENEFICIARY_NAME: "Synthetic Lender", STITCH_BANK_ID: "synthetic-bank",
      STITCH_ACCOUNT_NUMBER: "0000000000", STITCH_BRANCH_CODE: "000000",
      ENV_CREDENTIALS_TENANT_SLUG: "lender-a",
    })) vi.stubEnv(k, v)
    tenantConfigFindUnique.mockReset().mockResolvedValue(null)
    tenantFindUnique.mockReset().mockResolvedValue({ id: "tA" })
  })
  afterEach(() => vi.unstubAllEnvs())

  it("serves the named tenant", async () => {
    expect(await loadStitchWebhookSecret("tA")).toBe("env-whsec")
    expect((await loadStitchAccount("tA")).beneficiary.accountNumber).toBe("0000000000")
  })

  it("never serves another tenant: A suspended and B the only ACTIVE one, B gets nothing of A's", async () => {
    expect(await loadStitchWebhookSecret("tB")).toBeNull()
    await expect(loadStitchAccount("tB")).rejects.toThrow(/not configured for this lender/)
  })

  it("serves no one when no owner is named", async () => {
    vi.stubEnv("ENV_CREDENTIALS_TENANT_SLUG", "")
    expect(await loadStitchWebhookSecret("tA")).toBeNull()
    await expect(loadStitchAccount("tA")).rejects.toThrow(/not configured for this lender/)
  })
})

describe("stitchConfigured", () => {
  beforeEach(() => {
    vi.stubEnv("ENV_CREDENTIALS_TENANT_SLUG", "")
    tenantConfigFindUnique.mockReset().mockResolvedValue(null)
    tenantFindUnique.mockReset().mockResolvedValue({ id: "tA" })
  })
  afterEach(() => vi.unstubAllEnvs())

  it("is false for a lender with no Stitch account", async () => {
    expect(await stitchConfigured("tA")).toBe(false)
  })

  it("is false when the beneficiary account is incomplete", async () => {
    for (const [k, v] of Object.entries({
      ENV_CREDENTIALS_TENANT_SLUG: "lender-a", STITCH_CLIENT_ID: "env-client", STITCH_CLIENT_SECRET: "env-secret",
      STITCH_BENEFICIARY_NAME: "", STITCH_BANK_ID: "", STITCH_ACCOUNT_NUMBER: "", STITCH_BRANCH_CODE: "",
    })) vi.stubEnv(k, v)
    expect(await stitchConfigured("tA")).toBe(false)
  })

  it("is true when the account is complete", async () => {
    for (const [k, v] of Object.entries({
      ENV_CREDENTIALS_TENANT_SLUG: "lender-a", STITCH_CLIENT_ID: "env-client", STITCH_CLIENT_SECRET: "env-secret",
      STITCH_BENEFICIARY_NAME: "Synthetic Lender", STITCH_BANK_ID: "synthetic-bank",
      STITCH_ACCOUNT_NUMBER: "0000000000", STITCH_BRANCH_CODE: "000000",
    })) vi.stubEnv(k, v)
    expect(await stitchConfigured("tA")).toBe(true)
  })

  it("does not hide a database failure as 'not configured'", async () => {
    tenantConfigFindUnique.mockRejectedValue(new Error("connection reset"))
    await expect(stitchConfigured("tA")).rejects.toThrow("connection reset")
  })
})

// Stitch settles in rand. A loti amount is the same number of rand (pegged 1:1); a shilling
// amount is not, and must never be sent as rand.
describe("the currency Stitch collects in", () => {
  afterEach(() => { resetActiveJurisdiction(); vi.unstubAllGlobals() })

  it("rand and loti are collected; shillings are refused", () => {
    expect(stitchCurrencyRefusal("ZAR")).toBeNull()
    expect(stitchCurrencyRefusal("LSL")).toBeNull()
    expect(stitchCurrencyRefusal("KES")).toMatch(/rand.*KES/)
  })

  it("follows the lender's currency", () => {
    expect(stitchCurrencyRefusal()).toBeNull()
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    expect(stitchCurrencyRefusal()).toBeNull()
    setActiveJurisdiction({ jurisdiction: "KE", currency: "KES" })
    expect(stitchCurrencyRefusal()).not.toBeNull()
  })

  it("a Kenyan lender's payment is refused before the account is read or Stitch is called", async () => {
    setActiveJurisdiction({ jurisdiction: "KE", currency: "KES" })
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    tenantConfigFindUnique.mockReset()
    const paying = createStitchPayment("tA", { amountRands: 100, payerReference: "LN-1", beneficiaryReference: "LN-1", externalReference: "PAY-1", redirectUrl: "https://x.invalid/cb" })
    await expect(paying).rejects.toBeInstanceOf(StitchCurrencyError)
    expect(tenantConfigFindUnique).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
