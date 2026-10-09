import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  tokenFindUniqueMock,
  tokenUpdateManyMock,
  tokenCreateMock,
  applicationFindFirstMock,
} = vi.hoisted(() => ({
  tokenFindUniqueMock: vi.fn(),
  tokenUpdateManyMock: vi.fn(),
  tokenCreateMock: vi.fn(),
  applicationFindFirstMock: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    pasqAcknowledgementToken: {
      findUnique: (...args: unknown[]) => tokenFindUniqueMock(...args),
      updateMany: (...args: unknown[]) => tokenUpdateManyMock(...args),
      create: (...args: unknown[]) => tokenCreateMock(...args),
    },
    loanApplication: {
      findFirst: (...args: unknown[]) => applicationFindFirstMock(...args),
    },
  },
}))

import {
  hashPasqLinkSecret,
  isPasqLinkSecret,
  maskDestination,
  mintPasqLinkToken,
  resolvePasqLinkToken,
} from "./pasq-link-token.server"

const now = new Date("2026-07-28T10:00:00.000Z")
const documentSha256 = "d".repeat(64)

function storedToken(overrides: Record<string, unknown> = {}) {
  const secret = "s".repeat(43)
  return {
    secret,
    row: {
      id: "token-1",
      tenantId: "tenant-1",
      applicationId: "app-1",
      clientId: "client-1",
      documentSha256,
      tokenHash: hashPasqLinkSecret(secret),
      channel: "SMS",
      expiresAt: new Date("2026-07-30T10:00:00.000Z"),
      usedAt: null as Date | null,
      invalidatedAt: null as Date | null,
      ...overrides,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  applicationFindFirstMock.mockResolvedValue({
    pasqDocumentId: "pasq-1",
    client: { email: "consumer@example.test" },
  })
  tokenUpdateManyMock.mockResolvedValue({ count: 0 })
  tokenCreateMock.mockResolvedValue({ id: "token-new" })
})

describe("PASQ link secrets", () => {
  it("accepts only a 43-character base64url secret", () => {
    expect(isPasqLinkSecret("a".repeat(43))).toBe(true)
    expect(isPasqLinkSecret("a".repeat(42))).toBe(false)
    expect(isPasqLinkSecret("a".repeat(44))).toBe(false)
    // Path traversal and padding must not reach the database lookup.
    expect(isPasqLinkSecret("../".padEnd(43, "a"))).toBe(false)
    expect(isPasqLinkSecret(`${"a".repeat(42)}=`)).toBe(false)
    expect(isPasqLinkSecret(null)).toBe(false)
  })

  it("hashes deterministically and never echoes the secret", () => {
    const secret = "b".repeat(43)
    const hash = hashPasqLinkSecret(secret)

    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).toBe(hashPasqLinkSecret(secret))
    expect(hash).not.toContain(secret)
    expect(hashPasqLinkSecret("c".repeat(43))).not.toBe(hash)
  })

  it("masks all but the last four digits of a destination", () => {
    expect(maskDestination("+27821234567")).toBe("********4567")
  })

  it("masks an email address to its first character and domain", () => {
    expect(maskDestination("sipho.nkosi@example.co.za")).toBe("s**********@example.co.za")
    expect(maskDestination("a@b.com")).toBe("a*@b.com")
    // '@' at position 0 is not an email shape — falls through to phone masking.
    expect(maskDestination("@handle")).toBe("***ndle")
  })
})

