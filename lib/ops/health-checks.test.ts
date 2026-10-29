import { beforeEach, describe, expect, it, vi } from "vitest"

const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: queryRaw } }))
vi.mock("@/lib/storage", () => ({}))

import { probeDatabase } from "./health-checks"

beforeEach(() => {
  queryRaw.mockReset()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("probeDatabase (the readiness probe's only check)", () => {
  it("is ok, with a latency, when SELECT 1 answers", async () => {
    queryRaw.mockResolvedValue([{ "?column?": 1 }])
    const result = await probeDatabase()
    expect(result.state).toBe("ok")
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it("is an error, not a throw, when the query rejects", async () => {
    queryRaw.mockRejectedValue(new Error("connection refused"))
    await expect(probeDatabase()).resolves.toMatchObject({ state: "error" })
  })
})
