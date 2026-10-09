import { describe, expect, it, vi } from "vitest"
import { quotationValidUntilDateFromDatabase } from "./sa-business-calendar.server"

describe("quotationValidUntilDateFromDatabase", () => {
  it("uses the database calendar result", async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      { validUntilDate: "2024-05-30" },
    ])

    await expect(quotationValidUntilDateFromDatabase(
      { $queryRaw: queryRaw },
      new Date("2024-05-22T08:00:00.000Z"),
    )).resolves.toBe("2024-05-30")
    expect(queryRaw).toHaveBeenCalledOnce()
  })

  it("fails closed when the calendar result is absent or malformed", async () => {
    const queryRaw = vi.fn().mockResolvedValue([])

    await expect(quotationValidUntilDateFromDatabase(
      { $queryRaw: queryRaw },
      new Date("2024-05-22T08:00:00.000Z"),
    )).rejects.toThrow(/returned no valid date/i)
  })
})
