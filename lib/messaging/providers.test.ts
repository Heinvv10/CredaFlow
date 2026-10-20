/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

vi.mock("@/lib/email/service", () => ({
  sendEmail: vi.fn(),
}))
vi.mock("@/lib/integrations/bulksms", () => ({
  sendSms: vi.fn(),
  sendWhatsApp: vi.fn(),
}))
vi.mock("@/lib/whatsapp", () => ({
  sendWhatsAppMessage: vi.fn(),
}))
vi.mock("@/lib/whatsapp-cloud", () => ({
  sendWhatsAppCloudMessage: vi.fn(),
}))
vi.mock("@/lib/inbox/settings", () => ({
  getCommsSettings: vi.fn(async () => ({ whatsappEnabled: true })),
}))

import { sendEmail } from "@/lib/email/service"
import { sendSms } from "@/lib/integrations/bulksms"
import { sendWhatsAppMessage } from "@/lib/whatsapp"
import { sendWhatsAppCloudMessage } from "@/lib/whatsapp-cloud"
import { getCommsSettings } from "@/lib/inbox/settings"
import {
  dispatch,
  ProviderDispatchError,
  providerFailureOutcome,
} from "./providers"

const baseOpts = {
  tenantId: "tn1",
  toValue: "test@example.com",
  category: "TRANSACTIONAL",
}
const rendered = { subject: "S", html: "<p>H</p>", text: "T" }
const acceptedAt = new Date("2026-07-19T10:00:00.000Z")

