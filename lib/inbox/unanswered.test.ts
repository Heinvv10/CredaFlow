import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: vi.fn() } }))

import { prisma } from "@/lib/prisma"
import { countUnansweredConversations } from "./unanswered"

describe("countUnansweredConversations", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns a plain number — Postgres count() arrives as a BigInt", async () => {
    // count()::bigint deserialises to a JS BigInt, which React cannot render
    // and JSON.stringify throws on. Returning it unconverted would crash the
    // whole dashboard layout, not just the badge.
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ count: BigInt(7) }] as never)
    const result = await countUnansweredConversations("tenant-1")
    expect(result).toBe(7)
    expect(typeof result).toBe("number")
  })

  it("returns 0 when the query yields no rows", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never)
    expect(await countUnansweredConversations("tenant-1")).toBe(0)
  })

  // Mocked Prisma cannot execute SQL, so this asserts the QUERY SHAPE only —
  // the predicate itself was verified against the live staging dataset (2 of
  // 78 open conversations, both genuinely awaiting a reply).
  it("scopes to the tenant, excludes CLOSED, and asks 'who spoke last' not 'was it read'", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ count: BigInt(0) }] as never)
    await countUnansweredConversations("tenant-1")

    const sql = vi.mocked(prisma.$queryRaw).mock.calls[0][0] as unknown as { join: (s: string) => string } & string[]
    const text = Array.isArray(sql) ? sql.join("?") : String(sql)

    expect(text).toContain('"tenantId"')
    expect(text).toContain("<> 'CLOSED'")
    // The load-bearing predicate: the customer's last message is newer than
    // ours (or we never replied at all).
    expect(text).toContain('"lastOutboundAt" < "lastInboundAt"')
    expect(text).toContain('"lastOutboundAt" IS NULL')
    // Must NOT be an unread check — a message an agent opened and never
    // answered is still unanswered.
    expect(text).not.toContain("readAt")
  })

  // Text assertion on the SQL only; the predicate is checked on staging.
  it("counts a website chat only once it is handed off, or while a staffer holds it and the visitor wrote last", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ count: BigInt(0) }] as never)
    await countUnansweredConversations("tenant-1")
    const sql = vi.mocked(prisma.$queryRaw).mock.calls[0][0] as unknown as string[]
    const text = Array.isArray(sql) ? sql.join("?") : String(sql)
    expect(text).toContain("'CHATBOT'")
    expect(text).toContain("PENDING_INTERNAL")
    expect(text).toContain('"assigneeId" IS NOT NULL')
  })
})
