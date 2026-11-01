/**
 * The two-people rule on real audit rows (real Postgres): both directions, a minted chain, the window, the exemptions. Which controls call
 * it is account-control-census.test.ts; the rule through real routes is lib/approval/approval-sockpuppet.integration.test.ts.
 *
 *   RUN_ACCOUNT_CONTROL_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/security/account-control.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { accountControlRefusal, ACCOUNT_CONTROL_DAYS } from "./account-control"

const suite = process.env.RUN_ACCOUNT_CONTROL_IT === "1" ? describe.sequential : describe.skip
const db = new PrismaClient()
const run = randomUUID().replaceAll("-", "").slice(0, 10)
const tenantId = `ac-${run}`
const otherTenant = `ac-other-${run}`
const id = (name: string) => `ac-${name}-${run}`
const people = ["root", "m", "c", "s1", "s2", "x", "y", "boss", "h1", "h2", "old1", "old2", "e1", "e2", "i1", "i2", "d1", "d2", "o1"].map(id)
const DAY = 86_400_000

/** AuditLog.createdAt is stamped by the database: a row is always "now", and the window is tested by moving the rule's own clock. */
async function trail(action: string, actor: string | null, target: string, tenant = tenantId) {
  await db.auditLog.create({ data: { tenantId: tenant, userId: actor, userEmail: `${actor}@test.invalid`, action, entity: "User", entityId: target } })
}
const decide = (makerIds: Array<string | null>, checkerId: string) => accountControlRefusal(db as never, { tenantId, makerIds, checkerId })

suite("two people, not two accounts: the rule (real Postgres)", () => {
  beforeAll(async () => {
    await db.tenant.createMany({ data: [{ id: tenantId, slug: tenantId, name: "AC" }, { id: otherTenant, slug: otherTenant, name: "AC other" }] })
    await db.user.createMany({ data: people.map((u) => ({ id: u, tenantId, email: `${u}@test.invalid`, password: "not-a-real-login", name: u, role: "ADMIN" as const })) })
  }, 60_000)
  afterAll(async () => { await db.$disconnect() })

  it("accounts with no relation on record pass: that is what an operator-provisioned, bootstrap or seeded account looks like", async () => {
    expect(await decide([id("x")], id("y"))).toBeNull()
  })

  it("the maker created, changed or reset the approver: refused (the new direction); the same with the roles swapped", async () => {
    await trail("USER_CREATED", id("m"), id("c"))
    expect(await decide([id("m")], id("c"))).toContain("Two people")
    expect(await decide([id("c")], id("m"))).toContain("Two people")
    await trail("USER_UPDATED", id("e1"), id("e2"))
    expect(await decide([id("e1")], id("e2"))).toContain("Two people")
    await trail("TOTP_RESET_BY_ADMIN", id("i1"), id("i2"))
    expect(await decide([id("i1")], id("i2"))).toContain("Two people")
  })

  it("two hops do not launder it: the maker mints s1, s1 mints s2, s2 approves; and in reverse", async () => {
    await trail("USER_CREATED", id("root"), id("s1"))
    await trail("USER_CREATED", id("s1"), id("s2"))
    expect(await decide([id("root")], id("s2"))).toContain("Two people")
    expect(await decide([id("s2")], id("root"))).toContain("Two people")
  })

  it("a change to an account up the minted chain counts: the maker took over s1's parent", async () => {
    await trail("USER_CREATED", id("d1"), id("d2"))
    await trail("USER_UPDATED", id("o1"), id("d1"))
    expect(await decide([id("o1")], id("d2"))).toContain("Two people")
  })

  it("a common creator alone does not relate two people: the first admin sets up the whole team", async () => {
    await trail("USER_CREATED", id("boss"), id("h1"))
    await trail("USER_CREATED", id("boss"), id("h2"))
    expect(await decide([id("h1")], id("h2"))).toBeNull()
    expect(await decide([id("boss")], id("h2"))).toContain("Two people")
  })

  it("the window closes after the rule's days, on both the direct row and the chain", async () => {
    const at = (days: number) => new Date(Date.now() + days * DAY)
    await trail("USER_CREATED", id("old1"), id("old2"))
    await trail("USER_CREATED", id("old2"), id("c"))
    expect(await accountControlRefusal(db as never, { tenantId, makerIds: [id("old1")], checkerId: id("c"), now: at(ACCOUNT_CONTROL_DAYS - 1) })).toContain("Two people")
    expect(await accountControlRefusal(db as never, { tenantId, makerIds: [id("old1")], checkerId: id("c"), now: at(ACCOUNT_CONTROL_DAYS + 1) })).toBeNull()
    expect(await accountControlRefusal(db as never, { tenantId, makerIds: [id("old1")], checkerId: id("old2"), now: at(ACCOUNT_CONTROL_DAYS + 1) })).toBeNull()
  })

  it("a self-edit, a null maker and the checker named as a maker relate nobody", async () => {
    await trail("USER_UPDATED", id("y"), id("y"))
    expect(await decide([id("y"), null], id("y"))).toBeNull()
    expect(await decide([null], id("y"))).toBeNull()
    expect(await decide([id("x")], id("y"))).toBeNull()
  })

  it("another lender's rows are not read", async () => {
    await trail("USER_CREATED", id("x"), id("y"), otherTenant)
    expect(await decide([id("x")], id("y"))).toBeNull()
  })

  it("a harmless action on the account is not control (a sign-in refusal, a deactivation)", async () => {
    await trail("USER_WRITE_REFUSED", id("x"), id("y"))
    await trail("USER_DEACTIVATED", id("x"), id("y"))
    expect(await decide([id("x")], id("y"))).toBeNull()
  })
})