describe("dispatch", () => {
  beforeEach(() => vi.clearAllMocks())

  it("routes EMAIL to sendEmail", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: true, provider: "SMTP", messageId: "em-1", providerOutcome: "ACCEPTED", acceptedAt })
    const r = await dispatch("EMAIL", "SMTP", rendered, { ...baseOpts, toValue: "x@y.com" })
    expect(sendEmail).toHaveBeenCalledOnce()
    expect(r).toEqual({ providerMessageId: "em-1", acceptedAt })
  })

  it("preserves SMTP acceptance evidence when only the auxiliary EmailLog write failed", async () => {
    vi.mocked(sendEmail).mockResolvedValue({
      ok: true,
      provider: "SMTP",
      messageId: "em-accepted",
      providerOutcome: "ACCEPTED",
      acceptedAt,
      emailLogPersistenceError: "EmailLog unavailable",
    })

    await expect(dispatch("EMAIL", "SMTP", rendered, {
      ...baseOpts,
      toValue: "x@y.com",
    })).resolves.toEqual({
      providerMessageId: "em-accepted",
      acceptedAt,
      auxiliaryPersistenceError: "EmailLog unavailable",
    })
  })

  it("passes the exact provider-dispatch signal through the email adapter", async () => {
    const onProviderDispatchStart = vi.fn()
    vi.mocked(sendEmail).mockImplementation(async (opts) => {
      opts.onProviderDispatchStart?.()
      return { ok: true, provider: "SMTP", messageId: "em-1", providerOutcome: "ACCEPTED", acceptedAt }
    })

    await dispatch("EMAIL", "SMTP", rendered, {
      ...baseOpts,
      toValue: "x@y.com",
      onProviderDispatchStart,
    })

    expect(onProviderDispatchStart).toHaveBeenCalledOnce()
  })

  it("routes SMS to sendSms", async () => {
    vi.mocked(sendSms).mockResolvedValue({ ok: true, messageId: "sm-1" } as any)
    const r = await dispatch("SMS", "BULKSMS", rendered, { ...baseOpts, toValue: "27821234567" })
    expect(sendSms).toHaveBeenCalledOnce()
    expect(r).toEqual({ providerMessageId: "sm-1", acceptedAt: expect.any(Date) })
  })

  it("preserves the SMS dry-run outcome instead of treating it as provider acceptance", async () => {
    vi.mocked(sendSms).mockResolvedValue({
      ok: true,
      messageId: "dry-run-1",
      simulated: true,
    } as any)

    const result = await dispatch("SMS", "BULKSMS", rendered, {
      ...baseOpts,
      toValue: "27821234567",
    })

    expect(result).toEqual({
      simulationReceiptId: "dry-run-1",
      simulated: true,
    })
  })

  it.each([
    ["missing", undefined],
    ["blank", "   "],
  ])("holds an SMS success with a %s provider id as ambiguous", async (_label, messageId) => {
    vi.mocked(sendSms).mockResolvedValue({ ok: true, messageId } as any)

    await expect(dispatch("SMS", "BULKSMS", rendered, {
      ...baseOpts,
      toValue: "27821234567",
    })).rejects.toMatchObject({
      outcome: "AMBIGUOUS",
      message: expect.stringMatching(/without a provider message id/i),
    })
  })

  it("preserves a definite SMS rejection for retry policy", async () => {
    vi.mocked(sendSms).mockResolvedValue({
      ok: false,
      error: "BulkSMS error 422: recipient rejected",
      providerOutcome: "DEFINITELY_REJECTED",
    } as any)

    const error = await dispatch("SMS", "BULKSMS", rendered, {
      ...baseOpts,
      toValue: "27821234567",
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(ProviderDispatchError)
    expect(providerFailureOutcome(error)).toBe("DEFINITELY_REJECTED")
  })

  it("treats an SMS transport failure without provider certainty as ambiguous", async () => {
    vi.mocked(sendSms).mockResolvedValue({
      ok: false,
      error: "fetch failed",
      providerOutcome: "AMBIGUOUS",
    } as any)

    const error = await dispatch("SMS", "BULKSMS", rendered, {
      ...baseOpts,
      toValue: "27821234567",
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(ProviderDispatchError)
    expect(providerFailureOutcome(error)).toBe("AMBIGUOUS")
  })

  it("routes WHATSAPP to sendWhatsAppMessage", async () => {
    vi.mocked(sendWhatsAppMessage).mockResolvedValue({ ok: true, messageId: "wa-1" })
    const r = await dispatch("WHATSAPP", "WA_UNOFFICIAL", rendered, { ...baseOpts, toValue: "27821234567" })
    expect(sendWhatsAppMessage).toHaveBeenCalledOnce()
    expect(r).toEqual({ providerMessageId: "wa-1", acceptedAt: expect.any(Date) })

  })

  it.each([
    ["missing", undefined],
    ["blank", "   "],
  ])("holds a WhatsApp success with a %s provider id as ambiguous", async (_label, messageId) => {
    vi.mocked(sendWhatsAppMessage).mockResolvedValue({ ok: true, messageId })

    await expect(dispatch("WHATSAPP", "WA_UNOFFICIAL", rendered, {
      ...baseOpts,
      toValue: "27821234567",
    })).rejects.toMatchObject({
      outcome: "AMBIGUOUS",
      message: expect.stringMatching(/without a provider message id/i),
    })
  })

  it("preserves a definite WhatsApp rejection for retry policy", async () => {
    vi.mocked(sendWhatsAppMessage).mockResolvedValue({
      ok: false,
      error: "WA Sender 422: recipient rejected",
      providerOutcome: "DEFINITELY_REJECTED",
    })
    const error = await dispatch("WHATSAPP", "WA_UNOFFICIAL", rendered, {
      ...baseOpts,
      toValue: "27821234567",
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(ProviderDispatchError)
    expect(providerFailureOutcome(error)).toBe("DEFINITELY_REJECTED")
  })

  it("fails closed when an accepted email has no provider acceptance timestamp", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: true, provider: "SMTP", messageId: "em-1", providerOutcome: "ACCEPTED" })

    await expect(dispatch(
      "EMAIL",
      "SMTP",
      rendered,
      { ...baseOpts, toValue: "x@y.com" },
    )).rejects.toMatchObject({ outcome: "AMBIGUOUS" })
  })

  it("fails closed when an accepted email has no provider message id", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: true, provider: "SMTP", providerOutcome: "ACCEPTED", acceptedAt })

    await expect(dispatch(
      "EMAIL",
      "SMTP",
      rendered,
      { ...baseOpts, toValue: "x@y.com" },
    )).rejects.toMatchObject({
      outcome: "AMBIGUOUS",
      message: expect.stringMatching(/without a provider message id/i),
    })
  })

  it("accepts id-less MS Graph only with durable HTTP acceptance evidence", async () => {
    vi.mocked(sendEmail).mockResolvedValue({
      ok: true,
      provider: "MSGRAPH",
      providerOutcome: "ACCEPTED",
      acceptedAt,
      providerEvidenceReference: "MSGRAPH_CLIENT_REQUEST_ID:11111111-1111-4111-8111-111111111111",
    })

    await expect(dispatch(
      "EMAIL",
      "MSGRAPH",
      rendered,
      { ...baseOpts, toValue: "x@y.com" },
    )).resolves.toEqual({
      acceptedAt,
      evidenceReference: "MSGRAPH_CLIENT_REQUEST_ID:11111111-1111-4111-8111-111111111111",
    })
  })

  it("preserves Graph acceptance evidence when only the auxiliary EmailLog write failed", async () => {
    vi.mocked(sendEmail).mockResolvedValue({
      ok: true,
      provider: "MSGRAPH",
      providerOutcome: "ACCEPTED",
      acceptedAt,
      providerEvidenceReference: "MSGRAPH_CLIENT_REQUEST_ID:11111111-1111-4111-8111-111111111111",
      emailLogPersistenceError: "EmailLog unavailable",
    })

    await expect(dispatch("EMAIL", "MSGRAPH", rendered, {
      ...baseOpts,
      toValue: "x@y.com",
    })).resolves.toEqual({
      acceptedAt,
      evidenceReference: "MSGRAPH_CLIENT_REQUEST_ID:11111111-1111-4111-8111-111111111111",
      auxiliaryPersistenceError: "EmailLog unavailable",
    })
  })

  it("rejects a shared Graph HTTP status constant as non-correlatable evidence", async () => {
    vi.mocked(sendEmail).mockResolvedValue({
      ok: true,
      provider: "MSGRAPH",
      providerOutcome: "ACCEPTED",
      acceptedAt,
      providerEvidenceReference: "MSGRAPH_HTTP_202",
    })

    await expect(dispatch(
      "EMAIL",
      "MSGRAPH",
      rendered,
      { ...baseOpts, toValue: "x@y.com" },
    )).rejects.toMatchObject({
      outcome: "AMBIGUOUS",
      message: expect.stringMatching(/request-scoped provider evidence/i),
    })
  })

  it("rejects an email result that contradicts the reserved provider", async () => {
    vi.mocked(sendEmail).mockResolvedValue({
      ok: true,
      provider: "MSGRAPH",
      providerOutcome: "ACCEPTED",
      acceptedAt,
      providerEvidenceReference: "MSGRAPH_CLIENT_REQUEST_ID:11111111-1111-4111-8111-111111111111",
    })

    await expect(dispatch(
      "EMAIL",
      "SMTP",
      rendered,
      { ...baseOpts, toValue: "x@y.com" },
    )).rejects.toMatchObject({ outcome: "DEFINITELY_REJECTED" })
  })

  it("throws when the provider returns ok:false", async () => {
    vi.mocked(sendEmail).mockResolvedValue({
      ok: false,
      error: "Provider down",
      providerOutcome: "AMBIGUOUS",
    })
    const error = await dispatch(
      "EMAIL",
      "SMTP",
      rendered,
      { ...baseOpts, toValue: "x@y.com" },
    ).catch((caught) => caught)

    expect(error).toBeInstanceOf(ProviderDispatchError)
    expect(error).toMatchObject({ message: "Provider down", outcome: "AMBIGUOUS" })
    expect(providerFailureOutcome(error)).toBe("AMBIGUOUS")
  })

  it("preserves a definite provider rejection for statutory callers", async () => {
    vi.mocked(sendEmail).mockResolvedValue({
      ok: false,
      error: "Recipient rejected",
      providerOutcome: "DEFINITELY_REJECTED",
    })
    const error = await dispatch(
      "EMAIL",
      "SMTP",
      rendered,
      { ...baseOpts, toValue: "x@y.com" },
    ).catch((caught) => caught)

    expect(error).toBeInstanceOf(ProviderDispatchError)
    expect(providerFailureOutcome(error)).toBe("DEFINITELY_REJECTED")
    expect(providerFailureOutcome(new Error("unknown"))).toBe("AMBIGUOUS")
  })

  it("throws on unsupported channels (VOICE, MANUAL)", async () => {
    await expect(
      dispatch("VOICE", "RESEND" as any, rendered, baseOpts as any)
    ).rejects.toThrow(/voice/i)
  })
})

