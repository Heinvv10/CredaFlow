import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { commsSettingsFindUnique } = vi.hoisted(() => ({ commsSettingsFindUnique: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { commsSettings: { findUnique: commsSettingsFindUnique } } }))

import { availableOtpChannels, isWhatsAppCloudConfigured } from "./deliver"

const cloud = { whatsappEnabled: true, waProvider: "WA_CLOUD", wabaPhoneNumberId: "pn-1", wabaAccessToken: "sealed" }
const recipient = { firstName: "Thandi", lastName: "Test", email: "thandi@example.test", whatsapp: "0820000001" }

beforeEach(() => {
  commsSettingsFindUnique.mockResolvedValue(cloud)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

// A code must never be offered on a channel that will refuse it, or it
// silently never arrives. The picker honours the process-level switch as well
// as the tenant's own.
describe("isWhatsAppCloudConfigured", () => {
  it("is true for an enabled Cloud lender with credentials and WA_ENABLED unset", async () => {
    vi.stubEnv("WA_ENABLED", undefined)
    await expect(isWhatsAppCloudConfigured("tn1")).resolves.toBe(true)
  })

  it.each(["false", "", " FALSE "])("is false when WA_ENABLED=%j, without reading the database", async (value) => {
    vi.stubEnv("WA_ENABLED", value)
    await expect(isWhatsAppCloudConfigured("tn1")).resolves.toBe(false)
    expect(commsSettingsFindUnique).not.toHaveBeenCalled()
  })

  it("is false when the tenant switch is off", async () => {
    commsSettingsFindUnique.mockResolvedValue({ ...cloud, whatsappEnabled: false })
    await expect(isWhatsAppCloudConfigured("tn1")).resolves.toBe(false)
  })
})

describe("availableOtpChannels", () => {
  it("offers email only when WA_ENABLED=false, so the email fallback is what the user gets", async () => {
    vi.stubEnv("WA_ENABLED", "false")
    await expect(availableOtpChannels("tn1", recipient)).resolves.toEqual(["EMAIL"])
  })

  it("offers WhatsApp too when nothing vetoes it", async () => {
    vi.stubEnv("WA_ENABLED", undefined)
    await expect(availableOtpChannels("tn1", recipient)).resolves.toEqual(["EMAIL", "WHATSAPP"])
  })
})
