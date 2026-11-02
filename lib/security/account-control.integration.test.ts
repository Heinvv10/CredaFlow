/**
 * The two-people rule on real audit rows (real Postgres): both directions, a minted chain, the window, the exemptions. Which controls call
 * it is account-control-census.test.ts; the rule through real routes is lib/approval/approval-sockpuppet.integration.test.ts.
 *
 *   RUN_ACCOUNT_CONTROL_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/security/account-control.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { accountControlRefusal, ACCOUNT_CONTROL_DAYS, ACCOUNT_CONTROL_UNREADABLE } from "./account-control"

const suite = process.env.RUN_ACCOUNT_CONTROL_IT === "1" ? describe.sequential : describe.skip
const db = new PrismaClient()
const run = randomUUID().replaceAll("-", "").slice(0, 10)
const tenantId = `ac-${run}`
const otherTenant = `ac-other-${run}`
const id = (name: string) => `ac-${name}-${run}`
const people = ["root", "m", "c", "s1", "s2", "x", "y", "boss", "h1", "h2", "old1", "old2", "e1", "e2", "i1", "i2", "d1", "d2", "o1", "t1", "t2", "t3", "n1", "n2", "n3", "b1", "b2", "b3", "boss2", "h3", "h4", "h5", "a1", "a2", "a3", "k1", "k2", "k3", "r1", "r2", "r3", "j1", "j2", "sso", "w1", "w2", "w3", "s1m", ...Array.from({ length: 11 }, (_, i) => `link${i}`)].map(id)
const DAY = 86_400_000

/** AuditLog.createdAt is stamped by the database: a row is always "now", and the window is tested by moving the rule's own clock. */
async function trail(action: string, actor: string | null, target: string, tenant = tenantId, values: { oldValue?: object; newValue?: object } = {}) {
  await db.auditLog.create({ data: { tenantId: tenant, userId: actor, userEmail: `${actor}@test.invalid`, action, entity: "User", entityId: target, ...values } })
}
const update = (actor: string, target: string, values: { oldValue?: object; newValue?: object }) => trail("USER_UPDATED", actor, target, tenantId, values)
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
    await update(id("e1"), id("e2"), { newValue: { changed: [], passwordChanged: true } })
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
    await update(id("o1"), id("d1"), { oldValue: { email: "old@test.invalid" }, newValue: { email: "new@test.invalid" } })
    expect(await decide([id("o1")], id("d2"))).toContain("Two people")
  })

  it("the line follows a takeover, not only a creation: a password reset, a role or email change, a branch move or a second-factor reset up the line", async () => {
    await update(id("t1"), id("t2"), { newValue: { changed: [], passwordChanged: true } })
    await update(id("t2"), id("t3"), { oldValue: { role: "LOAN_ADMIN" }, newValue: { role: "ADMIN" } })
    expect(await decide([id("t1")], id("t3"))).toContain("Two people")
    await trail("TOTP_RESET_BY_ADMIN", id("b1"), id("b2"))
    await update(id("b2"), id("b3"), { oldValue: { branchId: "here" }, newValue: { branchId: "there" } })
    expect(await decide([id("b1")], id("b3"))).toContain("Two people")
  })

  it("a phone edit or an inbox tick between the two themselves keeps nobody apart, whichever way round", async () => {
    await update(id("x"), id("y"), { newValue: { changed: ["phone"] } })
    await update(id("y"), id("x"), { newValue: { isCommsAgent: true } })
    expect(await decide([id("x")], id("y"))).toBeNull()
    expect(await decide([id("y")], id("x"))).toBeNull()
  })

  it("a name or phone edit up the line, or a self-edit, is no hold over anyone", async () => {
    await update(id("n1"), id("n2"), { newValue: { changed: ["name"] } })
    await update(id("n2"), id("n3"), { newValue: { changed: ["phone"] } })
    await update(id("n3"), id("n3"), { newValue: { changed: [], passwordChanged: true } })
    expect(await decide([id("n1")], id("n3"))).toBeNull()
  })

  it("two accounts minted by one person are not two people inside the window; after it they are; another creator is unrelated", async () => {
    await trail("USER_CREATED", id("boss"), id("h1"))
    await trail("USER_CREATED", id("boss"), id("h2"))
    expect(await decide([id("h1")], id("h2"))).toContain("Two people")
    expect(await decide([id("boss")], id("h2"))).toContain("Two people")
    expect(await accountControlRefusal(db as never, { tenantId, makerIds: [id("h1")], checkerId: id("h2"), now: new Date(Date.now() + (ACCOUNT_CONTROL_DAYS + 1) * DAY) })).toBeNull()
    await trail("USER_CREATED", id("boss2"), id("h3"))
    expect(await decide([id("h1")], id("h3"))).toBeNull()
  })

  it("a shared creator up a minted chain counts: boss mints h4, h4 mints h5, h5 sits opposite boss's other account", async () => {
    await trail("USER_CREATED", id("boss2"), id("h4"))
    await trail("USER_CREATED", id("h4"), id("h5"))
    expect(await decide([id("h3")], id("h5"))).toContain("Two people")
  })

  it("one person holding the credentials of both is refused, on old accounts too: two takeovers, or a mint and a takeover", async () => {
    await update(id("k1"), id("k2"), { oldValue: { email: "a@test.invalid" }, newValue: { email: "b@test.invalid", passwordChanged: true } })
    await update(id("k1"), id("k3"), { newValue: { changed: [], passwordChanged: true } })
    expect(await decide([id("k2")], id("k3"))).toContain("Two people")
    await trail("USER_CREATED", id("r1"), id("r2"))
    await trail("TOTP_RESET_BY_ADMIN", id("r1"), id("r3"))
    expect(await decide([id("r2")], id("r3"))).toContain("Two people")
  })

  it("an admin placing two people on branches, or changing their roles, does not make them one person", async () => {
    await update(id("a1"), id("a2"), { oldValue: { branchId: null }, newValue: { branchId: "here" } })
    await update(id("a1"), id("a3"), { oldValue: { role: "LOAN_ADMIN" }, newValue: { role: "BRANCH_MANAGER" } })
    expect(await decide([id("a2")], id("a3"))).toBeNull()
    expect(await decide([id("a1")], id("a3"))).toContain("Two people")
  })

  it("the credentials line is read on credentials alone, on each side: a mint on one side and a branch move on the other are not one person", async () => {
    await trail("USER_CREATED", id("w1"), id("w2"))
    await update(id("w1"), id("w3"), { oldValue: { branchId: null }, newValue: { branchId: "here" } })
    expect(await decide([id("w2")], id("w3"))).toBeNull()
    expect(await decide([id("w3")], id("w2"))).toBeNull()
  })

  it("activation is a hold: the value on a new row, and on an older row the name of what changed", async () => {
    await update(id("o1"), id("e2"), { oldValue: { active: false }, newValue: { active: true } })
    expect(await decide([id("o1")], id("e2"))).toContain("Two people")
    await update(id("old1"), id("e1"), { newValue: { changed: ["active"] } })
    expect(await decide([id("old1")], id("e1"))).toContain("Two people")
  })

  it("an account that came through an SSO connection sits apart from whoever configured it, not from another such account", async () => {
    await trail("SSO_CONNECTION_UPDATED", id("sso"), tenantId, tenantId, {})
    await trail("SSO_USER_PROVISIONED", id("j1"), id("j1"))
    await trail("SSO_IDENTITY_LINKED", id("j2"), id("j2"))
    expect(await decide([id("sso")], id("j1"))).toContain("Two people")
    expect(await decide([id("j2")], id("sso"))).toContain("Two people")
    expect(await decide([id("j1")], id("j2"))).toBeNull()
    // A mint by the connection's controller opposite an account through that connection: one person may hold both.
    await trail("USER_CREATED", id("sso"), id("s1m"))
    expect(await decide([id("s1m")], id("j1"))).toContain("Two people")
    expect(await decide([id("j2")], id("s1m"))).toContain("Two people")
  })

  it("a line too long to walk is refused, not passed unread, on either side", async () => {
    for (let i = 0; i < 10; i += 1) await update(id(`link${i + 1}`), id(`link${i}`), { newValue: { changed: [], passwordChanged: true } })
    expect(await decide([id("x")], id("link0"))).toBe(ACCOUNT_CONTROL_UNREADABLE)
    expect(await decide([id("link0")], id("x"))).toBe(ACCOUNT_CONTROL_UNREADABLE)
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
