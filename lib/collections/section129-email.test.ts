import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ config: vi.fn(), sendEmail: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { emailConfig: { findUnique: (...a: unknown[]) => h.config(...a) } } }))
vi.mock("@/lib/email/service", () => ({ sendEmail: (...a: unknown[]) => h.sendEmail(...a) }))

import { sendSection129Email, section129SentMessage } from "./section129-email"

const opts = (to: string) => ({ tenantId: "t1", to, subject: "Section 129 Notice", html: "<p>n</p>", category: "section129" })

beforeEach(() => {
  vi.clearAllMocks()
  h.config.mockResolvedValue(null)
  h.sendEmail.mockResolvedValue({ ok: false, error: "Email not configured for this tenant. Go to Settings → Email.", providerOutcome: "DEFINITELY_REJECTED" })
})
afterEach(() => vi.unstubAllEnvs())

describe("sendSection129Email", () => {
  it("simulates on a demo stack with no email, for a .invalid mailbox only", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    const result = await sendSection129Email(opts("kabelo.mokoena@fairscore.invalid"))
    expect(result).toMatchObject({ ok: true, simulated: true, providerOutcome: "ACCEPTED" })
    expect(result.messageId).toMatch(/^simulated-s129-/)
    expect(result.acceptedAt).toBeInstanceOf(Date)
    expect(h.sendEmail).not.toHaveBeenCalled()
  })

  it("never simulates a deliverable address, even on a demo stack", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    expect(await sendSection129Email(opts("someone@example.com"))).toMatchObject({ ok: false })
    expect(h.sendEmail).toHaveBeenCalled()
  })

  it("never simulates outside demo mode: a real lender still needs real email", async () => {
    expect(await sendSection129Email(opts("kabelo.mokoena@fairscore.invalid"))).toMatchObject({ ok: false })
    expect(h.config).not.toHaveBeenCalled()
  })

  it("uses the configured provider when the demo lender has email configured", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    h.config.mockResolvedValue({ active: true })
    h.sendEmail.mockResolvedValue({ ok: true, messageId: "m1", providerOutcome: "ACCEPTED", acceptedAt: new Date() })
    expect(await sendSection129Email(opts("kabelo.mokoena@fairscore.invalid"))).not.toHaveProperty("simulated")
  })

  it("says plainly that a simulated notice was not sent", () => {
    expect(section129SentMessage("a@b.invalid", true)).toBe("Section 129 notice simulated (not sent): a@b.invalid is a demo mailbox that cannot receive mail.")
    expect(section129SentMessage("a@b.com", false)).toBe("Section 129 notice accepted by the email provider for a@b.com")
  })
})
