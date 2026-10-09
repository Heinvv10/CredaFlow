import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/inbox/settings", () => ({ getCommsSettings: vi.fn() }))
vi.mock("@/lib/whatsapp", () => ({ sendWhatsAppMessage: vi.fn(), isWaEnabled: vi.fn() }))
vi.mock("@/lib/whatsapp-cloud", () => ({ sendWhatsAppCloudMessage: vi.fn() }))

import { getCommsSettings } from "@/lib/inbox/settings"
import { isWaEnabled, sendWhatsAppMessage } from "@/lib/whatsapp"
import { sendWhatsAppCloudMessage } from "@/lib/whatsapp-cloud"
import { sendWhatsAppForTenant } from "./send-for-tenant"

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isWaEnabled).mockReturnValue(true)
  vi.mocked(sendWhatsAppMessage).mockResolvedValue({ ok: true, messageId: "bridge-1" })
  vi.mocked(sendWhatsAppCloudMessage).mockResolvedValue({ ok: true, messageId: "wamid.1" })
})

describe("sendWhatsAppForTenant", () => {
  // Two callers (the payment-reminders cron and the
  // section129_sent courtesy notification) must not call the Baileys bridge directly,
  // with no reference to CommsSettings.waProvider. Under WA_CLOUD
  // that is a transport nothing routes through — the bridge has no numbers
  // paired — so those sends fail regardless of how many Meta templates are
  // approved. Registering templates cannot fix a caller that never asks Meta.
  it("routes to the Cloud API when the tenant is on WA_CLOUD", async () => {
    vi.mocked(getCommsSettings).mockResolvedValue({ waProvider: "WA_CLOUD" } as never)

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
    vi.mocked(getCommsSettings).mockResolvedValue({ waProvider: "WA_UNOFFICIAL" } as never)

    const r = await sendWhatsAppForTenant({ tenantId: "tn1", to: "27821234567", message: "hi" })

    expect(sendWhatsAppMessage).toHaveBeenCalledWith({ to: "27821234567", message: "hi", signal: undefined })
    expect(sendWhatsAppCloudMessage).not.toHaveBeenCalled()
    expect(r).toEqual({ ok: true, messageId: "bridge-1" })
  })

  // The contact is what lets the Cloud sender read the 24h service window.
  // Dropping it makes every send resolve to a null window and fail with
  // WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE even when the customer wrote minutes ago.
  it("forwards contactId so the 24h window can be read", async () => {
    vi.mocked(getCommsSettings).mockResolvedValue({ waProvider: "WA_CLOUD" } as never)
    await sendWhatsAppForTenant({ tenantId: "tn1", to: "27821234567", message: "hi", contactId: "ct9" })
    expect(vi.mocked(sendWhatsAppCloudMessage).mock.calls[0][0].contactId).toBe("ct9")
  })

  // Never throws: both callers inspect a WaResult and one of them writes an
  // audit LoanNote from it. A throw would be recorded as "not sent" by one
  // caller and crash the cron for every later loan in the batch.
  it("degrades to a rejected WaResult rather than throwing when settings are unreadable", async () => {
    vi.mocked(getCommsSettings).mockRejectedValue(new Error("db down"))

    const r = await sendWhatsAppForTenant({ tenantId: "tn1", to: "27821234567", message: "hi" })

    expect(r.ok).toBe(false)
    expect(r.providerOutcome).toBe("DEFINITELY_REJECTED")
    expect(sendWhatsAppMessage).not.toHaveBeenCalled()
    expect(sendWhatsAppCloudMessage).not.toHaveBeenCalled()
  })

  // The env kill-switch comes free from inside sendWhatsAppMessage.
  // sendWhatsAppCloudMessage has no equivalent, so without this check routing
  // to Cloud silently bypasses WA_ENABLED — on every non-client container,
  // non-production ones included. A non-production DB restored from a production
  // backup would then send real WhatsApp messages to real borrowers.
  it("honours the WA_ENABLED kill-switch on BOTH providers", async () => {
    vi.mocked(isWaEnabled).mockReturnValue(false)

    for (const waProvider of ["WA_CLOUD", "WA_UNOFFICIAL"]) {
      vi.mocked(getCommsSettings).mockResolvedValue({ waProvider } as never)
      const r = await sendWhatsAppForTenant({ tenantId: "tn1", to: "27821234567", message: "hi" })
      expect(r.ok, waProvider).toBe(false)
    }
    expect(sendWhatsAppCloudMessage).not.toHaveBeenCalled()
    expect(sendWhatsAppMessage).not.toHaveBeenCalled()
  })
})
