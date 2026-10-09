import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  leadCreate: vi.fn(), leadFindFirst: vi.fn(), leadFindMany: vi.fn(), activityCreate: vi.fn(), contactCreate: vi.fn(), contactFindMany: vi.fn(),
  consentCreate: vi.fn(), messageCreate: vi.fn(), messageCount: vi.fn(), messageFindFirst: vi.fn(),
  conversationUpdate: vi.fn(), conversationUpdateMany: vi.fn(), handoffFindFirst: vi.fn(), handoffUpsert: vi.fn(), settingsFindUnique: vi.fn(), queryRaw: vi.fn(), executeRaw: vi.fn(), resolveThread: vi.fn(), order: [] as string[],
}))
const tx = {
  lead: { create: m.leadCreate, findFirst: m.leadFindFirst, findMany: m.leadFindMany }, crmActivity: { create: m.activityCreate },
  contact: { create: m.contactCreate, findMany: m.contactFindMany },
  contactConsent: { create: m.consentCreate },
  message: { create: m.messageCreate, count: m.messageCount, findFirst: m.messageFindFirst },
  conversation: { update: m.conversationUpdate, updateMany: m.conversationUpdateMany },
  websiteChatHandoff: { findFirst: m.handoffFindFirst, upsert: m.handoffUpsert },
  commsSettings: { findUnique: m.settingsFindUnique },
  $queryRaw: m.queryRaw, $executeRaw: m.executeRaw,
}
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) } }))
vi.mock("@/lib/inbox/resolve-thread", () => ({ resolveOpenThreadForContact: m.resolveThread }))

import { recordAssistantReply, recordVisitorMessage, recordVisitorMessageToStaff, startChat } from "./store"

const NOW = new Date("2026-09-29T10:00:00Z")
type Sql = { sql: string; values: unknown[] }
/** The thread stamps written (stampThread's raw UPDATE): [column, instant] per write. */
const stamps = () => m.executeRaw.mock.calls
  .filter(([sql]) => (sql as string[]).join("").includes('UPDATE "Conversation"'))
  .map(([, column, , at]) => [(column as Sql).sql, (at as Sql).values[0]])
const FIELDS = { firstName: "Thandi", lastName: "Mokoena", phone: "27821234567", email: "thandi@example.co.za" }

beforeEach(() => {
  vi.clearAllMocks()
  m.order.length = 0
  m.leadCreate.mockResolvedValue({ id: "lead_1" })
  m.contactCreate.mockResolvedValue({ id: "contact_1" })
  m.contactFindMany.mockResolvedValue([])
  m.leadFindMany.mockResolvedValue([])
  m.resolveThread.mockImplementation(async () => { m.order.push("thread"); return { id: "conv_1", created: true } })
  m.activityCreate.mockImplementation(async () => { m.order.push("activity"); return { id: "act_1" } })
  m.messageCreate.mockResolvedValue({ id: "msg_1" })
  m.messageCount.mockResolvedValue(0)
  m.messageFindFirst.mockResolvedValue({ bodyText: "Website chat visitor ...\nCRM lead: /crm/leads/lead_1\n\nThese details match ..." })
  m.leadFindFirst.mockResolvedValue({ phone: "27821234567" })
  m.conversationUpdateMany.mockResolvedValue({ count: 1 })
  m.queryRaw.mockResolvedValue([{ status: "OPEN", assigneeId: null, closedAt: null }])
  m.handoffFindFirst.mockResolvedValue(null)
  m.settingsFindUnique.mockResolvedValue(null)
})

