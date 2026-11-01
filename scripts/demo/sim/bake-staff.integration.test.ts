/**
 * A baked admin and baked staff member are two people on day one, through a real two-person control on real Postgres, with no bypass in the
 * rule: the staff are bootstrapped (provisionBakeStaff) and the operator, not the admin, assigns their branches and roster. Run with RUN_DB_IT=1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { decideReferenceRate } from "@/lib/asset-finance/reference-rate-decision"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { BAKE_STAFF, COLLECTIONS_MANAGER, STAFF } from "../breadth/staff"
import { OPERATOR_TENANT_SLUG, SIM_DATABASE_MARKER, provisionBakeStaff, provisionOperator } from "./operator"

const suite = process.env.RUN_DB_IT === "1" ? describe.sequential : describe.skip

suite("the bake's staff and the two-people rule (real Postgres)", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db
  let tenantId = ""
  let adminId = ""
  let operatorId = ""
  let day = 1

  /** A repo rate one person records and another decides, through the real decision. */
  async function decide(makerId: string, checkerId: string) {
    const rate = await db().referenceRate.create({ data: { tenantId, basis: "REPO", effectiveDate: new Date(`2026-03-${String(day++).padStart(2, "0")}T00:00:00Z`), rate: "0.0775", requestedById: makerId } })
    return db().$transaction((tx) => decideReferenceRate(tx as never, { tenantId, rateId: rate.id, decision: "APPROVE", deciderId: checkerId, today: "2026-11-01" }))
  }

  beforeAll(async () => {
    fresh = await createThrowawayDb({})
    await db().$executeRawUnsafe(`DO $$ BEGIN EXECUTE format('COMMENT ON DATABASE %I IS %L', current_database(), '${SIM_DATABASE_MARKER}'); END $$`)
    tenantId = (await db().tenant.create({ data: { slug: OPERATOR_TENANT_SLUG, name: "Bake lender" } })).id
    // The seed's admin: a row, no audit trail (prisma/seed.ts upsertStaff).
    adminId = (await db().user.create({ data: { tenantId, email: "admin@bake.invalid", password: "not-a-real-login", name: "Admin", role: "ADMIN" } })).id
  }, 240_000)
  afterAll(() => fresh?.drop())

  it("bootstrapped staff leave no audit row, and the admin and a baked staff member sit a control on day one, either way round", async () => {
    operatorId = (await provisionOperator(db() as never)).userId
    const baked = await provisionBakeStaff(db() as never)
    expect(baked.map((s) => s.email)).toEqual(BAKE_STAFF.map((s) => s.email))
    expect(await db().auditLog.count({ where: { tenantId, entity: "User" } })).toBe(0)
    const manager = baked.find((s) => s.email === STAFF.branchManager.email)!
    const collections = baked.find((s) => s.email === COLLECTIONS_MANAGER.email)!
    expect(await decide(adminId, manager.userId)).toMatchObject({ kind: "decided" })
    expect(await decide(manager.userId, adminId)).toMatchObject({ kind: "decided" })
    expect(await decide(collections.userId, manager.userId)).toMatchObject({ kind: "decided" })
  })

  it("the operator placing them on a branch and the roster stands between neither of them; the same edit by the admin would", async () => {
    const manager = (await db().user.findUniqueOrThrow({ where: { email: STAFF.branchManager.email } })).id
    const edit = (actor: string, target: string, values: object) => db().auditLog.create({ data: { tenantId, userId: actor, action: "USER_UPDATED", entity: "User", entityId: target, ...values } })
    await edit(operatorId, manager, { oldValue: { branchId: null }, newValue: { branchId: "pta" } })
    await edit(operatorId, manager, { newValue: { isCommsAgent: true } })
    expect(await decide(adminId, manager)).toMatchObject({ kind: "decided" })
    await edit(adminId, manager, { newValue: { isCommsAgent: true } })
    expect(await decide(adminId, manager)).toMatchObject({ kind: "account_controlled" })
  })

  it("staff created through Settings → Users are what the bootstrap avoids: the admin's creation row keeps them apart", async () => {
    const added = (await db().user.create({ data: { tenantId, email: "added@bake.invalid", password: "not-a-real-login", name: "Added", role: "BRANCH_MANAGER" } })).id
    await db().auditLog.create({ data: { tenantId, userId: adminId, action: "USER_CREATED", entity: "User", entityId: added } })
    expect(await decide(adminId, added)).toMatchObject({ kind: "account_controlled" })
  })
})
