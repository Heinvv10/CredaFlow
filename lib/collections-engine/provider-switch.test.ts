import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ findUnique: vi.fn(), mandates: vi.fn(), instructions: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: m.findUnique },
    debitMandate: { count: m.mandates },
    collectionInstruction: { count: m.instructions },
  },
}))

import { providerSwitchBlockers } from "./provider-switch"

describe("providerSwitchBlockers", () => {
  beforeEach(() => {
    m.findUnique.mockReset().mockResolvedValue({ collectionProvider: "netcash" })
    m.mandates.mockReset().mockResolvedValue(0)
    m.instructions.mockReset().mockResolvedValue(0)
  })

  it("blocks a switch while the current provider holds a non-terminal mandate or an open instruction", async () => {
    m.mandates.mockResolvedValue(2)
    m.instructions.mockResolvedValue(1)
    expect(await providerSwitchBlockers("t1", "simulated")).toEqual({ current: "netcash", mandates: 2, instructions: 1 })
    expect(m.mandates).toHaveBeenCalledWith({ where: {
      tenantId: "t1", provider: "netcash",
      status: { in: ["CREATED", "SUBMITTING", "PENDING_REGISTRATION", "PENDING_AUTH", "ACTIVE", "SUSPENDED"] },
    } })
    expect(m.instructions).toHaveBeenCalledWith({ where: {
      tenantId: "t1", mandate: { provider: "netcash" },
      status: { in: ["PENDING", "SUBMITTING", "UPLOADED", "SUBMITTED", "NEEDS_REVIEW"] },
    } })
  })

  it("blocks switching the engine's provider off (null) as well", async () => {
    m.instructions.mockResolvedValue(1)
    expect(await providerSwitchBlockers("t1", null)).toMatchObject({ current: "netcash", instructions: 1 })
  })

  it("allows the switch when nothing is live on the current provider", async () => {
    expect(await providerSwitchBlockers("t1", "simulated")).toBeNull()
  })

  it("allows saving the same provider, or setting the first one, without counting anything", async () => {
    expect(await providerSwitchBlockers("t1", "netcash")).toBeNull()
    m.findUnique.mockResolvedValue({ collectionProvider: null })
    expect(await providerSwitchBlockers("t1", "netcash")).toBeNull()
    m.findUnique.mockResolvedValue(null)
    expect(await providerSwitchBlockers("t1", "netcash")).toBeNull()
    expect(m.mandates).not.toHaveBeenCalled()
  })
})
