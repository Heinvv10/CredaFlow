import { beforeEach, describe, expect, it, vi } from "vitest"

// The hand-off line recordAssistantReply writes, and the mode it opens, come from one hours check.
const m = vi.hoisted(() => ({
  messageCreate: vi.fn(), messageFindFirst: vi.fn(), leadFindFirst: vi.fn(), conversationUpdateMany: vi.fn(),
  handoffFindFirst: vi.fn(), handoffUpsert: vi.fn(), settingsFindUnique: vi.fn(), queryRaw: vi.fn(), executeRaw: vi.fn(),
}))
const tx = {
  message: { create: m.messageCreate, findFirst: m.messageFindFirst },
  lead: { findFirst: m.leadFindFirst },
  conversation: { updateMany: m.conversationUpdateMany },
  websiteChatHandoff: { findFirst: m.handoffFindFirst, upsert: m.handoffUpsert },
  commsSettings: { findUnique: m.settingsFindUnique },
  $queryRaw: m.queryRaw, $executeRaw: m.executeRaw,
}
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) } }))

import { recordAssistantReply } from "./store"

// 2026-09-30 is a Wednesday; SAST is UTC+2, so the default 17:00 close is 15:00Z.
const IN_HOURS = new Date("2026-09-30T10:00:00Z")
const JUST_BEFORE_CLOSE = new Date("2026-09-30T14:59:00Z")
const JUST_AFTER_CLOSE = new Date("2026-09-30T15:01:00Z")
const TUESDAY_10 = new Date("2026-09-29T08:00:00Z")
const CANT_JOIN = "Our consultants can't join the chat right now."
const ASKED = "Sure, I'll connect you to one of our consultants."
const CANT = "I can't help with that here, so I'll connect you to a consultant."
const AWAY = "Our consultants aren't available right now. They're available Monday to Friday, 08:00 to 17:00."

const base = { tenantId: "t1", conversationId: "conv_1" }
const visitorLine = () => m.messageCreate.mock.calls.map((c) => c[0].data).find((d) => d.direction === "OUTBOUND")?.bodyText
const upserted = () => m.handoffUpsert.mock.calls[0]?.[0].create.timedOutAt

beforeEach(() => {
  vi.clearAllMocks()
  m.messageCreate.mockResolvedValue({ id: "msg_1" })
  m.messageFindFirst.mockResolvedValue({ bodyText: "Website chat visitor ...\nCRM lead: /crm/leads/lead_1\n" })
  m.leadFindFirst.mockResolvedValue({ phone: "27821234567" })
  m.conversationUpdateMany.mockResolvedValue({ count: 1 })
  m.queryRaw.mockResolvedValue([{ status: "OPEN", assigneeId: null, closedAt: null }])
  m.handoffFindFirst.mockResolvedValue(null)
  m.settingsFindUnique.mockResolvedValue(null)
})

describe("recordAssistantReply hand-off line", () => {
  it("in hours, for a visitor who asked for a person, writes and returns the agreeing line, and opens the wait", async () => {
    const r = await recordAssistantReply({ ...base, reply: "", needsHuman: true, reason: "asked_for_person", now: IN_HOURS })
    expect(r).toEqual({ handedOffNow: true, suppressed: false, mode: "waiting", reply: ASKED })
    expect(visitorLine()).toBe(ASKED)
    expect(upserted()).toBeNull()
  })
  it("in hours, keeps the model's own text and puts the line after it", async () => {
    const r = await recordAssistantReply({ ...base, reply: "Please don't share ID numbers here.", needsHuman: true, reason: "account_question", now: JUST_BEFORE_CLOSE })
    expect(r).toMatchObject({ mode: "waiting", reply: `Please don't share ID numbers here.\n\n${CANT}` })
    expect(visitorLine()).toBe(`Please don't share ID numbers here.\n\n${CANT}`)
  })
  it("just after closing, the line is the after-hours one AND the mode is the fallback", async () => {
    const r = await recordAssistantReply({ ...base, reply: "", needsHuman: true, reason: "asked_for_person", now: JUST_AFTER_CLOSE })
    expect(r).toEqual({ handedOffNow: true, suppressed: false, mode: "fallback", reply: AWAY })
    expect(visitorLine()).toBe(AWAY)
    expect(upserted()).toEqual(JUST_AFTER_CLOSE)
  })
  it("names the tenant's configured hours, read once for both the line and the mode", async () => {
    m.settingsFindUnique.mockResolvedValue({ businessHours: { tz: "Africa/Johannesburg", days: { wed: { open: "08:00", close: "17:30" }, sat: { open: "08:00", close: "12:00" } } } })
    // 17:15 SAST: open under these hours, so it is still a wait and the in-hours line.
    const late = await recordAssistantReply({ ...base, reply: "", needsHuman: true, reason: "complaint", now: new Date("2026-09-30T15:15:00Z") })
    expect(late).toMatchObject({ mode: "waiting", reply: CANT })
    vi.clearAllMocks()
    m.conversationUpdateMany.mockResolvedValue({ count: 1 })
    const after = await recordAssistantReply({ ...base, reply: "", needsHuman: true, reason: "complaint", now: new Date("2026-09-30T15:31:00Z") })
    expect(after).toMatchObject({ mode: "fallback", reply: "Our consultants aren't available right now. They're available Wednesday, 08:00 to 17:30 and Saturday, 08:00 to 12:00." })
    expect(m.settingsFindUnique).toHaveBeenCalledTimes(1)
  })
  it("a cap hand-off notice (handoffOnly) gets the line for its server reason", async () => {
    const r = await recordAssistantReply({ ...base, reply: "", needsHuman: true, reason: "daily_limit", now: IN_HOURS, handoffOnly: true })
    expect(r).toMatchObject({ handedOffNow: true, mode: "waiting", reply: CANT })
    expect(visitorLine()).toBe(CANT)
  })
  describe("a second hand-off on a chat whose earlier wait timed out (already the fallback)", () => {
    beforeEach(() => {
      m.queryRaw.mockResolvedValue([{ status: "PENDING_INTERNAL", assigneeId: null, closedAt: null }])
      m.handoffFindFirst.mockResolvedValue({ timedOutAt: new Date("2026-09-29T07:50:00Z") })
      m.conversationUpdateMany.mockResolvedValue({ count: 0 })
    })
    it("within business hours (Tuesday 10:00 SAST) says nobody can join, and the mode stays the fallback", async () => {
      const r = await recordAssistantReply({ ...base, reply: "", needsHuman: true, reason: "asked_for_person", now: TUESDAY_10 })
      expect(r).toEqual({ handedOffNow: false, suppressed: false, reply: CANT_JOIN })
      expect(visitorLine()).toBe(CANT_JOIN)
      // No new wait: the chat is still the fallback.
      expect(m.handoffUpsert).not.toHaveBeenCalled()
    })
    it("after hours gives the hours line", async () => {
      const r = await recordAssistantReply({ ...base, reply: "", needsHuman: true, reason: "asked_for_person", now: JUST_AFTER_CLOSE })
      expect(r).toEqual({ handedOffNow: false, suppressed: false, reply: AWAY })
      expect(m.handoffUpsert).not.toHaveBeenCalled()
    })
  })
  it("leaves a reply that is not a hand-off as the model wrote it", async () => {
    const r = await recordAssistantReply({ ...base, reply: "08:00 to 17:00.", needsHuman: false, reason: null, now: JUST_AFTER_CLOSE })
    expect(r).toEqual({ handedOffNow: false, suppressed: false, reply: "08:00 to 17:00." })
    expect(visitorLine()).toBe("08:00 to 17:00.")
  })
})
