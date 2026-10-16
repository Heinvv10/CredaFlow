import { afterEach, describe, it, expect, vi } from "vitest"
import { normalizePhone, sendWhatsAppMessage, waHttpFailureOutcome, WA_TEMPLATES } from "./whatsapp"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("WhatsApp provider outcome certainty", () => {
  it("holds HTTP 5xx responses as ambiguous because acceptance is not disproved", () => {
    expect(waHttpFailureOutcome(500)).toBe("AMBIGUOUS")
    expect(waHttpFailureOutcome(503)).toBe("AMBIGUOUS")
  })

  it("treats allowlisted HTTP rejections as definite", () => {
    expect(waHttpFailureOutcome(400)).toBe("DEFINITELY_REJECTED")
    expect(waHttpFailureOutcome(422)).toBe("DEFINITELY_REJECTED")
  })

  it("holds HTTP 408/409 for reconciliation because acceptance is unknown", () => {
    expect(waHttpFailureOutcome(408)).toBe("AMBIGUOUS")
    expect(waHttpFailureOutcome(409)).toBe("AMBIGUOUS")
  })
})

describe("normalizePhone (idempotent over raw phone OR fully-qualified JID)", () => {
  it("normalises a raw SA phone with leading 0 to E.164 digits", () => {
    expect(normalizePhone("0821234567")).toBe("27821234567")
  })

  it("strips +/spaces/dashes", () => {
    expect(normalizePhone("+27 82 123-4567")).toBe("27821234567")
  })

  it("is idempotent over an already-normalised JID — does NOT double-suffix", () => {
    // This guards against callers that pass `27821234567@s.whatsapp.net`
    // being re-normalised + re-suffixed → `27821234567@s.whatsapp.net@s.whatsapp.net`,
    // so posts never delivered. The fix strips the JID suffix first.
    expect(normalizePhone("27821234567@s.whatsapp.net")).toBe("27821234567")
  })

  it("is idempotent over an SA-local phone with leading 0 expressed as a JID", () => {
    expect(normalizePhone("0821234567@s.whatsapp.net")).toBe("27821234567")
  })

  it("case-insensitive on the JID suffix", () => {
    expect(normalizePhone("27821234567@s.WhatsApp.NET")).toBe("27821234567")
  })
})

describe("payment-due WA templates quote the loan reference", () => {
  // The loan reference (Loan.reference) is the exact token the bank-sync
  // reconciler matches on. A client who quotes it on their EFT gets an
  // EXACT match instead of a manual reconcile, so every payment-due
  // reminder must surface it.
  it("payment_due_3d includes the payment reference", () => {
    const msg = WA_TEMPLATES.payment_due_3d("Thabo", "R1 500.00", "15 Aug 2026", "LN-0007")
    expect(msg).toContain("LN-0007")
  })

  it("payment_due_today includes the payment reference", () => {
    const msg = WA_TEMPLATES.payment_due_today("Thabo", "R1 500.00", "LN-0007")
    expect(msg).toContain("LN-0007")
  })

  it("payment_due_today states the payment without threatening charges", () => {
    const msg = WA_TEMPLATES.payment_due_today("Thabo", "R1 500.00", "LN-0007")
    expect(msg).toContain("\n\nContact us if you need assistance.")
    expect(msg).not.toMatch(/avoid|default interest|charges|late fee|⚠️/i)
  })
})

describe("sendWhatsAppMessage dry-run id uniqueness", () => {
  // NODE_ENV === "test" auto-triggers the dry-run branch in vitest. WA_ENABLED
  // is not set in test, so isWaEnabled() returns false and the path normally
  // short-circuits with "WhatsApp disabled" before the dry-run shim. Enable
  // WA inline for this assertion.
  it("returns a fresh dry-run id on every call so the Message provider-id unique constraint is not hit", async () => {
    const prev = process.env.WA_ENABLED
    process.env.WA_ENABLED = "true"
    try {
      const a = await sendWhatsAppMessage({ to: "27821234567", message: "x" })
      const b = await sendWhatsAppMessage({ to: "27821234567", message: "x" })
      expect(a.ok).toBe(true)
      expect(b.ok).toBe(true)
      expect(a.messageId).toMatch(/^dry-run-/)
      expect(b.messageId).toMatch(/^dry-run-/)
      expect(a.messageId).not.toBe(b.messageId)
      expect(a.simulated).toBe(true)
      expect(b.simulated).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.WA_ENABLED
      else process.env.WA_ENABLED = prev
    }
  })
})

describe("sendWhatsAppMessage provider receipt evidence", () => {
  it.each([
    ["missing", { success: true }],
    ["blank", { success: true, message_id: "   " }],
  ])("holds a successful response with a %s message id as ambiguous", async (_label, payload) => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("WA_ENABLED", "true")
    vi.stubEnv("WA_SENDER_URL", "http://wa-sender.test:8083")
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    }))

    await expect(sendWhatsAppMessage({
      to: "27821234567",
      message: "test",
    })).resolves.toEqual({
      ok: false,
      error: "WA Sender returned success without a provider message id",
      providerOutcome: "AMBIGUOUS",
    })
  })
})

describe("sendWhatsAppMessage without WA_SENDER_URL", () => {
  it.each(["", "   "])("fails without making any request when the URL is %j", async (value) => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("WA_ENABLED", "true")
    vi.stubEnv("WA_DRY_RUN", "")
    vi.stubEnv("WA_SENDER_URL", value)
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(sendWhatsAppMessage({ to: "27821234567", message: "test" })).resolves.toEqual({
      ok: false,
      error: "WA_SENDER_URL is not configured",
      providerOutcome: "DEFINITELY_REJECTED",
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
