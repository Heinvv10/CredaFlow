import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"

// Avoid loading the real Prisma client during this dry-run unit test —
// NODE_ENV=test short-circuits sendBulkSms before any DB call, but the
// module-level `import { prisma } ...` would still try to initialise.
const { tenantConfigFindUnique } = vi.hoisted(() => ({
  tenantConfigFindUnique: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: { tenantConfig: { findUnique: tenantConfigFindUnique } },
}))
// sendWhatsApp consults the WhatsApp kill switch, which reads the tenant's
// CommsSettings.
const { getCommsSettingsMock } = vi.hoisted(() => ({ getCommsSettingsMock: vi.fn() }))
vi.mock("@/lib/inbox/settings", () => ({ getCommsSettings: getCommsSettingsMock }))

import { bulkSmsHttpFailureOutcome, sendSms, sendWhatsApp } from "./bulksms"

beforeEach(() => {
  vi.stubEnv("WA_ENABLED", undefined)
  getCommsSettingsMock.mockResolvedValue({ whatsappEnabled: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("BulkSMS provider outcome certainty", () => {
  it("holds HTTP 5xx responses as ambiguous because acceptance is not disproved", () => {
    expect(bulkSmsHttpFailureOutcome(500)).toBe("AMBIGUOUS")
    expect(bulkSmsHttpFailureOutcome(503)).toBe("AMBIGUOUS")
  })

  it("treats allowlisted HTTP rejections as definite", () => {
    expect(bulkSmsHttpFailureOutcome(400)).toBe("DEFINITELY_REJECTED")
    expect(bulkSmsHttpFailureOutcome(422)).toBe("DEFINITELY_REJECTED")
  })

  it("holds HTTP 408/409 for reconciliation because acceptance is unknown", () => {
    expect(bulkSmsHttpFailureOutcome(408)).toBe("AMBIGUOUS")
    expect(bulkSmsHttpFailureOutcome(409)).toBe("AMBIGUOUS")
  })
})

describe("BulkSMS dry-run id uniqueness", () => {
  it("sendSms returns a fresh dry-run id on every call", async () => {
    const a = await sendSms({ tenantId: "tn1", to: "27821234567", message: "x" })
    const b = await sendSms({ tenantId: "tn1", to: "27821234567", message: "x" })
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(a.messageId).toMatch(/^dry-run-/)
    expect(b.messageId).toMatch(/^dry-run-/)
    expect(a.messageId).not.toBe(b.messageId)
    expect(a.simulated).toBe(true)
  })

  it("sendWhatsApp returns a fresh dry-run id on every call", async () => {
    const a = await sendWhatsApp({ tenantId: "tn1", to: "27821234567", message: "x" })
    const b = await sendWhatsApp({ tenantId: "tn1", to: "27821234567", message: "x" })
    expect(a.messageId).not.toBe(b.messageId)
    expect(a.simulated).toBe(true)
    expect(b.simulated).toBe(true)
  })
})

describe("BulkSMS provider receipt evidence", () => {
  it.each([
    ["object", {}],
    ["empty array", []],
    ["blank id", { id: "   " }],
  ])("holds a successful %s response without an id as ambiguous", async (_label, payload) => {
    vi.stubEnv("NODE_ENV", "production")
    tenantConfigFindUnique.mockResolvedValue({ bulkSmsKey: "test-user:test-password" })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    }))

    await expect(sendSms({
      tenantId: "tn1",
      to: "27821234567",
      message: "test",
    })).resolves.toEqual({
      ok: false,
      error: "BulkSMS returned success without a provider message id",
      providerOutcome: "AMBIGUOUS",
    })
  })

  it("preserves a non-empty numeric provider id", async () => {
    vi.stubEnv("NODE_ENV", "production")
    tenantConfigFindUnique.mockResolvedValue({ bulkSmsKey: "test-user:test-password" })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 12345 }],
    }))

    await expect(sendSms({
      tenantId: "tn1",
      to: "27821234567",
      message: "test",
    })).resolves.toMatchObject({ ok: true, messageId: "12345" })
  })
})

