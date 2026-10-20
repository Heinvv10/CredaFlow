// Covers the reminder cron. Every fix in this route — the paging that stops
// claimed tasks starving unclaimed ones, the atomic claim+bell transaction, the
// status re-read, and the channel dispatch — previously had NO test, so each
// could be reverted with the whole suite still green.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const {
  verifyCronSecretMock,
  getTenantFromRequestMock,
  agentTaskFindManyMock,
  throttleFindManyMock,
  throttleCreateMock,
  userFindManyMock,
  leadFindManyMock,
  txAgentTaskFindFirstMock,
  txNotificationCreateMock,
  isWaEnabledMock,
  sendStaffTaskReminderMock,
  getCommsSettingsMock,
} = vi.hoisted(() => ({
  verifyCronSecretMock: vi.fn(),
  getTenantFromRequestMock: vi.fn(),
  agentTaskFindManyMock: vi.fn(),
  throttleFindManyMock: vi.fn(),
  throttleCreateMock: vi.fn(),
  userFindManyMock: vi.fn(),
  leadFindManyMock: vi.fn(),
  txAgentTaskFindFirstMock: vi.fn(),
  txNotificationCreateMock: vi.fn(),
  isWaEnabledMock: vi.fn(),
  sendStaffTaskReminderMock: vi.fn(),
  getCommsSettingsMock: vi.fn(),
}))

// The tx client handed to the interactive transaction callback.
const txClient = {
  agentTask: { findFirst: (a: unknown) => txAgentTaskFindFirstMock(a) },
  notificationThrottle: { create: (a: unknown) => throttleCreateMock(a) },
  notification: { create: (a: unknown) => txNotificationCreateMock(a) },
}

vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: (r: unknown) => verifyCronSecretMock(r) }))
vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: (r: unknown) => getTenantFromRequestMock(r) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    agentTask: { findMany: (a: unknown) => agentTaskFindManyMock(a) },
    notificationThrottle: { findMany: (a: unknown) => throttleFindManyMock(a) },
    user: { findMany: (a: unknown) => userFindManyMock(a) },
    lead: { findMany: (a: unknown) => leadFindManyMock(a) },
    $transaction: async (cb: (tx: typeof txClient) => Promise<unknown>) => cb(txClient),
  },
}))
vi.mock("@/lib/whatsapp/env-switch", () => ({
  isWaEnvOff: () => !isWaEnabledMock(),
}))
vi.mock("@/lib/messaging/staff-task-reminder", () => ({
  sendStaffTaskReminder: (a: unknown) => sendStaffTaskReminderMock(a),
}))
vi.mock("@/lib/inbox/settings", () => ({ getCommsSettings: (t: unknown) => getCommsSettingsMock(t) }))

const { GET } = await import("./route")

const DUE = new Date("2026-07-17T09:00:00.000Z")
const req = () => new NextRequest("http://localhost/api/cron/lead-task-reminders")

function task(id: string, over: Partial<{ dueAt: Date; assigneeId: string; entityId: string }> = {}) {
  return { id, title: `Task ${id}`, dueAt: DUE, assigneeId: "u1", entityId: "lead-1", ...over }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("NEXTAUTH_URL", "https://app.lender.example")
  verifyCronSecretMock.mockReturnValue(null)
  getTenantFromRequestMock.mockResolvedValue({ id: "tenant-1" })
  getCommsSettingsMock.mockResolvedValue({ whatsappEnabled: true })
  isWaEnabledMock.mockReturnValue(true)
  agentTaskFindManyMock.mockResolvedValue([])
  throttleFindManyMock.mockResolvedValue([])
  throttleCreateMock.mockResolvedValue({ id: "th-1" })
  txAgentTaskFindFirstMock.mockResolvedValue({ id: "t1" })
  txNotificationCreateMock.mockResolvedValue({ id: "n1" })
  userFindManyMock.mockResolvedValue([{ id: "u1", name: "Sipho", email: "sipho@acme-lending.example", phone: null }])
  leadFindManyMock.mockResolvedValue([{ id: "lead-1", firstName: "Thabo", lastName: "Nkosi" }])
  sendStaffTaskReminderMock.mockResolvedValue({ outcome: "sent", recorded: true, messageId: "m-1" })
})

describe("auth", () => {
  it("refuses without a valid cron secret and does no work", async () => {
    const { NextResponse } = await import("next/server")
    verifyCronSecretMock.mockReturnValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(agentTaskFindManyMock).not.toHaveBeenCalled()
  })
})

