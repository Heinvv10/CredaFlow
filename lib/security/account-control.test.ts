/** What real rows cannot stage: AuditLog.createdAt is stamped by the database, so an old creation beside a new one needs a staged clock. */
import { describe, expect, it, vi } from "vitest"
import { accountControlRefusal } from "./account-control"

const DAY = 86_400_000
const now = new Date("2026-11-01T10:00:00Z")
type Row = { userId: string; entityId: string; action: string; createdAt: Date }

function fake(rows: Row[]) {
  const matches = (r: Row, where: { entityId?: { in: string[] }; action?: string | { in: string[] }; createdAt?: { gte: Date } }) =>
    (!where.entityId || where.entityId.in.includes(r.entityId))
    && (typeof where.action !== "string" || r.action === where.action)
    && (!where.createdAt || r.createdAt >= where.createdAt.gte)
  return { auditLog: { findMany: vi.fn(async ({ where }: { where: Parameters<typeof matches>[1] & { OR?: unknown } }) => (where.OR ? [] : rows.filter((r) => matches(r, where)))) } }
}
const created = (by: string, who: string, ageDays: number): Row => ({ userId: by, entityId: who, action: "USER_CREATED", createdAt: new Date(now.getTime() - ageDays * DAY) })
const decide = (rows: Row[]) => accountControlRefusal(fake(rows) as never, { tenantId: "t", makerIds: ["maker"], checkerId: "checker", now })

describe("a shared creator (F12)", () => {
  it("relates a new account to an older one of the same creator, whichever side the new one is on", async () => {
    expect(await decide([created("boss", "maker", 200), created("boss", "checker", 3)])).toContain("Two people")
    expect(await decide([created("boss", "maker", 3), created("boss", "checker", 200)])).toContain("Two people")
  })
  it("does not relate two accounts both past the window, or two with different creators", async () => {
    expect(await decide([created("boss", "maker", 200), created("boss", "checker", 90)])).toBeNull()
    expect(await decide([created("boss", "maker", 3), created("other", "checker", 3)])).toBeNull()
  })
  it("leaves an account with no creation row alone: operator, bootstrap and seed", async () => {
    expect(await decide([created("boss", "maker", 3)])).toBeNull()
  })
})
