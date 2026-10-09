import { afterEach, describe, it, expect, vi } from "vitest"

vi.mock("./whatsapp-cloud-config", () => ({
  getWabaCreds: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: { contact: { findFirst: vi.fn() } },
}))

import { getWabaCreds } from "./whatsapp-cloud-config"
import { prisma } from "@/lib/prisma"
import { sendWhatsAppCloudMessage } from "./whatsapp-cloud"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function stubCreds() {
  vi.mocked(getWabaCreds).mockResolvedValue({ phoneNumberId: "PN1", accessToken: "TOK" })
}

function stubWithinWindowContact() {
  vi.mocked(prisma.contact.findFirst).mockResolvedValue({
    lastInboundAtByChannel: { WHATSAPP: new Date(Date.now() - 3600_000).toISOString() },
  } as never)
}

describe("sendWhatsAppCloudMessage", () => {
  it("returns a fresh dry-run id in test env without calling fetch or loading creds", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const a = await sendWhatsAppCloudMessage({ tenantId: "tn1", to: "27821234567", message: "hi" })
    const b = await sendWhatsAppCloudMessage({ tenantId: "tn1", to: "27821234567", message: "hi" })
    expect(a.ok).toBe(true)
    expect(a.simulated).toBe(true)
    expect(a.messageId).toMatch(/^dry-run-/)
    expect(a.messageId).not.toBe(b.messageId)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(getWabaCreds).not.toHaveBeenCalled()
  })

  it("POSTs a text message to the Graph endpoint and returns the wamid", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("WHATSAPP_GRAPH_VERSION", "v23.0")
    stubCreds()
    stubWithinWindowContact()
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.ABC" }] }),
    })
    vi.stubGlobal("fetch", fetchSpy)

    const r = await sendWhatsAppCloudMessage({ tenantId: "tn1", contactId: "ct1", to: "0821234567", message: "hello" })

    expect(r).toEqual({ ok: true, messageId: "wamid.ABC" })
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe("https://graph.facebook.com/v23.0/PN1/messages")
    expect((init as RequestInit).method).toBe("POST")
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer TOK" })
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      messaging_product: "whatsapp",
      to: "27821234567",
      type: "text",
      text: { body: "hello" },
    })
  })

  it("classifies an allowlisted HTTP status as DEFINITELY_REJECTED", async () => {
    vi.stubEnv("NODE_ENV", "production")
    stubCreds()
    stubWithinWindowContact()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 400, text: async () => "bad number",
    }))
    const r = await sendWhatsAppCloudMessage({ tenantId: "tn1", contactId: "ct1", to: "27821234567", message: "x" })
    expect(r.ok).toBe(false)
    expect(r.providerOutcome).toBe("DEFINITELY_REJECTED")
  })

  it("holds a 5xx as AMBIGUOUS", async () => {
    vi.stubEnv("NODE_ENV", "production")
    stubCreds()
    stubWithinWindowContact()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 503, text: async () => "upstream",
    }))
    const r = await sendWhatsAppCloudMessage({ tenantId: "tn1", contactId: "ct1", to: "27821234567", message: "x" })
    expect(r.providerOutcome).toBe("AMBIGUOUS")
  })

  it("holds a 200 without a wamid as AMBIGUOUS", async () => {
    vi.stubEnv("NODE_ENV", "production")
    stubCreds()
    stubWithinWindowContact()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ messages: [] }),
    }))
    const r = await sendWhatsAppCloudMessage({ tenantId: "tn1", contactId: "ct1", to: "27821234567", message: "x" })
    expect(r).toEqual({
      ok: false,
      error: "WhatsApp Cloud returned success without a provider message id",
      providerOutcome: "AMBIGUOUS",
    })
  })
})

describe("sendWhatsAppCloudMessage — 24h window", () => {
  function stubContact(waLast: string | null) {
    vi.mocked(prisma.contact.findFirst).mockResolvedValue(
      (waLast ? { lastInboundAtByChannel: { WHATSAPP: waLast } } : { lastInboundAtByChannel: null }) as never,
    )
  }
  const approvedTemplate = {
    name: "review_ask", language: "en", providerStatus: "APPROVED",
    components: [{ type: "body" as const, parameters: [{ type: "text" as const, text: "Thabo" }] }],
  }

  it("sends free-form text when inside the 24h window", async () => {
    vi.stubEnv("NODE_ENV", "production")
    stubCreds()
    stubContact(new Date(Date.now() - 3600_000).toISOString())
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: "wamid.T" }] }) })
    vi.stubGlobal("fetch", fetchSpy)

    const r = await sendWhatsAppCloudMessage({ tenantId: "tn1", contactId: "ct1", to: "27821234567", message: "hi", template: approvedTemplate })
    expect(r).toEqual({ ok: true, messageId: "wamid.T" })
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).type).toBe("text")
  })

  it("sends an approved template when outside the window", async () => {
    vi.stubEnv("NODE_ENV", "production")
    stubCreds()
    stubContact(new Date(Date.now() - 25 * 3600_000).toISOString())
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: "wamid.T" }] }) })
    vi.stubGlobal("fetch", fetchSpy)

    const r = await sendWhatsAppCloudMessage({ tenantId: "tn1", contactId: "ct1", to: "27821234567", message: "hi", template: approvedTemplate })
    expect(r.ok).toBe(true)
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.type).toBe("template")
    expect(body.template).toMatchObject({ name: "review_ask", language: { code: "en" } })
  })

  it("fails with the typed outside-window code when no approved template is available", async () => {
    vi.stubEnv("NODE_ENV", "production")
    stubCreds()
    stubContact(null)
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)

    const r = await sendWhatsAppCloudMessage({ tenantId: "tn1", contactId: "ct1", to: "27821234567", message: "hi" })
    expect(r).toMatchObject({ ok: false, error: "WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE", providerOutcome: "DEFINITELY_REJECTED" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("treats a template whose providerStatus is not APPROVED as unavailable", async () => {
    vi.stubEnv("NODE_ENV", "production")
    stubCreds()
    stubContact(null)
    vi.stubGlobal("fetch", vi.fn())
    const r = await sendWhatsAppCloudMessage({
      tenantId: "tn1", contactId: "ct1", to: "27821234567", message: "hi",
      template: { ...approvedTemplate, providerStatus: "PENDING" },
    })
    expect(r.error).toBe("WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE")
  })

  it("scopes the window read to the caller's tenantId", async () => {
    vi.stubEnv("NODE_ENV", "production")
    stubCreds()
    stubContact(new Date(Date.now() - 3600_000).toISOString())
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: "wamid.T" }] }) }))

    await sendWhatsAppCloudMessage({ tenantId: "tn1", contactId: "ct1", to: "27821234567", message: "hi" })

    expect(prisma.contact.findFirst).toHaveBeenCalledWith({
      where: { id: "ct1", tenantId: "tn1" },
      select: { lastInboundAtByChannel: true },
    })
  })

  it("never throws when the window read fails, degrading to outside-window", async () => {
    vi.stubEnv("NODE_ENV", "production")
    stubCreds()
    vi.mocked(prisma.contact.findFirst).mockRejectedValue(new Error("db down"))
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)

    const r = await sendWhatsAppCloudMessage({ tenantId: "tn1", contactId: "ct1", to: "27821234567", message: "hi" })

    expect(r).toEqual({ ok: false, error: "WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE", providerOutcome: "DEFINITELY_REJECTED" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
