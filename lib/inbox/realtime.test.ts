/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"

vi.mock("./conversations", () => ({ listConversations: vi.fn() }))

import { getInboxDeltas } from "./realtime"
import { listConversations } from "./conversations"

beforeEach(() => vi.clearAllMocks())

const summary = (id: string, updatedAt: string) => ({ id, updatedAt } as any)

it("returns only conversations changed after `since` with the newest cursor", async () => {
  vi.mocked(listConversations).mockResolvedValue({
    conversations: [
      summary("cv3", "2026-07-05T12:00:03.000Z"),
      summary("cv2", "2026-07-05T12:00:02.000Z"),
      summary("cv1", "2026-07-05T12:00:00.000Z"),
    ],
    nextCursor: null,
  } as any)

  const r = await getInboxDeltas({ tenantId: "t1", agentUserId: "u1", queue: "all", since: "2026-07-05T12:00:01.000Z" })
  expect(r.conversations.map((c) => c.id)).toEqual(["cv3", "cv2"])
  expect(r.cursor).toBe("2026-07-05T12:00:03.000Z")
})

it("keeps the incoming cursor when nothing changed", async () => {
  vi.mocked(listConversations).mockResolvedValue({
    conversations: [summary("cv1", "2026-07-05T12:00:00.000Z")],
    nextCursor: null,
  } as any)
  const r = await getInboxDeltas({ tenantId: "t1", agentUserId: "u1", queue: "mine", since: "2026-07-05T12:00:01.000Z" })
  expect(r.conversations).toEqual([])
  expect(r.cursor).toBe("2026-07-05T12:00:01.000Z")
})

it("first poll (since=null) returns nothing and a baseline cursor", async () => {
  vi.mocked(listConversations).mockResolvedValue({ conversations: [summary("cv1", "2026-07-05T12:00:00.000Z")], nextCursor: null } as any)
  const r = await getInboxDeltas({ tenantId: "t1", agentUserId: "u1", queue: "all", since: null })
  expect(r.conversations).toEqual([])
  expect(typeof r.cursor).toBe("string")
})
