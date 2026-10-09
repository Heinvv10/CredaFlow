import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const {
  verifyCronSecretMock,
  getTenantFromRequestMock,
  notificationDeleteManyMock,
  throttleDeleteManyMock,
  auditLogCreateMock,
  coherentMock,
} = vi.hoisted(() => ({
  verifyCronSecretMock: vi.fn(),
  getTenantFromRequestMock: vi.fn(),
  notificationDeleteManyMock: vi.fn(),
  throttleDeleteManyMock: vi.fn(),
  auditLogCreateMock: vi.fn(),
  coherentMock: vi.fn(),
}))

vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: (r: unknown) => verifyCronSecretMock(r) }))
vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: (r: unknown) => getTenantFromRequestMock(r) }))
vi.mock("@/lib/audit", () => ({ AuditAction: { NOTIFICATION_DATA_PURGED: "NOTIFICATION_DATA_PURGED" } }))
// Keep the real cutoff arithmetic; override only the guard so the incoherent
// case is reachable. Without this the route's `if (!coherent) return 500` block
// can be deleted with the whole suite still green — the defect this file exists
// to prevent, and the one the pure module already closed.
vi.mock("@/lib/notifications/retention", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications/retention")>()),
  retentionPeriodsAreCoherent: () => coherentMock(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    notification: { deleteMany: (a: unknown) => notificationDeleteManyMock(a) },
    notificationThrottle: { deleteMany: (a: unknown) => throttleDeleteManyMock(a) },
    auditLog: { create: (a: unknown) => auditLogCreateMock(a) },
  },
}))

const { GET } = await import("./route")
const req = () => new NextRequest("http://localhost/api/cron/cleanup-notifications")

beforeEach(() => {
  vi.clearAllMocks()
  verifyCronSecretMock.mockReturnValue(null)
  getTenantFromRequestMock.mockResolvedValue({ id: "tenant-1" })
  notificationDeleteManyMock.mockResolvedValue({ count: 3 })
  throttleDeleteManyMock.mockResolvedValue({ count: 5 })
  auditLogCreateMock.mockResolvedValue({ id: "al-1" })
  coherentMock.mockReturnValue(true)
})

// THE guard: purging a claim whose task is still selectable re-sends the
// reminder. Refusing to run costs disk; running costs staff trust.
describe("refuses to purge when the retention periods are incoherent", () => {
  it("500s and deletes NOTHING", async () => {
    coherentMock.mockReturnValue(false)
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(notificationDeleteManyMock).not.toHaveBeenCalled()
    expect(throttleDeleteManyMock).not.toHaveBeenCalled()
  })

  it("refuses BEFORE resolving a tenant — it is a config error, not a data one", async () => {
    coherentMock.mockReturnValue(false)
    await GET(req())
    expect(getTenantFromRequestMock).not.toHaveBeenCalled()
  })

  it("actually consults the guard on the happy path", async () => {
    await GET(req())
    expect(coherentMock).toHaveBeenCalled()
  })
})

describe("auth", () => {
  it("refuses without the cron secret and deletes NOTHING", async () => {
    const { NextResponse } = await import("next/server")
    verifyCronSecretMock.mockReturnValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(notificationDeleteManyMock).not.toHaveBeenCalled()
    expect(throttleDeleteManyMock).not.toHaveBeenCalled()
  })
})

describe("tenant scoping", () => {
  it("scopes BOTH deletes to the resolved tenant", async () => {
    // NotificationThrottle is not a tenant-scoped model, so nothing injects
    // this filter — without it a nightly run reaps another tenant's claims and
    // re-opens their sends.
    await GET(req())
    expect(notificationDeleteManyMock.mock.calls[0][0].where.tenantId).toBe("tenant-1")
    expect(throttleDeleteManyMock.mock.calls[0][0].where.tenantId).toBe("tenant-1")
  })

  it("400s and deletes nothing when no tenant resolves", async () => {
    getTenantFromRequestMock.mockResolvedValue(null)
    const res = await GET(req())
    expect(res.status).toBe(400)
    expect(notificationDeleteManyMock).not.toHaveBeenCalled()
    expect(throttleDeleteManyMock).not.toHaveBeenCalled()
  })
})

