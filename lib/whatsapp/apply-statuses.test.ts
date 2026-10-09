import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: { message: { updateMany: vi.fn() } } }))
import { prisma } from "@/lib/prisma"
import { applyWabaStatuses, mapWabaStatus } from "./apply-statuses"

describe("mapWabaStatus", () => {
  it("maps Meta statuses to MsgStatus", () => {
    expect(mapWabaStatus("sent")).toBe("SENT")
    expect(mapWabaStatus("delivered")).toBe("DELIVERED")
    expect(mapWabaStatus("read")).toBe("READ")
    expect(mapWabaStatus("failed")).toBe("FAILED")
    expect(mapWabaStatus("unknown")).toBeNull()
  })
})

describe("applyWabaStatuses", () => {
  beforeEach(() => vi.clearAllMocks())
  it("updates Message by (provider, providerMessageId) for each mappable status", async () => {
    vi.mocked(prisma.message.updateMany).mockResolvedValue({ count: 1 } as never)
    await applyWabaStatuses("tn1", [
      { providerMessageId: "wamid.1", status: "delivered" },
      { providerMessageId: "wamid.2", status: "bogus" },
    ])
    expect(prisma.message.updateMany).toHaveBeenCalledTimes(1)
    expect(prisma.message.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "tn1", provider: "WA_CLOUD", providerMessageId: "wamid.1" },
      data: { status: "DELIVERED" },
    })
  })
})