describe("candidate query", () => {
  it("only takes open, assigned, lead tasks due inside the lookback window", async () => {
    await GET(req())
    const where = agentTaskFindManyMock.mock.calls[0][0].where
    expect(where.tenantId).toBe("tenant-1")
    expect(where.entityType).toBe("Lead")
    expect(where.status).toEqual({ in: ["PENDING", "IN_PROGRESS"] })
    expect(where.assigneeId).toEqual({ not: null })
    // Both bounds: lte now stops future tasks, gte floor stops ancient ones
    // firing en masse on the first run after wiring.
    expect(where.dueAt.lte).toBeInstanceOf(Date)
    expect(where.dueAt.gte).toBeInstanceOf(Date)
    const spanDays = (where.dueAt.lte.getTime() - where.dueAt.gte.getTime()) / 86_400_000
    expect(spanDays).toBe(7)
  })

  it("orders by a stable unique key so the cursor cannot skip or repeat rows", async () => {
    await GET(req())
    expect(agentTaskFindManyMock.mock.calls[0][0].orderBy).toEqual({ id: "asc" })
  })
})

describe("dedupe: claimed tasks must not consume the send budget", () => {
  it("skips a task already claimed for this due time", async () => {
    agentTaskFindManyMock.mockResolvedValueOnce([task("t1")])
    throttleFindManyMock.mockResolvedValue([
      { channelKey: "lead-task-reminder:t1", windowStart: DUE },
    ])
    const res = await GET(req())
    expect(await res.json()).toMatchObject({ reminded: 0 })
    expect(throttleCreateMock).not.toHaveBeenCalled()
    expect(txNotificationCreateMock).not.toHaveBeenCalled()
  })

  it("still reminds a RESCHEDULED task whose OLD due time is claimed", async () => {
    const newDue = new Date("2026-07-17T11:00:00.000Z")
    agentTaskFindManyMock.mockResolvedValueOnce([task("t1", { dueAt: newDue })])
    throttleFindManyMock.mockResolvedValue([
      { channelKey: "lead-task-reminder:t1", windowStart: DUE }, // old window
    ])
    const res = await GET(req())
    expect(await res.json()).toMatchObject({ reminded: 1 })
    expect(throttleCreateMock.mock.calls[0][0].data.windowStart).toEqual(newDue)
  })

  it("pages past a full batch of claimed tasks instead of letting them fill the budget", async () => {
    // The starvation bug: a page-sized `take` of already-reminded rows used to
    // consume the whole run, so anything behind them was never reminded.
    const claimed = Array.from({ length: 200 }, (_, i) => task(`c${i}`))
    agentTaskFindManyMock
      .mockResolvedValueOnce(claimed) // page 1 — all claimed
      .mockResolvedValueOnce([task("fresh")]) // page 2 — the one that matters
      .mockResolvedValue([])
    throttleFindManyMock.mockImplementation(async (a: { where: { channelKey: { in: string[] } } }) =>
      a.where.channelKey.in
        .filter((k) => k !== "lead-task-reminder:fresh")
        .map((channelKey) => ({ channelKey, windowStart: DUE }))
    )
    const res = await GET(req())
    expect(await res.json()).toMatchObject({ reminded: 1, scanned: 201 })
    expect(txNotificationCreateMock).toHaveBeenCalledTimes(1)
  })

  it("uses a cursor on the last row of the previous page", async () => {
    agentTaskFindManyMock
      .mockResolvedValueOnce(Array.from({ length: 200 }, (_, i) => task(`c${i}`)))
      .mockResolvedValue([])
    throttleFindManyMock.mockImplementation(async (a: { where: { channelKey: { in: string[] } } }) =>
      a.where.channelKey.in.map((channelKey) => ({ channelKey, windowStart: DUE }))
    )
    await GET(req())
    const secondCall = agentTaskFindManyMock.mock.calls[1][0]
    expect(secondCall.cursor).toEqual({ id: "c199" })
    expect(secondCall.skip).toBe(1)
  })
})

