import { beforeEach, describe, expect, it, vi } from "vitest"

const findFirst = vi.hoisted(() => vi.fn())
vi.mock("@/lib/prisma", () => ({ prisma: { auditLog: { findFirst: (...a: unknown[]) => findFirst(...a) } } }))

import { lastReturnedToReview } from "./return-to-review"

beforeEach(() => findFirst.mockReset())

describe("lastReturnedToReview", () => {
  it("reads the newest return-to-review row of exactly this application and tenant", async () => {
    findFirst.mockResolvedValue({ createdAt: new Date("2026-10-16T10:00:00.000Z") })
    expect(await lastReturnedToReview("tenant-1", "app-1")).toEqual(new Date("2026-10-16T10:00:00.000Z"))
    expect(findFirst).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", action: "APPLICATION_RETURNED_TO_REVIEW", entity: "LoanApplication", entityId: "app-1" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    })
  })

  it("is null for an application never returned", async () => {
    findFirst.mockResolvedValue(null)
    expect(await lastReturnedToReview("tenant-1", "app-1")).toBeNull()
  })
})