describe("what it purges", () => {
  it("only deletes rows OLDER than the cutoff — never by a bare tenant match", async () => {
    // A deleteMany whose where lost its date predicate would wipe the table.
    await GET(req())
    const nWhere = notificationDeleteManyMock.mock.calls[0][0].where
    const tWhere = throttleDeleteManyMock.mock.calls[0][0].where
    expect(nWhere.createdAt.lt).toBeInstanceOf(Date)
    expect(tWhere.windowStart.lt).toBeInstanceOf(Date)
    expect(nWhere.createdAt.lt.getTime()).toBeLessThan(Date.now())
    expect(tWhere.windowStart.lt.getTime()).toBeLessThan(Date.now())
  })

  it("filters throttle claims on windowStart — the column the safety argument is about", async () => {
    // NOT createdAt. windowStart is what the reminder cron's selection is
    // expressed in, so this predicate and the coherence guard check the same
    // thing. createdAt is only accidentally safe (it happens to be >= windowStart
    // for today's producers) and would break the moment a claim is made for a
    // window in the future.
    await GET(req())
    const where = throttleDeleteManyMock.mock.calls[0][0].where
    expect(where.windowStart?.lt).toBeInstanceOf(Date)
    expect(where.createdAt).toBeUndefined()
  })

  it("keeps throttle claims longer than the reminder window can reach back", async () => {
    await GET(req())
    const throttleCutoff = throttleDeleteManyMock.mock.calls[0][0].where.windowStart.lt.getTime()
    const reminderReach = Date.now() - 7 * 86_400_000
    // Purging inside the reminder's reach would re-send. 30d vs 7d.
    expect(throttleCutoff).toBeLessThan(reminderReach)
  })

  it("purges bell items on a longer horizon than dedupe claims", async () => {
    await GET(req())
    const nCut = notificationDeleteManyMock.mock.calls[0][0].where.createdAt.lt.getTime()
    const tCut = throttleDeleteManyMock.mock.calls[0][0].where.windowStart.lt.getTime()
    expect(nCut).toBeLessThan(tCut) // 90d back is earlier than 30d back
  })

  it("reports what it purged and the periods it used", async () => {
    const res = await GET(req())
    expect(await res.json()).toMatchObject({
      ok: true,
      notificationsPurged: 3,
      throttlesPurged: 5,
      notificationRetentionDays: 90,
      throttleRetentionDays: 30,
    })
  })
})

// Erasing personal data is itself a processing operation (POPIA s.17), and
// "prove you deleted it" is what a DSAR or an auditor asks. A console line is
// not evidence — this is the first cron here that deletes ROWS, not files.
describe("erasure record", () => {
  it("writes an audit row naming what was erased, under which policy", async () => {
    await GET(req())
    const data = auditLogCreateMock.mock.calls[0][0].data
    expect(data).toMatchObject({ tenantId: "tenant-1", action: "NOTIFICATION_DATA_PURGED" })
    expect(data.newValue).toMatchObject({
      notificationsPurged: 3,
      throttlesPurged: 5,
      notificationRetentionDays: 90,
      throttleRetentionDays: 30,
    })
    // The cutoffs make the row self-describing: an auditor can see the line
    // that was drawn, not just the count.
    expect(typeof data.newValue.notificationCutoff).toBe("string")
    expect(typeof data.newValue.throttleCutoff).toBe("string")
  })

  it("records the cron as the actor, not a staff member", async () => {
    await GET(req())
    const data = auditLogCreateMock.mock.calls[0][0].data
    // The audit UI renders `userEmail ?? "system"`. Naming a person here would
    // assert that they performed the erasure.
    expect(data.userId).toBeNull()
    expect(data.userEmail).toBeNull()
  })

  it("writes nothing on a no-op run — a nightly empty row is noise, not evidence", async () => {
    notificationDeleteManyMock.mockResolvedValue({ count: 0 })
    throttleDeleteManyMock.mockResolvedValue({ count: 0 })
    await GET(req())
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })

  it("still reports success if the audit row fails — the rows are already gone", async () => {
    auditLogCreateMock.mockRejectedValue(new Error("db blip"))
    const res = await GET(req())
    expect(res.status).toBe(200)
  })
})
