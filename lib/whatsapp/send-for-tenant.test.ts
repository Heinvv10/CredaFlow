import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/inbox/settings", () => ({ getCommsSettings: vi.fn() }))
vi.mock("@/lib/whatsapp", () => ({ sendWhatsAppMessage: vi.fn() }))
vi.mock("@/lib/whatsapp-cloud", () => ({ sendWhatsAppCloudMessage: vi.fn() }))

import { getCommsSettings } from "@/lib/inbox/settings"
import { sendWhatsAppMessage } from "@/lib/whatsapp"
import { sendWhatsAppCloudMessage } from "@/lib/whatsapp-cloud"
import { classifyError } from "@/lib/messaging/retry"
import { sendWhatsAppForTenant } from "./send-for-tenant"

beforeEach(() => {
  vi.clearAllMocks()
  // Isolated from the runner's environment: the routing tests assume the
  // WhatsApp env switch is not vetoing (WA_ENABLED unset defers to the tenant).
  vi.stubEnv("WA_ENABLED", undefined)
  vi.mocked(sendWhatsAppMessage).mockResolvedValue({ ok: true, messageId: "bridge-1" })
  vi.mocked(sendWhatsAppCloudMessage).mockResolvedValue({ ok: true, messageId: "wamid.1" })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("sendWhatsAppForTenant", () => {
  // Two callers (the payment-reminders cron and the
  // section129_sent courtesy notification) must not call the Baileys bridge directly,
  // with no reference to CommsSettings.waProvider. Under WA_CLOUD
  // that is a transport nothing routes through — the bridge has no numbers
  // paired — so those sends fail regardless of how many Meta templates are
  // approved. Registering templates cannot fix a caller that never asks Meta.
  it("routes to the Cloud API when the tenant is on WA_CLOUD", async () => {
    vi.mocked(getCommsSettings).mockResolvedValue({ waProvider: "WA_CLOUD", whatsappEnabled: true } as never)

    const r = await sendWhatsAppForTenant({
      tenantId: "tn1", to: "27821234567", message: "hi", contactId: "ct1",
    })

    expect(sendWhatsAppCloudMessage).toHaveBeenCalledWith({
      tenantId: "tn1", to: "27821234567", message: "hi", contactId: "ct1", signal: undefined,
    })
    expect(sendWhatsAppMessage).not.toHaveBeenCalled()
    expect(r).toEqual({ ok: true, messageId: "wamid.1" })
  })

  it("routes to the bridge when the tenant is still on WA_UNOFFICIAL", async () => {
    vi.mocked(getCommsSettings).mockResolvedValue({ waProvider: "WA_UNOFFICIAL", whatsappEnabled: true } as never)

    const r = await sendWhatsAppForTenant({ tenantId: "tn1", to: "27821234567", message: "hi" })

    expect(sendWhatsAppMessage).toHaveBeenCalledWith({ to: "27821234567", message: "hi", signal: undefined })
    expect(sendWhatsAppCloudMessage).not.toHaveBeenCalled()
    expect(r).toEqual({ ok: true, messageId: "bridge-1" })
  })

  // The contact is what lets the Cloud sender read the 24h service window.
  // Dropping it makes every send resolve to a null window and fail with
  // WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE even when the customer wrote minutes ago.
  it("forwards contactId so the 24h window can be read", async () => {
    vi.mocked(getCommsSettings).mockResolvedValue({ waProvider: "WA_CLOUD", whatsappEnabled: true } as never)
    await sendWhatsAppForTenant({ tenantId: "tn1", to: "27821234567", message: "hi", contactId: "ct9" })
    expect(vi.mocked(sendWhatsAppCloudMessage).mock.calls[0][0].contactId).toBe("ct9")
  })

  // Never throws: both callers inspect a WaResult and one of them writes an
  // audit LoanNote from it. A throw would be recorded as "not sent" by one
  // caller and crash the cron for every later loan in the batch.
  it("degrades to a rejected WaResult rather than throwing when settings are unreadable", async () => {
    vi.mocked(getCommsSettings).mockRejectedValue(new Error("db down at 10.0.0.5"))

    const r = await sendWhatsAppForTenant({ tenantId: "tn1", to: "27821234567", message: "hi" })

    expect(r.ok).toBe(false)
    expect(r.providerOutcome).toBe("DEFINITELY_REJECTED")
    // A blip is transient: not "disabled", no exception text in the stored error.
    expect(r.error).not.toMatch(/whatsapp\s+disabled/i)
    expect(r.error).not.toMatch(/db down|10\.0\.0\.5/)
    expect(classifyError(new Error(r.error), "WA_CLOUD")).toBe("TRANSIENT")
    expect(sendWhatsAppMessage).not.toHaveBeenCalled()
    expect(sendWhatsAppCloudMessage).not.toHaveBeenCalled()
  })

  // Cloud-only lenders never set WA_ENABLED. Unset must therefore NOT refuse:
  // they get the s129 courtesy and the cron reminders as long as the tenant
  // switch is on.
  it("sends over Cloud when WA_ENABLED is unset and the tenant has whatsappEnabled", async () => {
    vi.mocked(getCommsSettings).mockResolvedValue({ waProvider: "WA_CLOUD", whatsappEnabled: true } as never)
    const r = await sendWhatsAppForTenant({ tenantId: "tn1", to: "27821234567", message: "hi" })
    expect(r.ok).toBe(true)
    expect(sendWhatsAppCloudMessage).toHaveBeenCalledOnce()
  })

  it("honours the WA_ENABLED=false kill-switch on BOTH providers, before reading settings", async () => {
    vi.stubEnv("WA_ENABLED", "false")

    for (const waProvider of ["WA_CLOUD", "WA_UNOFFICIAL"]) {
      vi.mocked(getCommsSettings).mockResolvedValue({ waProvider, whatsappEnabled: true } as never)
      const r = await sendWhatsAppForTenant({ tenantId: "tn1", to: "27821234567", message: "hi" })
      expect(r.ok, waProvider).toBe(false)
      expect(classifyError(new Error(r.error), "WA_CLOUD")).toBe("PERMANENT")
    }
    expect(getCommsSettings).not.toHaveBeenCalled()
    expect(sendWhatsAppCloudMessage).not.toHaveBeenCalled()
    expect(sendWhatsAppMessage).not.toHaveBeenCalled()
  })
})

// F4: the s129 courtesy notification and payment-reminders both land here. The
// tenant's own WhatsApp switch must stop them on either provider.
describe("sendWhatsAppForTenant kill switches", () => {
  it("refuses both providers when the tenant has whatsappEnabled=false", async () => {
    for (const waProvider of ["WA_CLOUD", "WA_UNOFFICIAL"]) {
      vi.mocked(getCommsSettings).mockResolvedValue({ waProvider, whatsappEnabled: false } as never)
      const r = await sendWhatsAppForTenant({ tenantId: "tn1", to: "27821234567", message: "hi" })
      expect(r.ok, waProvider).toBe(false)
      expect(r.providerOutcome, waProvider).toBe("DEFINITELY_REJECTED")
      expect(r.error, waProvider).toMatch(/whatsapp\s+disabled/i)
    }
    expect(sendWhatsAppCloudMessage).not.toHaveBeenCalled()
    expect(sendWhatsAppMessage).not.toHaveBeenCalled()
  })

  it("refuses Cloud when WA_ENABLED is empty, even though the tenant switch is on", async () => {
    vi.stubEnv("WA_ENABLED", "")
    vi.mocked(getCommsSettings).mockResolvedValue({ waProvider: "WA_CLOUD", whatsappEnabled: true } as never)
    const r = await sendWhatsAppForTenant({ tenantId: "tn1", to: "27821234567", message: "hi" })
    expect(r.ok).toBe(false)
    expect(sendWhatsAppCloudMessage).not.toHaveBeenCalled()
  })
})