describe("startChat", () => {
  it("creates a contact with no lead link, no identities and no primary phone/email", async () => {
    await startChat({ brand: "Acme Lending", tenantId: "t1", fields: FIELDS, now: NOW })
    const data = m.contactCreate.mock.calls[0][0].data
    expect(data).toMatchObject({ tenantId: "t1", status: "LEAD", firstSeenChannel: "CHATBOT" })
    for (const k of ["leadId", "identities", "primaryPhone", "primaryEmail", "primaryWaJid"]) expect(data).not.toHaveProperty(k)
  })
  it("tags the lead unverified and records chat consent", async () => {
    await startChat({ brand: "Acme Lending", tenantId: "t1", fields: FIELDS, now: NOW })
    expect(m.leadCreate.mock.calls[0][0].data).toMatchObject({ source: "WEBSITE", status: "NEW", tags: ["website-chat", "unverified"], phone: "27821234567" })
    expect(m.consentCreate.mock.calls[0][0].data).toMatchObject({ contactId: "contact_1", channel: "CHATBOT", purpose: "CHATBOT_TRANSCRIPT_RETAIN", status: "GRANTED", source: "CHATBOT_OPT_IN", evidenceRef: "website-chat-consent-v1" })
  })
  it("writes the visitor details note naming the lead, then the greeting", async () => {
    const r = await startChat({ brand: "Acme Lending", tenantId: "t1", fields: FIELDS, now: NOW })
    const [note, greeting] = m.messageCreate.mock.calls.map((c) => c[0].data)
    expect(note).toMatchObject({ direction: "INTERNAL_NOTE", isInternal: true, channel: "CHATBOT" })
    expect(note.bodyText).toContain("cell +27821234567,")
    expect(note.bodyText).toContain("NOT verified")
    expect(note.bodyText).toContain("CRM lead: /crm/leads/lead_1")
    expect(greeting).toMatchObject({ direction: "OUTBOUND", channel: "CHATBOT", provider: "CHATBOT", bodyText: r.greeting, sentAt: NOW })
  })
  it("opens the thread under a chat ref, names it on its own line before the lead link, and returns it", async () => {
    const r = await startChat({ brand: "Acme Lending", tenantId: "t1", fields: FIELDS, now: NOW })
    expect(r.ref).toMatch(/^WC-[A-HJ-NP-Z2-9]{6}$/)
    expect(m.resolveThread.mock.calls[0][1]).toMatchObject({ subject: `Website chat ${r.ref}` })
    const lines = m.messageCreate.mock.calls[0][0].data.bodyText.split("\n")
    expect(lines.indexOf(`Chat ref: ${r.ref}`)).toBe(1)
    // The inbox links the lead only when a line STARTS with this label.
    expect(lines[2]).toBe("CRM lead: /crm/leads/lead_1")
  })
  it("writes the lead's activity note after the thread exists, linking to it", async () => {
    await startChat({ brand: "Acme Lending", tenantId: "t1", fields: FIELDS, now: NOW })
    expect(m.order).toEqual(["thread", "activity"])
    expect(m.activityCreate.mock.calls[0][0].data).toMatchObject({ leadId: "lead_1", type: "NOTE" })
    expect(m.activityCreate.mock.calls[0][0].data.notes).toContain("Inbox thread: /inbox?conversationId=conv_1")
  })
  it("names matching existing contacts in the note but does not link them", async () => {
    m.contactFindMany.mockResolvedValue([{ id: "c_old", firstName: "Thandi", lastName: "M", clientId: "cl_9" }])
    const r = await startChat({ brand: "Acme Lending", tenantId: "t1", fields: FIELDS, now: NOW })
    expect(r.matchedContactIds).toEqual(["c_old"])
    expect(m.messageCreate.mock.calls[0][0].data.bodyText).toContain("c_old")
    expect(m.contactCreate.mock.calls[0][0].data).not.toHaveProperty("clientId")
  })
  it("lists up to five earlier website-chat leads from the same number in the note", async () => {
    m.leadFindMany.mockResolvedValue([{ id: "lead_old2" }, { id: "lead_old1" }])
    await startChat({ brand: "Acme Lending", tenantId: "t1", fields: FIELDS, now: NOW })
    expect(m.leadFindMany.mock.calls[0][0]).toEqual({
      where: { tenantId: "t1", phone: "27821234567", source: "WEBSITE", tags: { has: "website-chat" } },
      orderBy: { createdAt: "desc" }, take: 5, select: { id: true },
    })
    expect(m.leadFindMany.mock.invocationCallOrder[0]).toBeLessThan(m.leadCreate.mock.invocationCallOrder[0])
    const body = m.messageCreate.mock.calls[0][0].data.bodyText
    expect(body).toContain("Earlier website chats from this number (not verified): /crm/leads/lead_old2, /crm/leads/lead_old1.")
  })
  it("adds no repeat-visitor line for a first-time number", async () => {
    await startChat({ brand: "Acme Lending", tenantId: "t1", fields: FIELDS, now: NOW })
    expect(m.messageCreate.mock.calls[0][0].data.bodyText).not.toContain("Earlier website chats")
  })
})

