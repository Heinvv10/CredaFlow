import { beforeEach, describe, expect, it, vi } from "vitest"
import { countTodaysVisitorMessages } from "./limits"

const count = vi.fn()
const tx = { message: { count } } as unknown as Parameters<typeof countTodaysVisitorMessages>[0]

beforeEach(() => {
  vi.clearAllMocks()
  count.mockResolvedValue(7)
})

describe("countTodaysVisitorMessages", () => {
  it("counts the tenant's inbound website-chat messages that went to the assistant", async () => {
    expect(await countTodaysVisitorMessages(tx, "t1", new Date("2026-09-29T10:00:00Z"))).toBe(7)
    expect(count.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", channel: "CHATBOT", provider: "CHATBOT", direction: "INBOUND", conversation: { tenantId: "t1", channel: "CHATBOT" } })
  })
  // 23:30 SAST on the 29th is still the 29th in SAST, and 00:30 SAST on the
  // 30th is still the 29th in UTC: UTC midnight gets both of these wrong.
  it.each([
    ["2026-09-29T21:30:00Z", "2026-09-28T22:00:00.000Z"],
    ["2026-09-29T22:30:00Z", "2026-09-29T22:00:00.000Z"],
  ])("at %s counts from SAST midnight %s", async (now, start) => {
    await countTodaysVisitorMessages(tx, "t1", new Date(now))
    const where = count.mock.calls[0][0].where
    expect(where.createdAt.gte.toISOString()).toBe(start)
    // The index pre-filter must never be narrower than the exact bound.
    expect(where.conversation.lastInboundAt.gte.getTime()).toBeLessThanOrEqual(where.createdAt.gte.getTime())
  })
})
