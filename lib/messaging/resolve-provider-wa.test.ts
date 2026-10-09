import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: { commsSettings: { findUnique: vi.fn() } },
}))

import { prisma } from "@/lib/prisma"
import { resolveProvider } from "./send"

describe("resolveProvider WHATSAPP", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns WA_CLOUD when the tenant selected it", async () => {
    vi.mocked(prisma.commsSettings.findUnique).mockResolvedValue({ waProvider: "WA_CLOUD" } as never)
    await expect(resolveProvider("WHATSAPP", "tn1")).resolves.toBe("WA_CLOUD")
  })

  it("defaults to WA_UNOFFICIAL when unset or bridge-selected", async () => {
    vi.mocked(prisma.commsSettings.findUnique).mockResolvedValue({ waProvider: "WA_UNOFFICIAL" } as never)
    await expect(resolveProvider("WHATSAPP", "tn1")).resolves.toBe("WA_UNOFFICIAL")
  })

  it("defaults to WA_UNOFFICIAL when there is no settings row", async () => {
    vi.mocked(prisma.commsSettings.findUnique).mockResolvedValue(null as never)
    await expect(resolveProvider("WHATSAPP", "tn1")).resolves.toBe("WA_UNOFFICIAL")
  })

  it("defaults to WA_UNOFFICIAL when no tenantId is given", async () => {
    await expect(resolveProvider("WHATSAPP")).resolves.toBe("WA_UNOFFICIAL")
  })
})
