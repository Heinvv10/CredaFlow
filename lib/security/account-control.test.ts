/** What real rows cannot stage: AuditLog.createdAt is stamped by the database, so a creation outside the window needs a staged clock. */
import { describe, expect, it, vi } from "vitest"
import { accountControlRefusal } from "./account-control"

const DAY = 86_400_000
const now = new Date("2026-11-01T10:00:00Z")
type Row = { userId: string; entityId: string; action: string; createdAt: Date }

function fake(rows: Row[]) {
  const matches = (r: Row, where: { entityId?: { in: string[] }; createdAt?: { gte: Date } }) =>
    (!where.entityId || where.entityId.in.includes(r.entityId)) && (!where.createdAt || r.createdAt >= where.createdAt.gte)
  return { auditLog: { findMany: vi.fn(async ({ where }: { where: Parameters<typeof matches>[1] }) => rows.filter((r) => matches(r, where))) } }
}
const created = (by: string, who: string, ageDays: number): Row => ({ userId: by, entityId: who, action: "USER_CREATED", createdAt: new Date(now.getTime() - ageDays * DAY) })
const decide = (rows: Row[]) => accountControlRefusal(fake(rows) as never, { tenantId: "t", makerIds: ["maker"], checkerId: "checker", now })

describe("a shared creator (F12)", () => {
  it("relates two accounts only while both creations are inside the window", async () => {
    expect(await decide([created("boss", "maker", 3), created("boss", "checker", 3)])).toContain("Two people")
    expect(await decide([created("boss", "maker", 200), created("boss", "checker", 3)])).toBeNull()
    expect(await decide([created("boss", "maker", 3), created("boss", "checker", 200)])).toBeNull()
    expect(await decide([created("boss", "maker", 200), created("boss", "checker", 90)])).toBeNull()
  })
  it("leaves two creators, and an account with no creation row, alone: operator, bootstrap and seed", async () => {
    expect(await decide([created("boss", "maker", 3), created("other", "checker", 3)])).toBeNull()
    expect(await decide([created("boss", "maker", 3)])).toBeNull()
  })
})
