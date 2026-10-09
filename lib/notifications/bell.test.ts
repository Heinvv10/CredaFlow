import { describe, it, expect, vi, beforeEach } from "vitest"

const { updateMany, count, findMany, create } = vi.hoisted(() => ({
  updateMany: vi.fn().mockResolvedValue({ count: 3 }),
  count: vi.fn().mockResolvedValue(0),
  findMany: vi.fn().mockResolvedValue([]),
  create: vi.fn().mockResolvedValue({ id: "n1" }),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: { notification: { updateMany, count, findMany, create } },
}))

const { markNotificationsRead, createNotification, listNotifications } = await import("./bell")

beforeEach(() => {
  vi.clearAllMocks()
  updateMany.mockResolvedValue({ count: 3 })
})

describe("markNotificationsRead — scoping", () => {
  it("always constrains by userId as well as tenantId", async () => {
    // The id list arrives from the client. Without the userId predicate one
    // staff member could mark another's items read.
    await markNotificationsRead({ tenantId: "t1", userId: "u1", ids: ["a", "b"] })
    expect(updateMany).toHaveBeenCalledTimes(1)
    const where = updateMany.mock.calls[0][0].where
    expect(where.tenantId).toBe("t1")
    expect(where.userId).toBe("u1")
    expect(where.readAt).toBeNull()
    expect(where.id).toEqual({ in: ["a", "b"] })
  })

  it("marks ALL of the caller's unread items when ids is omitted", async () => {
    await markNotificationsRead({ tenantId: "t1", userId: "u1" })
    const where = updateMany.mock.calls[0][0].where
    expect(where.id).toBeUndefined()
    expect(where.userId).toBe("u1")
  })

  it("an explicit empty list marks NOTHING and never queries", async () => {
    // The guard that matters: `...(ids && ids.length ? {id:{in:ids}} : {})`
    // contributes no predicate for [], so a caller passing a filtered-to-empty
    // list would silently escalate to marking EVERY item read.
    const n = await markNotificationsRead({ tenantId: "t1", userId: "u1", ids: [] })
    expect(n).toBe(0)
    expect(updateMany).not.toHaveBeenCalled()
  })

  it("returns the number actually written, so a no-op is distinguishable", async () => {
    updateMany.mockResolvedValue({ count: 0 })
    expect(await markNotificationsRead({ tenantId: "t1", userId: "u1" })).toBe(0)
    updateMany.mockResolvedValue({ count: 2 })
    expect(await markNotificationsRead({ tenantId: "t1", userId: "u1" })).toBe(2)
  })

  it("stamps readAt with the supplied clock", async () => {
    const now = new Date("2026-07-17T10:00:00.000Z")
    await markNotificationsRead({ tenantId: "t1", userId: "u1", now })
    expect(updateMany.mock.calls[0][0].data).toEqual({ readAt: now })
  })
})

describe("listNotifications", () => {
  it("scopes to the caller and bounds the page size", async () => {
    await listNotifications({ tenantId: "t1", userId: "u1", limit: 999 })
    const args = findMany.mock.calls[0][0]
    expect(args.where).toMatchObject({ tenantId: "t1", userId: "u1" })
    // A client-supplied limit must not be able to pull the whole table.
    expect(args.take).toBe(50)
  })
})

describe("createNotification", () => {
  it("always writes an explicit tenantId — the cron has no ALS frame", async () => {
    // Notification is in TENANT_SCOPED_MODELS, so without a frame the rewriter
    // throws missing-context unless data.tenantId is explicit.
    await createNotification(
      { tenantId: "t1", userId: "u1", type: "TASK_DUE", title: "Task due: call back" },
      { create }
    )
    expect(create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", userId: "u1" })
  })

  it("writes to the delegate it is given, so a caller can commit it atomically", async () => {
    // The reminder cron writes the throttle claim and the bell in one
    // transaction; passing tx.notification is how that composes.
    const txCreate = vi.fn().mockResolvedValue({ id: "n2" })
    const res = await createNotification(
      { tenantId: "t1", userId: "u1", type: "TASK_DUE", title: "t" },
      { create: txCreate }
    )
    expect(res).toEqual({ id: "n2" })
    expect(txCreate).toHaveBeenCalledTimes(1)
    // and NOT on the root client
    expect(create).not.toHaveBeenCalled()
  })

  // The delegate is REQUIRED rather than defaulted to prisma.notification.
  // This is a compile-time property, so it is pinned here in prose: with a
  // default, the cron dropping its `tx.notification` argument would compile,
  // pass every test, and silently write the bell outside the transaction —
  // committing the throttle claim alone and permanently silencing that task.
  // A reviewer proved that exact mutation passed tsc + 2039 tests when the
  // parameter was optional. `npx tsc --noEmit` is the guard.
  it("documents that omitting the delegate is a type error, not a runtime surprise", () => {
    expect(createNotification.length).toBe(2)
  })
})