describe("dispatch WHATSAPP provider routing", () => {
  beforeEach(() => vi.clearAllMocks())

  it("routes WA_UNOFFICIAL to the bridge sender", async () => {
    vi.mocked(sendWhatsAppMessage).mockResolvedValue({ ok: true, messageId: "wa-1" })
    const r = await dispatch("WHATSAPP", "WA_UNOFFICIAL", rendered, { ...baseOpts, toValue: "27821234567" })
    expect(sendWhatsAppMessage).toHaveBeenCalledOnce()
    expect(sendWhatsAppCloudMessage).not.toHaveBeenCalled()
    expect(r).toMatchObject({ providerMessageId: "wa-1" })
  })

  it("routes WA_CLOUD to the cloud sender with the tenantId", async () => {
    vi.mocked(sendWhatsAppCloudMessage).mockResolvedValue({ ok: true, messageId: "wamid.1" })
    const r = await dispatch("WHATSAPP", "WA_CLOUD", rendered, { ...baseOpts, toValue: "27821234567" })
    expect(sendWhatsAppCloudMessage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tn1", to: "27821234567", message: "T" }),
    )
    expect(sendWhatsAppMessage).not.toHaveBeenCalled()
    expect(r).toMatchObject({ providerMessageId: "wamid.1" })
  })

  it("forwards contactId + the WABA template ref to the cloud sender (window read + template send)", async () => {
    // Guards the seam the whole 24h-window feature depends on: without these,
    // the sender always reads a null window → WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE
    // → every WA_CLOUD send fails.
    vi.mocked(sendWhatsAppCloudMessage).mockResolvedValue({ ok: true, messageId: "wamid.2" })
    const waTemplate = { name: "review_ask", language: "en", providerStatus: "APPROVED", components: [] }
    await dispatch("WHATSAPP", "WA_CLOUD", rendered, {
      ...baseOpts,
      toValue: "27821234567",
      contactId: "ct1",
      waTemplate,
    } as any)
    expect(sendWhatsAppCloudMessage).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: "ct1", template: waTemplate }),
    )
  })

  it("rejects an unsupported WhatsApp provider as DEFINITELY_REJECTED", async () => {
    await expect(dispatch("WHATSAPP", "WA_BSP_360DIALOG", rendered, { ...baseOpts, toValue: "27821234567" }))
      .rejects.toMatchObject({ name: "ProviderDispatchError", outcome: "DEFINITELY_REJECTED" })
  })
})

