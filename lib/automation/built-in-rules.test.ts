import { beforeEach, describe, expect, it, vi } from "vitest"

const findManyMock = vi.fn()
const updateMock = vi.fn()
const updateManyMock = vi.fn()
const createMock = vi.fn()
const createManyMock = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    automationRule: {
      findMany: (args: unknown) => findManyMock(args),
      update: (args: unknown) => updateMock(args),
      updateMany: (args: unknown) => updateManyMock(args),
      create: (args: unknown) => createMock(args),
      createMany: (args: unknown) => createManyMock(args),
    },
  },
}))

import { ensureBuiltInRules } from "./built-in-rules"

beforeEach(() => {
  vi.clearAllMocks()
  updateMock.mockResolvedValue({})
  updateManyMock.mockResolvedValue({ count: 0 })
  createMock.mockResolvedValue({})
  createManyMock.mockResolvedValue({ count: 0 })
})

describe("ensureBuiltInRules Section 129 policy migration", () => {
  it("migrates the persisted 20-DPD built-in in place to the canonical 90-DPD rule", async () => {
    findManyMock.mockResolvedValue([{
      id: "legacy-s129",
      name: "DPD 20 — Section 129 task",
      action: "ISSUE_SECTION_129",
      enabled: true,
    }])

    await ensureBuiltInRules("tenant-1")

    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "legacy-s129" },
      data: expect.objectContaining({
        name: "DPD 90 — Section 129 task",
        condition: { dpdThreshold: 90 },
      }),
    })
    expect(updateMock.mock.calls[0][0].data).not.toHaveProperty("enabled")
    expect(createMock).not.toHaveBeenCalled()
  })

  it("disables duplicate persisted Section 129 built-ins", async () => {
    findManyMock.mockResolvedValue([
      { id: "canonical", name: "DPD 90 — Section 129 task", action: "ISSUE_SECTION_129", enabled: true },
      { id: "legacy", name: "DPD 20 — Section 129 task", action: "ISSUE_SECTION_129", enabled: true },
    ])

    await ensureBuiltInRules("tenant-1")

    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: { in: ["legacy"] } },
      data: { enabled: false },
    })
  })
})