describe("claim + bell are atomic", () => {
  it("writes the throttle claim and the bell on the SAME transaction client", async () => {
    agentTaskFindManyMock.mockResolvedValueOnce([task("t1")])
    await GET(req())
    // Both go through txClient — if the bell used the root client, a crash
    // between them would commit the claim alone and silence the task forever.
    expect(throttleCreateMock).toHaveBeenCalledTimes(1)
    expect(txNotificationCreateMock).toHaveBeenCalledTimes(1)
    expect(txNotificationCreateMock.mock.calls[0][0].data).toMatchObject({
      tenantId: "tenant-1",
      userId: "u1",
      type: "TASK_DUE",
      entityType: "Lead",
      entityId: "lead-1",
    })
  })

  it("claims with windowStart = the task's dueAt", async () => {
    agentTaskFindManyMock.mockResolvedValueOnce([task("t1")])
    await GET(req())
    expect(throttleCreateMock.mock.calls[0][0].data).toEqual({
      tenantId: "tenant-1",
      channelKey: "lead-task-reminder:t1",
      windowStart: DUE,
    })
  })

  it("skips silently when a concurrent run wins the claim (P2002)", async () => {
    const { Prisma } = await import("@prisma/client")
    agentTaskFindManyMock.mockResolvedValueOnce([task("t1")])
    throttleCreateMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "5" })
    )
    const res = await GET(req())
    expect(await res.json()).toMatchObject({ reminded: 0 })
    expect(sendStaffTaskReminderMock).not.toHaveBeenCalled()
  })

  it("does not push when the transaction fails — no bell means no reminder", async () => {
    agentTaskFindManyMock.mockResolvedValueOnce([task("t1")])
    txNotificationCreateMock.mockRejectedValue(new Error("db down"))
    const res = await GET(req())
    // The catch-all branch (not TaskNoLongerDue, not a P2002 race) now counts
    // toward claimFailed and fails the run — a write path that keeps failing
    // must surface, not just log and move on.
    expect(await res.json()).toMatchObject({ reminded: 0, pushed: 0, claimFailed: 1, ok: false })
    expect(res.status).toBe(503)
    expect(sendStaffTaskReminderMock).not.toHaveBeenCalled()
  })

  it("re-reads the task inside the tx and skips one that closed mid-run", async () => {
    agentTaskFindManyMock.mockResolvedValueOnce([task("t1")])
    txAgentTaskFindFirstMock.mockResolvedValue(null) // completed since we read it
    const res = await GET(req())
    expect(await res.json()).toMatchObject({ reminded: 0 })
    expect(throttleCreateMock).not.toHaveBeenCalled()
    expect(sendStaffTaskReminderMock).not.toHaveBeenCalled()
    // and the re-read is constrained to still-open + same dueAt
    expect(txAgentTaskFindFirstMock.mock.calls[0][0].where).toMatchObject({
      id: "t1",
      tenantId: "tenant-1",
      status: { in: ["PENDING", "IN_PROGRESS"] },
      dueAt: DUE,
    })
  })
})

describe("channel dispatch", () => {
  it("emails a staff member with no phone — 0 of 5 active staff have one", async () => {
    agentTaskFindManyMock.mockResolvedValueOnce([task("t1")])
    const res = await GET(req())
    expect(sendStaffTaskReminderMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: "EMAIL",
      toValue: "sipho@acme-lending.example",
      taskId: "t1",
      leadId: "lead-1",
    }))
    expect(await res.json()).toMatchObject({ pushed: 1 })
  })

  it("WhatsApps a staff member who has a phone", async () => {
    userFindManyMock.mockResolvedValue([{ id: "u1", name: "S", email: "s@n.co.za", phone: "0821234567" }])
    agentTaskFindManyMock.mockResolvedValueOnce([task("t1")])
    await GET(req())
    expect(sendStaffTaskReminderMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: "WHATSAPP",
      toValue: "0821234567",
    }))
  })

  it("records a WhatsApp dry-run as simulated, never as pushed or sent", async () => {
    userFindManyMock.mockResolvedValue([{ id: "u1", name: "S", email: "s@n.co.za", phone: "0821234567" }])
    sendStaffTaskReminderMock.mockResolvedValue({ outcome: "simulated", recorded: true, messageId: "message-1" })
    agentTaskFindManyMock.mockResolvedValueOnce([task("t1")])

    const res = await GET(req())

    expect(await res.json()).toMatchObject({ pushed: 0, simulated: 1 })
    expect(sendStaffTaskReminderMock).toHaveBeenCalledWith(expect.objectContaining({ channel: "WHATSAPP" }))
  })

  it("falls back to email when the WA env flag is off, rather than dropping the push", async () => {
    // sendWhatsAppMessage refuses on WA_ENABLED with ok:false, so consulting
    // only the DB flag would pick WhatsApp, take the refusal, and push nothing.
    isWaEnabledMock.mockReturnValue(false)
    userFindManyMock.mockResolvedValue([{ id: "u1", name: "S", email: "s@n.co.za", phone: "0821234567" }])
    agentTaskFindManyMock.mockResolvedValueOnce([task("t1")])
    await GET(req())
    expect(sendStaffTaskReminderMock).toHaveBeenCalledWith(expect.objectContaining({ channel: "EMAIL" }))
  })

  it("falls back to email when WhatsApp is disabled tenant-wide", async () => {
    getCommsSettingsMock.mockResolvedValue({ whatsappEnabled: false })
    userFindManyMock.mockResolvedValue([{ id: "u1", name: "S", email: "s@n.co.za", phone: "0821234567" }])
    agentTaskFindManyMock.mockResolvedValueOnce([task("t1")])
    await GET(req())
    expect(sendStaffTaskReminderMock).toHaveBeenCalledWith(expect.objectContaining({ channel: "EMAIL" }))
  })

  it("still writes the bell when there is no channel at all", async () => {
    userFindManyMock.mockResolvedValue([{ id: "u1", name: "S", email: "", phone: null }])
    agentTaskFindManyMock.mockResolvedValueOnce([task("t1")])
    const res = await GET(req())
    expect(await res.json()).toMatchObject({ reminded: 1, pushed: 0 })
    expect(txNotificationCreateMock).toHaveBeenCalledTimes(1)
  })
})

