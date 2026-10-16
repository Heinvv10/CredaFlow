import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ findMany: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { complianceRecord: { findMany: (...a: unknown[]) => h.findMany(...a) } } }))

import { latestSection129Failures } from "./section129-failures"

const row = (referenceId: string, createdAt: string, data: Record<string, unknown>) => ({ referenceId, createdAt: new Date(createdAt), data })

beforeEach(() => h.findMany.mockReset())

describe("latestSection129Failures", () => {
  it("reports a loan whose latest attempt was not sent, with its recorded reason", async () => {
    h.findMany.mockResolvedValue([
      row("L1", "2026-10-16T10:00:00Z", { lifecycle: "FAILED", failedAt: "2026-10-16T10:00:01.000Z", failureReason: "Email not configured for this tenant. Go to Settings → Email." }),
    ])
    const failures = await latestSection129Failures("t1", ["L1"])
    expect(failures.get("L1")).toEqual({ failedAt: new Date("2026-10-16T10:00:01.000Z"), reason: "Email not configured for this tenant. Go to Settings → Email." })
    expect(h.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "t1", type: "SECTION_129_NOTICE", referenceId: { in: ["L1"] } },
    }))
  })

  it("forgets the failure once a later attempt was issued", async () => {
    h.findMany.mockResolvedValue([
      row("L1", "2026-10-17T10:00:00Z", { lifecycle: "ISSUED" }),
      row("L1", "2026-10-16T10:00:00Z", { lifecycle: "FAILED", failureReason: "smtp down" }),
    ])
    expect((await latestSection129Failures("t1", ["L1"])).has("L1")).toBe(false)
  })

  it("asks nothing for an empty queue", async () => {
    expect((await latestSection129Failures("t1", [])).size).toBe(0)
    expect(h.findMany).not.toHaveBeenCalled()
  })
})