// The callsites each skip their own SMS leg, which is what produces the
// honest per-leg accounting. This is the backstop underneath them, so a
// callsite added later cannot reach BulkSMS without asking.
describe("sendSms — transport backstop when the SMS channel is off", () => {
  it("refuses without calling the provider, as a DEFINITE rejection", async () => {
    vi.stubEnv("BULKSMS_DRY_RUN", "true")
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(sendSms({
      tenantId: "tn1",
      to: "27821234567",
      message: "test",
    })).resolves.toEqual({
      ok: false,
      error: "SMS not enabled",
      providerOutcome: "DEFINITELY_REJECTED",
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("UNSET env fails closed: sendSms refuses with no provider call (SMS is off by policy)", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("BULKSMS_DRY_RUN", "")
    delete process.env.BULKSMS_DRY_RUN
    tenantConfigFindUnique.mockResolvedValue({ bulkSmsKey: "test-user:test-password" })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(sendSms({ tenantId: "tn1", to: "27821234567", message: "test" })).resolves.toEqual({
      ok: false,
      error: "SMS not enabled",
      providerOutcome: "DEFINITELY_REJECTED",
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns no simulated success — that is the whole point of the guard", async () => {
    vi.stubEnv("BULKSMS_DRY_RUN", "true")

    const result = await sendSms({ tenantId: "tn1", to: "27821234567", message: "test" })

    expect(result.simulated).toBeUndefined()
    expect(result.messageId).toBeUndefined()
  })

  // The two channels are switched independently and WhatsApp is live.
  it("does NOT gate sendWhatsApp, which shares the same transport", async () => {
    vi.stubEnv("BULKSMS_DRY_RUN", "true")

    await expect(sendWhatsApp({
      tenantId: "tn1",
      to: "27821234567",
      message: "test",
    })).resolves.toMatchObject({ ok: true, simulated: true })
  })

  it("CHANNEL ON: sendSms reaches the provider as before", async () => {
    vi.stubEnv("NODE_ENV", "production")
    tenantConfigFindUnique.mockResolvedValue({ bulkSmsKey: "test-user:test-password" })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ id: 777 }] })
    vi.stubGlobal("fetch", fetchMock)

    await expect(sendSms({
      tenantId: "tn1",
      to: "27821234567",
      message: "test",
    })).resolves.toMatchObject({ ok: true, messageId: "777" })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

// BulkSMS WhatsApp is a live channel, switched by WA_ENABLED and the tenant's
// whatsappEnabled (not by BULKSMS_DRY_RUN, which only simulates). The guard
// sits in the transport so every caller is covered, the send-link routes
// among them.
describe("sendWhatsApp — WhatsApp kill switches at the transport", () => {
  const send = () => sendWhatsApp({ tenantId: "tn1", to: "27821234567", message: "test" })

  it("WA_ENABLED=false refuses before the dry-run shim and before credentials load", async () => {
    vi.stubEnv("WA_ENABLED", "false")
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const r = await send()

    expect(r).toMatchObject({ ok: false, providerOutcome: "DEFINITELY_REJECTED" })
    expect(r.simulated).toBeUndefined()
    expect(r.error).toMatch(/whatsapp\s+disabled/i)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(tenantConfigFindUnique).not.toHaveBeenCalled()
    expect(getCommsSettingsMock).not.toHaveBeenCalled()
  })

  it("tenant whatsappEnabled=false refuses with no simulated success and no provider call", async () => {
    getCommsSettingsMock.mockResolvedValue({ whatsappEnabled: false })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const r = await send()

    expect(r).toMatchObject({ ok: false, providerOutcome: "DEFINITELY_REJECTED" })
    expect(r.simulated).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("an unreadable settings row refuses with the TRANSIENT wording and no exception text", async () => {
    getCommsSettingsMock.mockRejectedValue(new Error("db down at 10.0.0.5"))

    const r = await send()

    expect(r.ok).toBe(false)
    expect(r.error).not.toMatch(/whatsapp\s+disabled/i)
    expect(r.error).not.toMatch(/db down|10\.0\.0\.5/)
  })

  it("WA_ENABLED unset + whatsappEnabled=true still goes through (here: the NODE_ENV=test dry-run shim)", async () => {
    vi.stubEnv("WA_ENABLED", undefined)
    await expect(send()).resolves.toMatchObject({ ok: true, simulated: true })
  })

  it("BULKSMS_DRY_RUN unset does NOT switch WhatsApp off (it is not the WhatsApp switch; SMS is the fail-closed one)", async () => {
    vi.stubEnv("BULKSMS_DRY_RUN", undefined)
    await expect(send()).resolves.toMatchObject({ ok: true, simulated: true })
  })
})
