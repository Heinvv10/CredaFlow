import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ config: vi.fn(), tenantConfig: vi.fn(), sendEmail: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailConfig: { findUnique: (...a: unknown[]) => h.config(...a) },
    tenantConfig: { findUnique: (...a: unknown[]) => h.tenantConfig(...a) },
  },
}))
vi.mock("@/lib/email/service", () => ({ sendEmail: (...a: unknown[]) => h.sendEmail(...a) }))

import { sendSection129Email, section129SentMessage, simulatesSection129 } from "./section129-email"

const opts = (to: string) => ({ tenantId: "t1", to, subject: "Section 129 Notice", html: "<p>n</p>", category: "section129" })

beforeEach(() => {
  vi.clearAllMocks()
  h.config.mockResolvedValue(null)
  h.tenantConfig.mockResolvedValue({ isDemoLender: true })
  h.sendEmail.mockResolvedValue({ ok: false, error: "Email not configured for this tenant. Go to Settings → Email.", providerOutcome: "DEFINITELY_REJECTED" })
})
afterEach(() => vi.unstubAllEnvs())

describe("simulatesSection129", () => {
  const simulates = (to: string) => simulatesSection129("t1", to)

  it("simulates on a demo stack with no email, for a .invalid mailbox only", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    expect(await simulates("kabelo.mokoena@fairscore.invalid")).toBe(true)
    expect(await simulates("someone@example.com")).toBe(false)
  })

  // #147 review: DEMO_MODE alone is one switch; a real lender on a
  // misconfigured deployment must still not have its notices simulated. The
  // second switch is the seed-only marker, never the slug: a real lender may
  // well be provisioned as "fairscore".
  it.each([
    ["not marked as a demo lender", { isDemoLender: false }],
    ["without a config row", null],
  ])("never simulates for a tenant %s, even on DEMO_MODE", async (_label, row) => {
    vi.stubEnv("DEMO_MODE", "true")
    h.tenantConfig.mockResolvedValue(row)
    expect(await simulates("kabelo.mokoena@fairscore.invalid")).toBe(false)
    expect(h.tenantConfig).toHaveBeenCalledWith({ where: { tenantId: "t1" }, select: { isDemoLender: true } })
  })

  it("never simulates outside demo mode: a real lender still needs real email", async () => {
    expect(await simulates("kabelo.mokoena@fairscore.invalid")).toBe(false)
    expect(h.config).not.toHaveBeenCalled()
  })

  it("never simulates when the demo lender has email configured", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    h.config.mockResolvedValue({ active: true })
    expect(await simulates("kabelo.mokoena@fairscore.invalid")).toBe(false)
  })
})

describe("sendSection129Email", () => {
  it("simulates when the reservation recorded a simulated send: nothing reaches the provider", async () => {
    const result = await sendSection129Email(opts("kabelo.mokoena@fairscore.invalid"), true)
    expect(result).toMatchObject({ ok: true, simulated: true, providerOutcome: "ACCEPTED" })
    expect(result.messageId).toMatch(/^simulated-s129-/)
    expect(result.acceptedAt).toBeInstanceOf(Date)
    expect(h.sendEmail).not.toHaveBeenCalled()
  })

  it("otherwise sends through the provider, and does not re-decide", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    expect(await sendSection129Email(opts("kabelo.mokoena@fairscore.invalid"), false)).toMatchObject({ ok: false })
    expect(h.sendEmail).toHaveBeenCalled()
    expect(h.tenantConfig).not.toHaveBeenCalled()
  })

  it("says plainly that a simulated notice was not sent", () => {
    expect(section129SentMessage("a@b.invalid", true)).toBe("Section 129 notice simulated (not sent): a@b.invalid is a demo mailbox that cannot receive mail.")
    expect(section129SentMessage("a@b.com", false)).toBe("Section 129 notice accepted by the email provider for a@b.com")
  })
})
