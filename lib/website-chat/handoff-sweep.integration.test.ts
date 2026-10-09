/**
 * Real-Postgres proof of the minute sweep: which hand-offs it times out, which
 * it emails, and that a failed or contested email is handled without a double
 * send. The email itself is mocked (see alert.test.ts). Its limits (no address,
 * age, hourly cap, batch) are in handoff-sweep-limits.integration.test.ts and the
 * abandoned-takeover release in staff-auto-release.integration.test.ts.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/website-chat/handoff-sweep.integration.test.ts
 */
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"
import { randomUUID } from "node:crypto"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "@prisma/client"
import { runWithTenant } from "@/lib/tenant-scope"

const m = vi.hoisted(() => ({ alert: vi.fn() }))
vi.mock("./alert", async (orig) => ({ ...(await orig<object>()), sendChatAlertEmail: m.alert }))

import { setConversationStatus } from "@/lib/inbox/thread-actions"
import { notifyStaffOfHandoff } from "./handoff"
import { joinChat, leaveChat } from "./staff"
import { sweepHandoffs } from "./handoff-sweep"
import { HANDOFF_WAIT_MS } from "./mode"
import { loadChat, recordAssistantReply, startChat } from "./store"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

suite("sweepHandoffs", () => {
  const db = new PrismaClient()
  const tenants: string[] = []
  // Tuesday 12:00 SAST: inside the default hours. 22:00 SAST: outside them.
  const open = new Date("2026-09-29T10:00:00Z")
  const afterHours = new Date("2026-09-29T20:00:00Z")
  const plus = (d: Date, ms: number) => new Date(d.getTime() + ms)
  const due = plus(open, HANDOFF_WAIT_MS)
  const MIN = 60_000
  const TO = "team@test.invalid"

  /** The sweep reads every hand-off of a tenant, so each test gets a tenant of its own. */
  async function tenant(chatAlertEmail: string | null = TO) {
    const id = `tenant_web_sweep${tenants.length}_${token}`
    await db.tenant.create({ data: { id, slug: id.replaceAll("_", "-"), name: "Website chat sweep IT", domain: null, config: { create: VALID_LENDER_COLUMNS } } })
    await db.commsSettings.create({ data: { tenantId: id, chatAlertEmail } })
    tenants.push(id)
    return id
  }
  const handOff = (tenantId: string, conversationId: string, at: Date) =>
    recordAssistantReply({ tenantId, conversationId, reply: "I'll ask a consultant.", needsHuman: true, reason: "out_of_scope", now: at })
  /** Handed off by the bot in hours at `open` (waiting), or after hours (born timed out). */
  async function handedOff(tenantId: string, at = open) {
    const r = await startChat({ brand: "Acme Lending", tenantId, fields: { firstName: "Sipho", lastName: "Dlamini", phone: "27825550002", email: `${randomUUID()}@test.invalid` }, now: at })
    await handOff(tenantId, r.conversationId, at)
    return r.conversationId
  }
  /** Sets the assignee only, writing no line, so it shows what the assignee check alone does. */
  async function join(tenantId: string, conversationId: string) {
    const user = await db.user.create({ data: { tenantId, id: `user_${randomUUID()}`, email: `${randomUUID()}@test.invalid`, password: "x" } })
    await db.conversation.update({ where: { id: conversationId }, data: { assigneeId: user.id } })
  }
  const admin = (tenantId: string) => db.user.create({ data: { tenantId, id: `user_${randomUUID()}`, email: `${randomUUID()}@test.invalid`, password: "x", role: "ADMIN" } })
  /** The real join and leave: the chat ends unassigned and open, back with the assistant. */
  async function joinThenLeave(tenantId: string, conversationId: string, now: Date, staffUserId?: string) {
    const id = staffUserId ?? (await admin(tenantId)).id
    expect(await joinChat({ tenantId, conversationId, staffUserId: id, now })).toEqual({ ok: true })
    expect(await leaveChat({ tenantId, conversationId, staffUserId: id, now })).toEqual({ ok: true })
  }
  const sweep = (tenantId: string, now: Date) => runWithTenant(tenantId, () => sweepHandoffs(tenantId, now))
  const row = (conversationId: string) => db.websiteChatHandoff.findUnique({ where: { conversationId } })
  /** Prisma stamps updatedAt with the wall clock; this puts a row's last claim on the fixture clock. */
  const claimedAt = (conversationId: string, at: Date) => db.$executeRaw`UPDATE "WebsiteChatHandoff" SET "updatedAt" = ${at} WHERE "conversationId" = ${conversationId}`

  beforeEach(() => {
    vi.clearAllMocks()
    m.alert.mockResolvedValue("sent")
  })

  afterAll(async () => {
    const where = { tenantId: { in: tenants } }
    await db.auditLog.deleteMany({ where })
    await db.notification.deleteMany({ where })
    await db.message.deleteMany({ where })
    await db.conversation.deleteMany({ where }) // cascades WebsiteChatHandoff
    await db.contactConsent.deleteMany({ where })
    await db.contact.deleteMany({ where })
    await db.crmActivity.deleteMany({ where })
    await db.lead.deleteMany({ where })
    await db.user.deleteMany({ where })
    await db.commsSettings.deleteMany({ where })
    await db.tenantConfig.deleteMany({ where: { tenantId: { in: tenants } } })
    await db.tenant.deleteMany({ where: { id: { in: tenants } } })
    await db.$disconnect()
  })

  it("times out a due hand-off whose visitor never polled, emails once, and a second run does nothing", async () => {
    const t = await tenant()
    const id = await handedOff(t)
    const early = await handedOff(t, plus(open, 1000))

    expect(await sweep(t, due)).toEqual({ expired: 1, emailed: 1, failed: 0, released: 0 })
    expect(await row(id)).toMatchObject({ timedOutAt: due, alertEmailSentAt: due, alertAttempts: 1 })
    expect(m.alert.mock.calls).toEqual([[{ tenantId: t, conversationId: id, to: TO, now: due }]])
    // One second short of the wait: neither timed out nor emailed.
    expect(await row(early)).toMatchObject({ timedOutAt: null, alertEmailSentAt: null, alertAttempts: 0 })

    expect(await sweep(t, due)).toEqual({ expired: 0, emailed: 0, failed: 0, released: 0 })
    expect(m.alert).toHaveBeenCalledTimes(1)
  })

  it("emails a hand-off that was born timed out after hours, without counting it as expired", async () => {
    const t = await tenant()
    const id = await handedOff(t, afterHours)
    const now = plus(afterHours, MIN)
    expect(await sweep(t, now)).toEqual({ expired: 0, emailed: 1, failed: 0, released: 0 })
    expect(await row(id)).toMatchObject({ timedOutAt: afterHours, alertEmailSentAt: now, alertAttempts: 1 })
  })

  it("a failed email is retried once its claim is 5 minutes old, and given up after 12 attempts (about an hour)", async () => {
    const t = await tenant()
    const id = await handedOff(t, afterHours)
    m.alert.mockResolvedValue("failed")
    let now = plus(afterHours, MIN)
    for (let attempt = 1; attempt <= 12; attempt++) {
      expect(await sweep(t, now)).toEqual({ expired: 0, emailed: 0, failed: 1, released: 0 })
      expect(await row(id)).toMatchObject({ alertEmailSentAt: null, alertAttempts: attempt })
      await claimedAt(id, now)
      now = plus(now, 6 * MIN)
    }
    expect(await sweep(t, now)).toEqual({ expired: 0, emailed: 0, failed: 0, released: 0 })
    expect(m.alert).toHaveBeenCalledTimes(12)
    expect(await row(id)).toMatchObject({ alertEmailSentAt: null, alertAttempts: 12 })
  })

  it("a row claimed 4 minutes ago, or exactly 5, is left alone (its send may still be running); 6 minutes ago it is retried", async () => {
    const t = await tenant()
    const id = await handedOff(t, afterHours)
    const now = plus(afterHours, 10 * MIN)
    await db.websiteChatHandoff.update({ where: { conversationId: id }, data: { alertAttempts: 1 } })

    for (const ago of [4 * MIN, 5 * MIN]) {
      await claimedAt(id, plus(now, -ago))
      expect(await sweep(t, now)).toEqual({ expired: 0, emailed: 0, failed: 0, released: 0 })
    }
    expect(m.alert).not.toHaveBeenCalled()
    expect(await row(id)).toMatchObject({ alertEmailSentAt: null, alertAttempts: 1 })

    await claimedAt(id, plus(now, -6 * MIN))
    expect(await sweep(t, now)).toEqual({ expired: 0, emailed: 1, failed: 0, released: 0 })
    expect(await row(id)).toMatchObject({ alertEmailSentAt: now, alertAttempts: 2 })
  })

  it("the lease is checked again at the claim: a row another run claimed since the read is not emailed", async () => {
    const t = await tenant()
    const now = plus(afterHours, 10 * MIN)
    const first = await handedOff(t, afterHours)
    const second = await handedOff(t, plus(afterHours, 1000))
    await db.websiteChatHandoff.update({ where: { conversationId: second }, data: { alertAttempts: 1 } })
    await claimedAt(second, plus(now, -6 * MIN))
    // Only the lease moves here, not the counter, so nothing but the claim's own lease check can refuse it.
    m.alert.mockImplementationOnce(async () => { await claimedAt(second, now); return "sent" })
    expect(await sweep(t, now)).toEqual({ expired: 0, emailed: 1, failed: 0, released: 0 })
    expect(m.alert.mock.calls.map(([a]) => a.conversationId)).toEqual([first])
    expect(await row(second)).toMatchObject({ alertEmailSentAt: null, alertAttempts: 1 })
  })

  it("a chat staff joined, or one that is closed, is neither timed out nor emailed", async () => {
    const t = await tenant()
    const joinedWaiting = await handedOff(t)
    const joinedLate = await handedOff(t, afterHours)
    const closed = await handedOff(t, afterHours)
    await join(t, joinedWaiting)
    await join(t, joinedLate)
    await db.conversation.update({ where: { id: closed }, data: { status: "CLOSED", closedAt: afterHours } })

    expect(await sweep(t, plus(afterHours, MIN))).toEqual({ expired: 0, emailed: 0, failed: 0, released: 0 })
    expect(m.alert).not.toHaveBeenCalled()
    expect(await row(joinedWaiting)).toMatchObject({ timedOutAt: null, alertAttempts: 0 })
    for (const id of [joinedLate, closed]) expect(await row(id)).toMatchObject({ alertEmailSentAt: null, alertAttempts: 0 })
  })

  it("a chat staff joined, joined and left, or closed after the sweep read it is not claimed and not emailed", async () => {
    const t = await tenant()
    const [first, joined, left, closed] = [await handedOff(t, afterHours), await handedOff(t, plus(afterHours, 1000)), await handedOff(t, plus(afterHours, 2000)), await handedOff(t, plus(afterHours, 3000))]
    // All four are read as unsent; the other three change while the first email is being sent.
    m.alert.mockImplementationOnce(async () => {
      await join(t, joined)
      await joinThenLeave(t, left, plus(afterHours, 30_000))
      await db.conversation.update({ where: { id: closed }, data: { status: "CLOSED", closedAt: afterHours } })
      return "sent"
    })
    expect(await sweep(t, plus(afterHours, MIN))).toEqual({ expired: 0, emailed: 1, failed: 0, released: 0 })
    expect(m.alert.mock.calls.map(([a]) => a.conversationId)).toEqual([first])
    for (const id of [joined, closed]) expect(await row(id)).toMatchObject({ alertEmailSentAt: null, alertAttempts: 0 })
    // The real join answered the hand-off: nothing is left of it.
    expect(await row(left)).toBeNull()
  })

  it("join, leave, then a second hand-off on the same chat: a new wait, a new bell, and an email when nobody joins that one", async () => {
    const t = await tenant()
    const staff = (await admin(t)).id
    const id = await handedOff(t)
    await notifyStaffOfHandoff({ tenantId: t, conversationId: id, now: open })
    await joinThenLeave(t, id, plus(open, 30_000), staff)
    expect(await db.conversation.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "OPEN", assigneeId: null })
    expect(await row(id)).toBeNull()
    // Back with the assistant, and nothing owed: the sweep has nothing to time out or email.
    expect((await loadChat(t, id))?.mode).toBe("bot")
    expect(await sweep(t, plus(open, 10 * MIN))).toEqual({ expired: 0, emailed: 0, failed: 0, released: 0 })

    // The visitor asks for a person again.
    const again = plus(open, 20 * MIN)
    expect(await handOff(t, id, again)).toEqual({ handedOffNow: true, suppressed: false, mode: "waiting", reply: "I'll ask a consultant.\n\nI can't help with that here, so I'll connect you to a consultant." })
    await notifyStaffOfHandoff({ tenantId: t, conversationId: id, now: again })
    expect((await db.conversation.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING_INTERNAL")
    expect(await row(id)).toMatchObject({ handedOffAt: again, timedOutAt: null, alertEmailSentAt: null, alertAttempts: 0 })
    const bells = await db.notification.findMany({ where: { tenantId: t, userId: staff, type: "CHAT_HANDOFF", entityId: id }, orderBy: { createdAt: "asc" } })
    expect(bells.map((n) => n.readAt)).toEqual([plus(open, 30_000), null])

    const timedOut = plus(again, HANDOFF_WAIT_MS)
    expect(await sweep(t, timedOut)).toEqual({ expired: 1, emailed: 1, failed: 0, released: 0 })
    expect(m.alert.mock.calls).toEqual([[{ tenantId: t, conversationId: id, to: TO, now: timedOut }]])
    expect(await row(id)).toMatchObject({ timedOutAt: timedOut, alertEmailSentAt: timedOut })
  })

  it("leaves other tenants' hand-offs alone", async () => {
    const mine = await tenant()
    const other = await tenant()
    const theirsDue = await handedOff(other)
    const theirsTimedOut = await handedOff(other, afterHours)

    // Outside a tenant frame, so nothing but the sweep's own filters keeps it to its tenant.
    expect(await sweepHandoffs(mine, plus(afterHours, MIN))).toEqual({ expired: 0, emailed: 0, failed: 0, released: 0 })
    expect(m.alert).not.toHaveBeenCalled()
    expect(await row(theirsDue)).toMatchObject({ timedOutAt: null, alertAttempts: 0 })
    expect(await row(theirsTimedOut)).toMatchObject({ alertEmailSentAt: null, alertAttempts: 0 })
  })

  it("a chat staff set to PENDING_INTERNAL by hand gets no hand-off row and no alert: the visitor never asked for a person", async () => {
    const t = await tenant()
    const actor = await admin(t)
    const id = (await startChat({ brand: "Acme Lending", tenantId: t, fields: { firstName: "Sipho", lastName: "Dlamini", phone: "27825550002", email: `${randomUUID()}@test.invalid` }, now: open })).conversationId
    await runWithTenant(t, () => setConversationStatus({ tenantId: t, conversationId: id, status: "PENDING_INTERNAL", actorUserId: actor.id }))

    for (const now of [open, plus(open, 3 * MIN), plus(open, 3 * 60 * MIN)]) expect(await sweep(t, now)).toEqual({ expired: 0, emailed: 0, failed: 0, released: 0 })
    expect(await row(id)).toBeNull()
    expect(m.alert).not.toHaveBeenCalled()
    expect((await loadChat(t, id))?.mode).toBe("fallback")
  })

  it("a hand-off another sweeper claimed after this one read it is not emailed twice", async () => {
    const t = await tenant()
    const first = await handedOff(t, afterHours)
    const second = await handedOff(t, plus(afterHours, 1000))
    // While this run sends the first email, another sweeper claims the second. Only the counter
    // moves here, not the lease, so nothing but the claim's counter check can refuse it.
    m.alert.mockImplementationOnce(async () => {
      await db.$executeRaw`UPDATE "WebsiteChatHandoff" SET "alertAttempts" = 1, "updatedAt" = ${plus(afterHours, -10 * MIN)} WHERE "conversationId" = ${second}`
      return "sent"
    })
    expect(await sweep(t, plus(afterHours, MIN))).toEqual({ expired: 0, emailed: 1, failed: 0, released: 0 })
    expect(m.alert.mock.calls.map(([a]) => a.conversationId)).toEqual([first])
    expect(await row(second)).toMatchObject({ alertEmailSentAt: null, alertAttempts: 1 })
  })

  it("a chat handed off again while its email was in flight keeps its fresh, unsent row", async () => {
    const t = await tenant()
    const id = await handedOff(t, afterHours)
    const again = plus(afterHours, 30_000)
    for (const outcome of ["sent", "failed"] as const) {
      // What the flip writes when staff reopen the chat and the bot hands it off again.
      m.alert.mockImplementationOnce(async () => {
        await db.websiteChatHandoff.update({ where: { conversationId: id }, data: { handedOffAt: again, timedOutAt: again, alertEmailSentAt: null, alertAttempts: 0 } })
        return outcome
      })
      await sweep(t, plus(afterHours, MIN))
      expect(await row(id)).toMatchObject({ handedOffAt: again, alertEmailSentAt: null, alertAttempts: 0 })
    }
  })
})
