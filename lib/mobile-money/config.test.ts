import { afterEach, describe, expect, it, vi } from "vitest"
import { mpesaPaybill, stkPushAvailable } from "./config"
import { mobileMoneyCaptureOffered } from "./label"

afterEach(() => { vi.unstubAllEnvs() })

describe("mpesaPaybill", () => {
  it("is the configured paybill number, trimmed", () => {
    vi.stubEnv("MPESA_PAYBILL_SHORTCODE", " 600100 ")
    expect(mpesaPaybill()).toBe("600100")
  })

  it("is null when unset, blank or not a paybill number: never a placeholder", () => {
    for (const value of ["", "   ", "PAYBILL", "12", "123456789"]) {
      vi.stubEnv("MPESA_PAYBILL_SHORTCODE", value)
      expect(mpesaPaybill(), value).toBeNull()
    }
  })
})

describe("stkPushAvailable", () => {
  it("needs the paybill", () => {
    vi.stubEnv("MPESA_PAYBILL_SHORTCODE", "")
    expect(stkPushAvailable()).toBe(false)
    vi.stubEnv("MPESA_PAYBILL_SHORTCODE", "600100")
    expect(stkPushAvailable()).toBe(true)
  })

  it("is off on a deployed build that does not permit the simulated provider", () => {
    vi.stubEnv("MPESA_PAYBILL_SHORTCODE", "600100")
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "")
    expect(stkPushAvailable()).toBe(false)
    vi.stubEnv("SIMULATED_INTEGRATIONS", "simulated-mpesa")
    expect(stkPushAvailable()).toBe(true)
  })
})

describe("mobileMoneyCaptureOffered", () => {
  it("offers M-Pesa capture to a Kenyan lender only", () => {
    expect(mobileMoneyCaptureOffered("KE")).toBe(true)
    expect(mobileMoneyCaptureOffered("ZA")).toBe(false)
    expect(mobileMoneyCaptureOffered("LS")).toBe(false)
  })
})
