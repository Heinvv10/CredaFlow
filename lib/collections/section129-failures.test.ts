import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ queryRaw: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: (...a: unknown[]) => h.queryRaw(...a) } }))

import { latestSection129Failures } from "./section129-failures"

const row = (referenceId: string, createdAt: string, lifecycle: string, failureReason: string | null = null, failedAt: string | null = null) =>
  ({ referenceId, createdAt: new Date(createdAt), lifecycle, failureReason, failedAt })
const sqlOf = () => (h.queryRaw.mock.calls[0][0] as { strings: string[] }).strings.join("?")

beforeEach(() => h.queryRaw.mockReset())

describe("latestSection129Failures", () => {
  it("reports a loan whose latest attempt was not sent, with its recorded reason", async () => {
    h.queryRaw.mockResolvedValue([row("L1", "2026-10-16T10:00:00Z", "FAILED", "Email not configured for this tenant. Go to Settings → Email.", "2026-10-16T10:00:01.000Z")])
    const failures = await latestSection129Failures("t1", ["L1"])
    expect(failures.get("L1")).toEqual({ failedAt: new Date("2026-10-16T10:00:01.000Z"), reason: "Email not configured for this tenant. Go to Settings → Email." })
  })

  it("forgets the failure once a later attempt was not a failure", async () => {
    h.queryRaw.mockResolvedValue([row("L1", "2026-10-17T10:00:00Z", "ISSUED")])
    expect((await latestSection129Failures("t1", ["L1"])).has("L1")).toBe(false)
  })

  // #147 review: the record carries the borrower's name, ID number and address.
  it("reads only the latest record per loan and only the fields it shows", async () => {
    h.queryRaw.mockResolvedValue([])
    await latestSection129Failures("t1", ["L1", "L2"])
    const sql = sqlOf()
    expect(sql).toContain(`DISTINCT ON ("referenceId")`)
    expect(sql).toContain(`ORDER BY "referenceId", "createdAt" DESC`)
    expect(sql).toMatch(/"data" ->> 'failureReason'/)
    expect(sql).not.toMatch(/SELECT[^]*"data"\s*,|SELECT \*/)
    expect(h.queryRaw.mock.calls[0][0].values).toEqual(["t1", "L1", "L2"])
  })

  it("asks nothing for an empty queue", async () => {
    expect((await latestSection129Failures("t1", [])).size).toBe(0)
    expect(h.queryRaw).not.toHaveBeenCalled()
  })
})
