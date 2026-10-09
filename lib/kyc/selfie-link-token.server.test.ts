import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  isSelfieLinkSecret,
  hashSelfieLinkSecret,
  mintSelfieLinkToken,
  resolveSelfieLinkToken,
  SELFIE_LINK_TTL_MS,
} from "@/lib/kyc/selfie-link-token.server"

const findUnique = vi.fn()
const findFirst = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    selfieCaptureToken: { findUnique: (...a: unknown[]) => findUnique(...a) },
    loanApplication: { findFirst: (...a: unknown[]) => findFirst(...a) },
  },
}))

describe("selfie link token", () => {
  it("accepts only a 43-char base64url secret", () => {
    expect(isSelfieLinkSecret("a".repeat(43))).toBe(true)
    expect(isSelfieLinkSecret("a".repeat(42))).toBe(false)
    expect(isSelfieLinkSecret("a".repeat(44))).toBe(false)
    expect(isSelfieLinkSecret("a".repeat(43) + "!")).toBe(false)
    expect(isSelfieLinkSecret(null)).toBe(false)
    expect(isSelfieLinkSecret(undefined)).toBe(false)
    expect(isSelfieLinkSecret(12345)).toBe(false)
  })

  it("never returns the secret in the stored hash", () => {
    const secret = "b".repeat(43)
    expect(hashSelfieLinkSecret(secret)).toMatch(/^[a-f0-9]{64}$/)
    expect(hashSelfieLinkSecret(secret)).not.toContain(secret)
  })

  it("invalidates every other active token for the application before creating one", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    const create = vi.fn().mockResolvedValue({ id: "tok-1" })
    const now = new Date("2026-08-06T10:00:00.000Z")

    const minted = await mintSelfieLinkToken(
      { selfieCaptureToken: { updateMany, create } } as never,
      {
        tenantId: "t1",
        applicationId: "app1",
        clientId: "c1",
        channel: "WHATSAPP",
        sentTo: "+27820000000",
        createdById: "u1",
        now,
      },
    )

    expect(updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", applicationId: "app1", usedAt: null, invalidatedAt: null },
      data: { invalidatedAt: now },
    })
    expect(minted.secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(minted.expiresAt.getTime()).toBe(now.getTime() + SELFIE_LINK_TTL_MS)
    // The secret must not be handed to the database.
    expect(JSON.stringify(create.mock.calls[0][0])).not.toContain(minted.secret)
    // What IS handed over is the digest of the secret it returned.
    expect(create.mock.calls[0][0].data.tokenHash).toBe(hashSelfieLinkSecret(minted.secret))
  })

  it("mints a distinct secret every time", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 })
    const create = vi.fn().mockResolvedValue({ id: "tok-1" })
    const tx = { selfieCaptureToken: { updateMany, create } } as never
    const args = {
      tenantId: "t1",
      applicationId: "app1",
      clientId: "c1",
      channel: "SMS" as const,
      sentTo: "+27820000000",
      createdById: "u1",
    }

    const a = await mintSelfieLinkToken(tx, args)
    const b = await mintSelfieLinkToken(tx, args)

    expect(a.secret).not.toBe(b.secret)
  })

  it("expires sooner than the PASQ link, because it authorises a KYC act", async () => {
    const { PASQ_LINK_TTL_MS } = await import("@/lib/compliance/pasq-link-token.server")
    expect(SELFIE_LINK_TTL_MS).toBeLessThan(PASQ_LINK_TTL_MS)
  })
})

describe("resolveSelfieLinkToken", () => {
  const SECRET = "s".repeat(43)
  const NOW = new Date("2026-08-06T12:00:00.000Z")
  const LIVE = {
    id: "tok1",
    tenantId: "t1",
    applicationId: "app1",
    clientId: "c1",
    tokenHash: hashSelfieLinkSecret(SECRET),
    expiresAt: new Date("2026-08-07T12:00:00.000Z"),
    usedAt: null as Date | null,
    invalidatedAt: null as Date | null,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    findUnique.mockResolvedValue({ ...LIVE })
    findFirst.mockResolvedValue({ client: { firstName: "Thabo" } })
  })

  it("resolves a live token to its application and client", async () => {
    const result = await resolveSelfieLinkToken(SECRET, NOW)

    expect(result).toEqual({
      ok: true,
      link: {
        tokenId: "tok1",
        tenantId: "t1",
        applicationId: "app1",
        clientId: "c1",
        clientFirstName: "Thabo",
      },
    })
  })

  it("rejects a malformed secret without touching the database", async () => {
    const result = await resolveSelfieLinkToken("too-short", NOW)

    expect(result).toEqual({ ok: false, reason: "malformed" })
    expect(findUnique).not.toHaveBeenCalled()
  })

  it("looks the token up by digest, never by the secret itself", async () => {
    await resolveSelfieLinkToken(SECRET, NOW)

    const where = findUnique.mock.calls[0][0].where
    expect(where.tokenHash).toBe(hashSelfieLinkSecret(SECRET))
    expect(JSON.stringify(where)).not.toContain(SECRET)
  })

  it("rejects an unknown token", async () => {
    findUnique.mockResolvedValue(null)
    expect(await resolveSelfieLinkToken(SECRET, NOW)).toEqual({ ok: false, reason: "unknown" })
  })

  it("rejects an invalidated token", async () => {
    findUnique.mockResolvedValue({ ...LIVE, invalidatedAt: new Date("2026-08-06T11:00:00.000Z") })
    expect(await resolveSelfieLinkToken(SECRET, NOW)).toEqual({ ok: false, reason: "invalidated" })
  })

  it("rejects an already-used token", async () => {
    findUnique.mockResolvedValue({ ...LIVE, usedAt: new Date("2026-08-06T11:00:00.000Z") })
    expect(await resolveSelfieLinkToken(SECRET, NOW)).toEqual({ ok: false, reason: "used" })
  })

  it("rejects a token at the instant it expires, not a moment later", async () => {
    findUnique.mockResolvedValue({ ...LIVE, expiresAt: NOW })
    expect(await resolveSelfieLinkToken(SECRET, NOW)).toEqual({ ok: false, reason: "expired" })
  })

  it("rejects a token whose application has left a capturable status", async () => {
    findFirst.mockResolvedValue(null)
    expect(await resolveSelfieLinkToken(SECRET, NOW)).toEqual({
      ok: false,
      reason: "application_changed",
    })
  })

  it("re-reads the application under the token's OWN tenant and client, not the request's", async () => {
    // The token names the application; nothing about the caller does. A
    // resolution that widened this where-clause would let one token's holder
    // act on another tenant's application.
    await resolveSelfieLinkToken(SECRET, NOW)

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "app1",
          tenantId: "t1",
          clientId: "c1",
          status: { in: ["SUBMITTED", "UNDER_REVIEW", "APPROVED"] },
        }),
      }),
    )
  })

  it("does not treat a decided application as capturable", async () => {
    await resolveSelfieLinkToken(SECRET, NOW)

    const statuses = findFirst.mock.calls[0][0].where.status.in as string[]
    for (const decided of ["DRAFT", "DECLINED", "CANCELLED", "DISBURSED"]) {
      expect(statuses).not.toContain(decided)
    }
  })
})
