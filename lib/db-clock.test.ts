import { describe, expect, it } from "vitest"
import { databaseNow } from "@/lib/db-clock"

describe("databaseNow", () => {
  it("returns the database's clock", async () => {
    const at = new Date("2026-10-14T10:00:00.123Z")
    expect(await databaseNow({ $queryRaw: async <T,>() => [{ now: at }] as T })).toBe(at)
  })

  it.each([[[]], [[{ now: "2026-10-14" }]], [[{ now: new Date("nope") }]]])(
    "refuses to guess when the clock cannot be read (%j)",
    async (rows) => {
      await expect(databaseNow({ $queryRaw: async <T,>() => rows as T })).rejects.toThrow("database clock")
    },
  )
})