describe("tenant + recipient scoping", () => {
  it("filters assignees to active staff of this tenant", async () => {
    agentTaskFindManyMock.mockResolvedValueOnce([task("t1")])
    await GET(req())
    expect(userFindManyMock.mock.calls[0][0].where).toMatchObject({ tenantId: "tenant-1", active: true })
  })

  it("skips a task whose assignee is not active staff here — no bell, no push", async () => {
    userFindManyMock.mockResolvedValue([])
    agentTaskFindManyMock.mockResolvedValueOnce([task("t1")])
    const res = await GET(req())
    expect(await res.json()).toMatchObject({ reminded: 0 })
    expect(throttleCreateMock).not.toHaveBeenCalled()
  })

  it("filters leads by tenant and skips a task pointing outside it", async () => {
    agentTaskFindManyMock.mockResolvedValueOnce([task("t1")])
    leadFindManyMock.mockResolvedValue([]) // lead not in this tenant / deleted
    const res = await GET(req())
    expect(leadFindManyMock.mock.calls[0][0].where).toMatchObject({ tenantId: "tenant-1" })
    expect(await res.json()).toMatchObject({ reminded: 0 })
    expect(throttleCreateMock).not.toHaveBeenCalled()
  })
})

describe("accountability record", () => {
  it("passes exact task/recipient context to the authoritative Message helper", async () => {
    agentTaskFindManyMock.mockResolvedValueOnce([task("t1")])
    await GET(req())
    expect(sendStaffTaskReminderMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1",
      taskId: "t1",
      leadId: "lead-1",
      dueAt: DUE,
      recipientUserId: "u1",
      recipientEmail: "sipho@acme-lending.example",
      channel: "EMAIL",
    }))
  })

  it("records a failed push too, and fails the run", async () => {
    sendStaffTaskReminderMock.mockResolvedValue({ outcome: "failed", recorded: true, messageId: "m-1", error: "smtp down" })
    agentTaskFindManyMock.mockResolvedValueOnce([task("t1")])
    const res = await GET(req())
    const json = await res.json()
    expect(json).toMatchObject({ pushed: 0, failed: 1, ok: false })
    // The systemd wrapper runs `curl -fsS`, which only fails the unit on
    // HTTP >= 400 — a 200 here would keep a failing push channel invisible.
    expect(res.status).toBe(503)
  })

  it("does not claim an ambiguous provider outcome as sent, and fails the run", async () => {
    sendStaffTaskReminderMock.mockResolvedValue({
      outcome: "reconciliation_required",
      recorded: true,
      messageId: "m-ambiguous",
    })
    agentTaskFindManyMock.mockResolvedValueOnce([task("t1")])
    const res = await GET(req())
    const json = await res.json()
    expect(json).toMatchObject({ pushed: 0, reconciliationRequired: 1, ok: false })
    expect(res.status).toBe(503)
  })

  it("counts a delivered-but-unrecorded push separately from a clean one, and fails the run", async () => {
    sendStaffTaskReminderMock.mockResolvedValue({ outcome: "sent", recorded: false, messageId: "m-1" })
    agentTaskFindManyMock.mockResolvedValueOnce([task("t1")])
    const res = await GET(req())
    // Delivered, but the accountability row was lost — must not look clean.
    const json = await res.json()
    expect(json).toMatchObject({ pushed: 0, unrecorded: 1, ok: false })
    expect(res.status).toBe(503)
  })

  it("reports ok:true and 200 when every push lands cleanly", async () => {
    sendStaffTaskReminderMock.mockResolvedValue({ outcome: "sent", recorded: true, messageId: "m-1" })
    agentTaskFindManyMock.mockResolvedValueOnce([task("t1")])
    const res = await GET(req())
    const json = await res.json()
    expect(json).toMatchObject({ pushed: 1, ok: true })
    expect(res.status).toBe(200)
  })
})

describe("response shape", () => {
  it("reports the same fields on the quiet path as on the working path", async () => {
    const res = await GET(req())
    expect(await res.json()).toEqual({
      ok: true,
      reminded: 0, pushed: 0, simulated: 0, pending: 0,
      reconciliationRequired: 0, failed: 0, unrecorded: 0, claimFailed: 0,
      queued: 0, scanned: 0, truncated: false,
    })
    expect(res.status).toBe(200)
  })
})
