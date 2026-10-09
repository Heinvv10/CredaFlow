import { describe, it, expect, vi, beforeEach } from "vitest"

const requireApiRoleMock = vi.fn()
const sendForTenantMock = vi.fn()
const sendBridgeMock = vi.fn()
const lookupContactMock = vi.fn()
const availabilityMock = vi.fn()
const getCommsSettingsMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (...a: unknown[]) => requireApiRoleMock(...a) }))
vi.mock("@/lib/whatsapp/send-for-tenant", () => ({
  sendWhatsAppForTenant: (...a: unknown[]) => sendForTenantMock(...a),
}))
// Deliberately NOT wired to the same mock: reaching the bridge sender from this
// route is the defect under test, so the two must be distinguishable.
vi.mock("@/lib/whatsapp", () => ({ sendWhatsAppMessage: (...a: unknown[]) => sendBridgeMock(...a) }))
vi.mock("@/lib/contact/identity", async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return { ...real, lookupContactByChannelValue: (...a: unknown[]) => lookupContactMock(...a) }
})
vi.mock("@/lib/messaging/channel-availability", () => ({
  getChannelAvailability: (...a: unknown[]) => availabilityMock(...a),
}))
vi.mock("@/lib/inbox/settings", () => ({ getCommsSettings: (...a: unknown[]) => getCommsSettingsMock(...a) }))
vi.mock("@/lib/config/identity", () => ({ getLenderBrandName: async () => "Acme Lending" }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { POST } from "./route"

function req(body: unknown) {
  return new Request("http://x/api/settings/whatsapp/test", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

const CONTACT = { id: "ct1", tenantId: "tn-session" }

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { tenantId: "tn-session", role: "ADMIN" } })
  getCommsSettingsMock.mockResolvedValue({ whatsappEnabled: true })
  lookupContactMock.mockResolvedValue(CONTACT)
  availabilityMock.mockResolvedValue({ WHATSAPP: { enabled: true, toValue: "27821234567" } })
  sendForTenantMock.mockResolvedValue({ ok: true, messageId: "wamid.test" })
})

describe("POST /api/settings/whatsapp/test", () => {
  it("requires ADMIN — the floor itself, not just that a guard ran", async () => {
    await POST(req({ phone: "27821234567" }))
    expect(requireApiRoleMock).toHaveBeenCalledWith("ADMIN")
  })

  // The defect this route was rewritten for: it called the Baileys bridge
  // unconditionally, so on a WA_CLOUD tenant it reported "bridge not connected
  // to WhatsApp" — a false outage produced by probing a transport the tenant
  // no longer uses.
  it("tests the tenant's configured provider, not the bridge", async () => {
    const res = await POST(req({ phone: "27821234567" }))
    expect(res.status).toBe(200)
    expect(sendBridgeMock).not.toHaveBeenCalled()
    expect(sendForTenantMock).toHaveBeenCalled()
  })

  // Uses the SESSION's tenant. getDefaultTenantId() resolves from the
  // build-baked NEXT_PUBLIC_TENANT_SLUG, so an admin of tenant B would have
  // sent using tenant A's WABA credentials and access token.
  it("sends as the CALLER's tenant, never a build-baked default", async () => {
    await POST(req({ phone: "27821234567" }))
    expect(sendForTenantMock.mock.calls[0][0].tenantId).toBe("tn-session")
    expect(lookupContactMock.mock.calls[0][1].tenantId).toBe("tn-session")
  })

  // Without contactId the Cloud sender reads a null 24h window and returns
  // WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE before making any HTTP request to Meta —
  // so the button could never succeed, for any number, ever.
  it("passes contactId so the 24h window can actually be read", async () => {
    await POST(req({ phone: "27821234567" }))
    expect(sendForTenantMock.mock.calls[0][0].contactId).toBe("ct1")
  })

  it("returns ok, messageId and simulated — the client branches on simulated", async () => {
    sendForTenantMock.mockResolvedValue({ ok: true, messageId: "dry-1", simulated: true })
    const body = await (await POST(req({ phone: "27821234567" }))).json()
    // Dropping `simulated` renders a green "Sent!" for a message never sent.
    expect(body).toMatchObject({ ok: true, messageId: "dry-1", simulated: true })
  })

  it("refuses a number with no contact record, and says why", async () => {
    lookupContactMock.mockResolvedValue(null)
    const res = await POST(req({ phone: "27829999999" }))
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/no contact record/i)
    expect(sendForTenantMock).not.toHaveBeenCalled()
  })

  // A diagnostic must not be a way around consent. getChannelAvailability is
  // the repo's gate for do-not-contact, revoked SERVICE_COMMS consent, and the
  // per-tenant whatsappEnabled switch — none of which the env WA_ENABLED check
  // inside the sender covers.
  it("honours do-not-contact / opt-out / the tenant's WhatsApp switch", async () => {
    availabilityMock.mockResolvedValue({
      WHATSAPP: { enabled: false, reason: "Client opted out" },
    })
    const res = await POST(req({ phone: "27821234567" }))
    expect(res.status).toBe(422)
    expect((await res.json()).error).toContain("Client opted out")
    expect(sendForTenantMock).not.toHaveBeenCalled()
  })

  it("surfaces the provider's own error rather than a generic failure", async () => {
    sendForTenantMock.mockResolvedValue({
      ok: false,
      error: "WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE",
      providerOutcome: "DEFINITELY_REJECTED",
    })
    const res = await POST(req({ phone: "27821234567" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain("WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE")
  })

  it("422s on a missing or non-string phone", async () => {
    expect((await POST(req({}))).status).toBe(422)
    expect((await POST(req({ phone: 27821234567 }))).status).toBe(422)
    expect(sendForTenantMock).not.toHaveBeenCalled()
  })

  it("refuses a caller below ADMIN", async () => {
    requireApiRoleMock.mockResolvedValue({ error: new Response(null, { status: 403 }) })
    const res = await POST(req({ phone: "27821234567" }))
    expect(res.status).toBe(403)
    expect(sendForTenantMock).not.toHaveBeenCalled()
  })
})
