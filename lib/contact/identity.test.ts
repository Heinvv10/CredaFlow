import { describe, it, expect, vi } from "vitest"
import { lookupContactByChannelValue } from "./identity"
import type { Channel } from "@prisma/client"

describe("lookupContactByChannelValue", () => {
  type PrismaLike = Parameters<typeof lookupContactByChannelValue>[0]

  function fakePrisma(idRows: Array<{ contact: { id: string; tenantId: string } }>): PrismaLike {
    return {
      contactIdentity: {
        findFirst: vi.fn(async () => idRows[0] ?? null),
      },
    } as unknown as PrismaLike
  }

  it("returns the joined contact when an identity row matches (tenantId, channel, value)", async () => {
    const px = fakePrisma([{ contact: { id: "ct_known", tenantId: "tenant_a" } }])
    const found = await lookupContactByChannelValue(px, {
      tenantId: "tenant_a",
      channel: "WHATSAPP" as Channel,
      value: "27821234567@s.whatsapp.net",
    })
    expect(found).toEqual({ id: "ct_known", tenantId: "tenant_a" })
  })

  it("returns null when no identity row matches", async () => {
    const px = fakePrisma([])
    const found = await lookupContactByChannelValue(px, {
      tenantId: "tenant_a",
      channel: "WHATSAPP" as Channel,
      value: "unknown@s.whatsapp.net",
    })
    expect(found).toBeNull()
  })

  it("scopes the query by (tenantId, channel, value)", async () => {
    const findFirst = vi.fn(async () => null)
    const px = { contactIdentity: { findFirst } } as unknown as PrismaLike
    await lookupContactByChannelValue(px, {
      tenantId: "tenant_a",
      channel: "WHATSAPP" as Channel,
      value: "27821234567@s.whatsapp.net",
    })
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant_a",
        channel: "WHATSAPP",
        value: "27821234567@s.whatsapp.net",
      },
      include: { contact: true },
    })
  })
})
