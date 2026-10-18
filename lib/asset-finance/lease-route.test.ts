import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ outcomes: [] as string[], execute: vi.fn(async () => 0), tx: {} as Record<string, unknown>, auditRefusal: vi.fn(async () => undefined) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    // A transaction commits when its callback returns and rolls back when it throws.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      try {
        m.tx = { $executeRawUnsafe: m.execute }
        const result = await fn(m.tx)
        m.outcomes.push("committed")
        return result
      } catch (error) {
        m.outcomes.push("rolled back")
        throw error
      }
    },
  },
}))
vi.mock("@/lib/audit-refusals", () => ({ auditRefusal: m.auditRefusal }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("./lease-portal-route", () => ({
  withPortalLease: (_req: Request, _loanId: string, handler: (ctx: unknown) => Promise<Response>) =>
    handler({ tenantId: "t1", client: { clientId: "c1", email: "lessee@test.invalid" }, loanId: "l1", entityId: null }),
}))

import { cents, isoDate, leasePortalAction, type LeaseActionResult } from "./lease-route"

const post = (body: string) => new Request("http://lease.test/api/portal/x", { method: "POST", body })
const portal = (body: string, result: LeaseActionResult) => {
  const action = vi.fn(async () => result)
  return { action, response: leasePortalAction(post(body), "l1", "test_action", action) }
}

describe("lease route body readers", () => {
  it("cents: a whole, non-negative number within the database's 32-bit columns", () => {
    expect(cents({ v: 0 }, "v")).toBe(0)
    expect(cents({ v: 2_147_483_647 }, "v")).toBe(2_147_483_647)
    for (const v of [2_147_483_648, -1, 1.5, "100", null, Number.NaN]) expect(cents({ v }, "v")).toBeNull()
    expect(cents({}, "v")).toBeNull()
  })
  it("isoDate: a real calendar date, YYYY-MM-DD", () => {
    expect(isoDate({ d: "2028-02-29" }, "d")).toBe("2028-02-29")
    for (const d of ["2027-02-29", "2027-02-30", "2027-13-01", "2027-1-01", "2027-01-01T00:00:00Z", "", 20270101]) expect(isoDate({ d }, "d")).toBeNull()
  })
})

describe("leasePortalAction: the body, the transaction, the response", () => {
  beforeEach(() => {
    m.outcomes.length = 0
    m.auditRefusal.mockClear()
    m.execute.mockClear()
  })

  it("a body that is not JSON, or not an object, is a 400 and the action never runs", async () => {
    for (const body of ["{not json", "[1, 2]", "42", "null"]) {
      const { action, response } = portal(body, { kind: "ok" })
      expect((await response).status).toBe(400)
      expect(action).not.toHaveBeenCalled()
    }
    expect(m.outcomes).toEqual([])
  })

  it("an empty body is an empty object; a result is a 200 and the transaction commits", async () => {
    const { action, response } = portal("  ", { kind: "ok", id: "x" })
    const res = await response
    expect([res.status, await res.json()]).toEqual([200, { kind: "ok", id: "x" }])
    expect(action).toHaveBeenCalledWith(m.tx, { tenantId: "t1", clientId: "c1" }, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), {})
    expect(m.execute).toHaveBeenCalledWith("SET CONSTRAINTS ALL IMMEDIATE")
    expect(m.outcomes).toEqual(["committed"])
  })

  it("a refusal rolls the transaction back (nothing written before it is kept), is audited and answered 409", async () => {
    const res = await portal(`{"a":1}`, { kind: "refused", reason: "open_claims", error: "A claim is open" }).response
    expect([res.status, await res.json()]).toEqual([409, { error: "A claim is open", reason: "open_claims" }])
    expect(m.outcomes).toEqual(["rolled back"])
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({ reason: "open_claims", status: 409, entityId: "l1", detail: { action: "test_action" } }))
  })

  it("not found rolls back too, and is a 404", async () => {
    expect((await portal("{}", { kind: "not_found" }).response).status).toBe(404)
    expect(m.outcomes).toEqual(["rolled back"])
  })

  it("a missing prerequisite is a 422, an invalid field a 400", async () => {
    expect((await portal("{}", { kind: "refused", reason: "recipient", error: "x" }).response).status).toBe(422)
    expect((await portal("{}", { kind: "refused", reason: "invalid_noticeOn", error: "x" }).response).status).toBe(400)
    expect(m.outcomes).toEqual(["rolled back", "rolled back"])
  })
})