// F4: the WhatsApp Cloud path had no kill switch. WA_ENABLED=false (env) and
// CommsSettings.whatsappEnabled=false (tenant) must both stop a send BEFORE any
// provider call. WA_ENABLED UNSET must keep following the tenant switch:
// Cloud-only deployments never set it (docs/DEPLOY-ENV.md).
describe("dispatch WHATSAPP kill switches", () => {
  const cloudOpts = { ...baseOpts, toValue: "27821234567" }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    vi.mocked(getCommsSettings).mockResolvedValue({ whatsappEnabled: true } as never)
    vi.mocked(sendWhatsAppCloudMessage).mockResolvedValue({ ok: true, messageId: "wamid.ks" })
  })
  afterEach(() => vi.unstubAllEnvs())

  it("WA_ENABLED=false refuses WA_CLOUD as DEFINITELY_REJECTED with no Cloud call", async () => {
    vi.stubEnv("WA_ENABLED", "false")
    const onProviderDispatchStart = vi.fn()
    const err = await dispatch("WHATSAPP", "WA_CLOUD", rendered, { ...cloudOpts, onProviderDispatchStart }).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderDispatchError)
    expect(err.outcome).toBe("DEFINITELY_REJECTED")
    expect(err.message).toMatch(/whatsapp\s+disabled/i)
    expect(sendWhatsAppCloudMessage).not.toHaveBeenCalled()
    expect(onProviderDispatchStart).not.toHaveBeenCalled()
  })

  it("any WA_ENABLED value other than true/unset also refuses (typo fails safe)", async () => {
    for (const v of ["False", "0", "off", "ture"]) {
      vi.stubEnv("WA_ENABLED", v)
      await expect(dispatch("WHATSAPP", "WA_CLOUD", rendered, cloudOpts), `WA_ENABLED=${v}`)
        .rejects.toMatchObject({ outcome: "DEFINITELY_REJECTED" })
    }
    expect(sendWhatsAppCloudMessage).not.toHaveBeenCalled()
  })

  it("tenant whatsappEnabled=false refuses WA_CLOUD with no Cloud call, even with WA_ENABLED=true", async () => {
    vi.stubEnv("WA_ENABLED", "true")
    vi.mocked(getCommsSettings).mockResolvedValue({ whatsappEnabled: false } as never)
    const err = await dispatch("WHATSAPP", "WA_CLOUD", rendered, cloudOpts).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderDispatchError)
    expect(err.outcome).toBe("DEFINITELY_REJECTED")
    expect(err.message).toMatch(/whatsapp\s+disabled/i)
    expect(sendWhatsAppCloudMessage).not.toHaveBeenCalled()
  })

  it("tenant whatsappEnabled=false also refuses the bridge provider", async () => {
    vi.mocked(getCommsSettings).mockResolvedValue({ whatsappEnabled: false } as never)
    await expect(dispatch("WHATSAPP", "WA_UNOFFICIAL", rendered, cloudOpts))
      .rejects.toMatchObject({ outcome: "DEFINITELY_REJECTED" })
    expect(sendWhatsAppMessage).not.toHaveBeenCalled()
  })

  it("unreadable tenant settings fail closed as DEFINITELY_REJECTED", async () => {
    vi.mocked(getCommsSettings).mockRejectedValue(new Error("db down"))
    await expect(dispatch("WHATSAPP", "WA_CLOUD", rendered, cloudOpts))
      .rejects.toMatchObject({ outcome: "DEFINITELY_REJECTED" })
    expect(sendWhatsAppCloudMessage).not.toHaveBeenCalled()
  })

  it("WA_ENABLED unset + whatsappEnabled=true still sends over Cloud", async () => {
    vi.stubEnv("WA_ENABLED", "")
    delete process.env.WA_ENABLED
    const r = await dispatch("WHATSAPP", "WA_CLOUD", rendered, cloudOpts)
    expect(sendWhatsAppCloudMessage).toHaveBeenCalledOnce()
    expect(r).toMatchObject({ providerMessageId: "wamid.ks" })
  })

  it("WA_ENABLED=true + whatsappEnabled=true sends over Cloud", async () => {
    vi.stubEnv("WA_ENABLED", "true")
    await dispatch("WHATSAPP", "WA_CLOUD", rendered, cloudOpts)
    expect(sendWhatsAppCloudMessage).toHaveBeenCalledOnce()
  })

  it("does not gate EMAIL or SMS", async () => {
    vi.stubEnv("WA_ENABLED", "false")
    vi.mocked(getCommsSettings).mockResolvedValue({ whatsappEnabled: false } as never)
    vi.mocked(sendEmail).mockResolvedValue({ ok: true, provider: "SMTP", messageId: "em-1", providerOutcome: "ACCEPTED", acceptedAt })
    await dispatch("EMAIL", "SMTP", rendered, { ...baseOpts, toValue: "x@y.com" })
    expect(sendEmail).toHaveBeenCalledOnce()
    expect(getCommsSettings).not.toHaveBeenCalled()
  })
})