describe("recordVisitorMessage", () => {
  const base = { tenantId: "t1", conversationId: "conv_1", text: "hi", now: NOW }
  // count() is called twice: the tenant's messages today, then this chat's messages.
  const counts = (today: number, chat: number) => m.messageCount.mockResolvedValueOnce(today).mockResolvedValueOnce(chat)

  it("takes the tenant's daily lock, then the thread lock, then stores the message below both caps", async () => {
    counts(299, 19)
    expect(await recordVisitorMessage(base)).toEqual({ accepted: true })
    const [daySql, ...dayValues] = m.executeRaw.mock.calls[0]
    expect(daySql.join("?")).toContain("pg_advisory_xact_lock(hashtext(? || ':webchat-day'))")
    expect(dayValues).toEqual(["t1"])
    expect(m.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(m.queryRaw.mock.invocationCallOrder[0])
    const [rowSql, ...rowValues] = m.queryRaw.mock.calls[0]
    expect(rowSql.join("?")).toContain("FOR UPDATE")
    expect(rowValues).toEqual(["conv_1", "t1"])
    expect(m.messageCount.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", channel: "CHATBOT", direction: "INBOUND", createdAt: { gte: expect.any(Date) } })
    // The chat's cap counts only messages the assistant was asked (provider CHATBOT), not those kept for staff.
    expect(m.messageCount.mock.calls[1][0].where).toEqual({ tenantId: "t1", conversationId: "conv_1", channel: "CHATBOT", provider: "CHATBOT", direction: "INBOUND" })
    expect(m.messageCreate.mock.calls[0][0].data).toMatchObject({ direction: "INBOUND", bodyText: "hi" })
    expect(stamps()).toEqual([['"lastInboundAt"', NOW]])
  })
  it("at the tenant's daily cap refuses the message for the assistant and keeps it for staff (MANUAL)", async () => {
    counts(300, 5)
    expect(await recordVisitorMessage(base)).toEqual({ accepted: false, reason: "daily_cap", stored: true })
    expect(m.messageCreate.mock.calls[0][0].data).toMatchObject({ direction: "INBOUND", channel: "CHATBOT", provider: "MANUAL", bodyText: "hi" })
    expect(stamps()).toEqual([['"lastInboundAt"', NOW]])
  })
  it("at the daily cap on a chat already handed off (fallback) keeps the message for staff as MANUAL, without the model", async () => {
    m.queryRaw.mockResolvedValue([{ status: "PENDING_INTERNAL", assigneeId: null, closedAt: null }])
    m.handoffFindFirst.mockResolvedValue({ timedOutAt: NOW })
    // The tenant's messages today, then this chat's messages for the staff-mode cap.
    m.messageCount.mockResolvedValueOnce(300).mockResolvedValueOnce(5)
    expect(await recordVisitorMessage(base)).toEqual({ accepted: false, reason: "to_staff", stored: true })
    expect(m.messageCreate.mock.calls[0][0].data).toMatchObject({ direction: "INBOUND", provider: "MANUAL", bodyText: "hi" })
    expect(stamps()).toEqual([['"lastInboundAt"', NOW]])
  })
  it("below the daily cap a handed-off chat still reaches the model", async () => {
    m.queryRaw.mockResolvedValue([{ status: "PENDING_INTERNAL", assigneeId: null, closedAt: null }])
    counts(10, 5)
    expect(await recordVisitorMessage(base)).toEqual({ accepted: true })
  })
  it("at both the daily cap and the chat's cap reports the chat's cap, and keeps the message for staff", async () => {
    counts(300, 20)
    expect(await recordVisitorMessage(base)).toEqual({ accepted: false, reason: "conversation_cap", stored: true })
    expect(m.messageCreate.mock.calls[0][0].data).toMatchObject({ provider: "MANUAL", bodyText: "hi" })
  })
  it("refuses at the chat's cap for the assistant and keeps the message for staff", async () => {
    counts(0, 20)
    expect(await recordVisitorMessage(base)).toEqual({ accepted: false, reason: "conversation_cap", stored: true })
    expect(m.messageCreate.mock.calls[0][0].data).toMatchObject({ provider: "MANUAL", bodyText: "hi" })
    expect(stamps()).toEqual([['"lastInboundAt"', NOW]])
  })
  it("at a cap with the staff-mode cap reached too, keeps nothing and says so", async () => {
    counts(0, 20)
    m.messageCount.mockResolvedValueOnce(100)
    expect(await recordVisitorMessage(base)).toEqual({ accepted: false, reason: "conversation_cap", stored: false })
    expect(m.messageCreate).not.toHaveBeenCalled()
    expect(stamps()).toEqual([])
  })
})

describe("recordAssistantReply", () => {
  const base = { tenantId: "t1", conversationId: "conv_1", reply: "Hi", reason: null, now: NOW }
  it("stores the reply and stamps lastOutboundAt without touching status", async () => {
    expect(await recordAssistantReply({ ...base, needsHuman: false })).toEqual({ handedOffNow: false, suppressed: false, reply: "Hi" })
    expect(m.messageCreate.mock.calls[0][0].data).toMatchObject({ direction: "OUTBOUND", status: "DELIVERED", sentAt: NOW })
    expect(m.conversationUpdateMany).not.toHaveBeenCalled()
    expect(stamps()).toEqual([['"lastOutboundAt"', NOW]])
  })
  it("flips the status conditionally, writes the call-back note from the reason code and opens the wait in the same transaction", async () => {
    // NOW is Tuesday 12:00 SAST, inside the default hours.
    expect(await recordAssistantReply({ ...base, needsHuman: true, reason: "account_question" })).toEqual({ handedOffNow: true, suppressed: false, mode: "waiting", reply: "Hi\n\nI can't help with that here, so I'll connect you to a consultant." })
    const fresh = { handedOffAt: NOW, timedOutAt: null, alertEmailSentAt: null, alertAttempts: 0 }
    expect(m.handoffUpsert.mock.calls[0][0]).toEqual({
      where: { conversationId: "conv_1", tenantId: "t1" },
      create: { ...fresh, tenant: { connect: { id: "t1" } }, conversation: { connect: { id: "conv_1", tenantId: "t1" } } },
      update: fresh,
    })
    // Read-only: an anonymous visitor must never create a settings row.
    expect(m.settingsFindUnique.mock.calls[0][0]).toEqual({ where: { tenantId: "t1" }, select: { businessHours: true } })
    expect(m.conversationUpdateMany.mock.calls[0][0]).toEqual({
      where: { id: "conv_1", tenantId: "t1", status: { not: "PENDING_INTERNAL" }, closedAt: null },
      data: { status: "PENDING_INTERNAL", priority: "HIGH" },
    })
    expect(m.leadFindFirst.mock.calls[0][0].where).toEqual({ id: "lead_1", tenantId: "t1" })
    expect(m.messageCreate.mock.calls[1][0].data.bodyText).toBe("Needs human: a question about an existing account. Call the visitor on +27821234567.")
    expect(stamps()).toEqual([['"lastOutboundAt"', NOW]])
  })
  it("reads the chat's hand-off with the tenant, under the thread row lock", async () => {
    await recordAssistantReply({ ...base, needsHuman: false })
    expect(m.queryRaw.mock.calls[0][0].join("?")).toContain("FOR UPDATE")
    expect(m.handoffFindFirst.mock.calls[0][0]).toEqual({ where: { conversationId: "conv_1", tenantId: "t1" }, select: { timedOutAt: true } })
    expect(m.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(m.handoffFindFirst.mock.invocationCallOrder[0])
  })
  it.each([
    ["staff hold the chat", { status: "OPEN", assigneeId: "u1", closedAt: null }, null],
    ["the chat is waiting for staff", { status: "PENDING_INTERNAL", assigneeId: null, closedAt: null }, { timedOutAt: null }],
  ])("writes nothing when %s, hand-off or not", async (_name, thread, handoff) => {
    m.queryRaw.mockResolvedValue([thread])
    m.handoffFindFirst.mockResolvedValue(handoff)
    for (const needsHuman of [false, true]) expect(await recordAssistantReply({ ...base, needsHuman })).toEqual({ handedOffNow: false, suppressed: true })
    for (const write of [m.messageCreate, m.conversationUpdateMany, m.handoffUpsert]) expect(write).not.toHaveBeenCalled()
    expect(stamps()).toEqual([])
  })
  it("writes nothing for a thread this tenant does not have", async () => {
    m.queryRaw.mockResolvedValue([])
    expect(await recordAssistantReply({ ...base, needsHuman: true })).toEqual({ handedOffNow: false, suppressed: true })
    expect(m.messageCreate).not.toHaveBeenCalled()
  })
  it("a hand-off notice (handoffOnly) is written only by the call that opens the hand-off", async () => {
    m.conversationUpdateMany.mockResolvedValueOnce({ count: 0 })
    expect(await recordAssistantReply({ ...base, reply: "Passing this on.", needsHuman: true, reason: "daily_limit", handoffOnly: true })).toEqual({ handedOffNow: false, suppressed: true })
    expect(m.messageCreate).not.toHaveBeenCalled()
    expect(stamps()).toEqual([])
    expect(await recordAssistantReply({ ...base, reply: "Passing this on.", needsHuman: true, reason: "daily_limit", handoffOnly: true })).toMatchObject({ handedOffNow: true, suppressed: false })
    expect(m.messageCreate.mock.calls.map((c) => c[0].data.direction)).toEqual(["OUTBOUND", "INTERNAL_NOTE"])
  })
  it("two hand-offs on the same conversation produce one note", async () => {
    m.conversationUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    const first = await recordAssistantReply({ ...base, needsHuman: true, reason: "complaint" })
    const second = await recordAssistantReply({ ...base, needsHuman: true, reason: "complaint" })
    expect([first.handedOffNow, second.handedOffNow]).toEqual([true, false])
    const notes = m.messageCreate.mock.calls.filter((c) => c[0].data.direction === "INTERNAL_NOTE")
    expect(notes).toHaveLength(1)
    expect(m.handoffUpsert).toHaveBeenCalledTimes(1)
    expect(stamps()).toHaveLength(2)
  })
})

describe("recordVisitorMessageToStaff", () => {
  const base = { tenantId: "t1", conversationId: "conv_1", text: "hi", now: NOW }
  it("keeps up to 100 visitor messages in a chat staff hold, and refuses the 101st", async () => {
    m.queryRaw.mockResolvedValue([{ status: "OPEN", assigneeId: "u1", closedAt: null }])
    m.messageCount.mockResolvedValueOnce(99)
    expect(await recordVisitorMessageToStaff(base)).toEqual({ accepted: true })
    expect(m.messageCreate).toHaveBeenCalledTimes(1)
    m.messageCount.mockResolvedValueOnce(100)
    expect(await recordVisitorMessageToStaff(base)).toEqual({ accepted: false, reason: "staff_cap" })
    expect(m.messageCreate).toHaveBeenCalledTimes(1)
  })
  it.each([
    ["the assistant (handed back)", { status: "OPEN", assigneeId: null, closedAt: null }, null],
    ["the fallback (the wait timed out)", { status: "PENDING_INTERNAL", assigneeId: null, closedAt: null }, { timedOutAt: NOW }],
  ])("writes nothing for a chat now with %s, and says so", async (_name, thread, handoff) => {
    m.queryRaw.mockResolvedValue([thread])
    m.handoffFindFirst.mockResolvedValue(handoff)
    expect(await recordVisitorMessageToStaff(base)).toEqual({ accepted: false, reason: "not_staff" })
    expect(m.messageCreate).not.toHaveBeenCalled()
    expect(stamps()).toEqual([])
  })
})