describe("mintPasqLinkToken", () => {
  it("stores only the hash and invalidates every prior active token", async () => {
    const minted = await mintPasqLinkToken(
      { pasqAcknowledgementToken: {
        updateMany: tokenUpdateManyMock,
        create: tokenCreateMock,
      } } as never,
      {
        tenantId: "tenant-1",
        applicationId: "app-1",
        clientId: "client-1",
        documentSha256,
        channel: "SMS",
        sentTo: "+27821234567",
        createdById: "officer-1",
        now,
      },
    )

    expect(isPasqLinkSecret(minted.secret)).toBe(true)
    expect(minted.tokenHash).toBe(hashPasqLinkSecret(minted.secret))
    // Only one link may be live at a time, so a re-send cannot leave an older
    // message working.
    expect(tokenUpdateManyMock).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        applicationId: "app-1",
        usedAt: null,
        invalidatedAt: null,
      },
      data: { invalidatedAt: now },
    })
    const created = tokenCreateMock.mock.calls[0][0].data
    expect(created.tokenHash).toBe(minted.tokenHash)
    // The secret itself must never be persisted in any column.
    expect(JSON.stringify(created)).not.toContain(minted.secret)
    expect(minted.expiresAt).toEqual(new Date("2026-07-30T10:00:00.000Z"))
  })

  it("mints a different secret every time", async () => {
    const args = {
      tenantId: "tenant-1",
      applicationId: "app-1",
      clientId: "client-1",
      documentSha256,
      channel: "SMS" as const,
      sentTo: "+27821234567",
      createdById: "officer-1",
      now,
    }
    const tx = { pasqAcknowledgementToken: {
      updateMany: tokenUpdateManyMock,
      create: tokenCreateMock,
    } } as never

    const first = await mintPasqLinkToken(tx, args)
    const second = await mintPasqLinkToken(tx, args)

    expect(first.secret).not.toBe(second.secret)
  })
})

describe("resolvePasqLinkToken", () => {
  it("resolves a live token to its application", async () => {
    const { secret, row } = storedToken()
    tokenFindUniqueMock.mockResolvedValue(row)

    const result = await resolvePasqLinkToken(secret, now)

    expect(result).toEqual({
      ok: true,
      link: {
        tokenId: "token-1",
        tenantId: "tenant-1",
        applicationId: "app-1",
        clientId: "client-1",
        clientEmail: "consumer@example.test",
        documentId: "pasq-1",
        documentSha256,
        channel: "SMS",
      },
    })
    expect(tokenFindUniqueMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { tokenHash: hashPasqLinkSecret(secret) },
    }))
  })

  it("rejects a malformed secret without touching the database", async () => {
    const result = await resolvePasqLinkToken("nope", now)

    expect(result).toEqual({ ok: false, reason: "malformed" })
    expect(tokenFindUniqueMock).not.toHaveBeenCalled()
  })

  it("rejects an unknown secret", async () => {
    tokenFindUniqueMock.mockResolvedValue(null)

    expect(await resolvePasqLinkToken("z".repeat(43), now))
      .toEqual({ ok: false, reason: "unknown" })
  })

  it.each([
    ["invalidated", { invalidatedAt: new Date("2026-07-28T09:00:00.000Z") }],
    ["used", { usedAt: new Date("2026-07-28T09:30:00.000Z") }],
    ["expired", { expiresAt: new Date("2026-07-28T09:59:59.000Z") }],
  ])("rejects a %s token", async (reason, overrides) => {
    const { secret, row } = storedToken(overrides)
    tokenFindUniqueMock.mockResolvedValue(row)

    expect(await resolvePasqLinkToken(secret, now)).toEqual({ ok: false, reason })
    expect(applicationFindFirstMock).not.toHaveBeenCalled()
  })

  it("rejects a token whose expiry has exactly elapsed", async () => {
    const { secret, row } = storedToken({ expiresAt: now })
    tokenFindUniqueMock.mockResolvedValue(row)

    expect(await resolvePasqLinkToken(secret, now))
      .toEqual({ ok: false, reason: "expired" })
  })

  it("re-reads the application state rather than trusting the stored row", async () => {
    // The token must not outlive the state it was minted for: a quotation that
    // has since been acknowledged, superseded, or turned into an agreement is
    // no longer something this link may act on.
    const { secret, row } = storedToken()
    tokenFindUniqueMock.mockResolvedValue(row)
    applicationFindFirstMock.mockResolvedValue(null)

    expect(await resolvePasqLinkToken(secret, now))
      .toEqual({ ok: false, reason: "application_changed" })
    expect(applicationFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "app-1",
        tenantId: "tenant-1",
        clientId: "client-1",
        status: "APPROVED",
        agreementGeneratedAt: null,
        pasqDocumentSha256: documentSha256,
        pasqAcknowledgedAt: null,
      }),
    }))
  })

  it("rejects a token whose application lost its bound document", async () => {
    const { secret, row } = storedToken()
    tokenFindUniqueMock.mockResolvedValue(row)
    applicationFindFirstMock.mockResolvedValue({
      pasqDocumentId: null,
      client: { email: "consumer@example.test" },
    })

    expect(await resolvePasqLinkToken(secret, now))
      .toEqual({ ok: false, reason: "application_changed" })
  })
})
