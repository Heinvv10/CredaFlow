import { beforeEach, describe, expect, it, vi } from "vitest"
import { ChangeRequestError } from "./errors"
import type { ChangeHandler } from "./types"

const h = vi.hoisted(() => ({ totpRequired: true, handler: null as unknown, control: null as unknown, minted: null as unknown, earlierTotp: null as unknown, recent: [] as unknown[], makerCreatedAt: new Date("2026-01-01T00:00:00Z") as Date | null }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/security/staff-totp-policy", () => ({ isStaffTotpRequired: async () => h.totpRequired }))
vi.mock("./handlers", () => ({ handlerFor: (kind: string) => (kind === "TEST_KIND" ? h.handler : null) }))

import { approve, createDraft, reject, submit, updateDraft, withdraw } from "./service"

const maker = { id: "u-maker", email: "m@x.invalid", role: "ADMIN", totpVerified: true }
const checker = { id: "u-checker", email: "c@x.invalid", role: "ADMIN", totpVerified: true }
const officer = { id: "u-off", email: "o@x.invalid", role: "CREDIT_OFFICER", totpVerified: true }
const row = (over: Record<string, unknown> = {}) => ({ id: "cr1", tenantId: "t", kind: "TEST_KIND", status: "SUBMITTED", makerId: "u-maker", payload: { amount: 5 }, payloadVersion: 1, baseRef: null, ...over })

function handler(over: Partial<ChangeHandler<{ amount: number }>> = {}): ChangeHandler<{ amount: number }> {
  return {
    kind: "TEST_KIND", label: "Test change", payloadVersion: 1,
    makePermission: "manage_decision_rules", approvePermission: "approve_decision_rules",
    parse: (raw) => raw as { amount: number }, apply: vi.fn(async () => undefined), ...over,
  }
}

/** A db whose transaction hands the callback a tx that finds `found` and records writes. */
function fakeDb(found: unknown, count = 1) {
  const tx = {
    changeRequest: { findFirst: vi.fn(async () => found), updateMany: vi.fn(async () => ({ count })), create: vi.fn(async (a: { data: Record<string, unknown> }) => ({ id: "new", status: "DRAFT", kind: "TEST_KIND", ...a.data })) },
    auditLog: { create: vi.fn(), findMany: vi.fn(async (a: { take?: number; cursor?: { id: string } } = {}) => {
      // Newest first, paged by cursor as the service asks (rows without an id get one by position).
      const rows = (h.recent as Array<Record<string, unknown>>).map((r, i) => ({ id: `r${i}`, createdAt: new Date(), ...r }))
      const start = a.cursor ? rows.findIndex((r) => r.id === a.cursor!.id) + 1 : 0
      return rows.slice(start, start + (a.take ?? rows.length))
    }), findFirst: vi.fn(async (a: { where: { action: { in: string[] } } }) => (a.where.action.in.includes("SSO_USER_PROVISIONED") ? h.minted : a.where.action.in.includes("TOTP_ENROLLED") ? h.earlierTotp : h.control)) },
    user: { findFirst: vi.fn(async () => (h.makerCreatedAt ? { createdAt: h.makerCreatedAt } : null)) },
    $executeRaw: vi.fn(async () => 0),
  }
  const db = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)), changeRequest: tx.changeRequest }
  return { db: db as never, tx }
}
const scope = { tenantId: "t", id: "cr1" }

beforeEach(() => { h.totpRequired = true; h.handler = handler(); h.control = null; h.minted = null; h.earlierTotp = null; h.recent = []; h.makerCreatedAt = new Date("2026-01-01T00:00:00Z") })

describe("maker-checker service (state, permission, staleness; the database rules are in the integration suite)", () => {
  it("refuses an unknown kind before touching the database", async () => {
    const { db, tx } = fakeDb(null)
    await expect(createDraft({ tenantId: "t", actor: maker, kind: "NOPE", title: "t", payload: {} }, db)).rejects.toMatchObject({ code: "UNKNOWN_KIND" })
    expect(tx.changeRequest.create).not.toHaveBeenCalled()
  })

  it("refuses a user without the kind's permission, for every step that needs one", async () => {
    await expect(createDraft({ tenantId: "t", actor: officer, kind: "TEST_KIND", title: "t", payload: {} }, fakeDb(row()).db)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(approve({ ...scope, actor: officer }, fakeDb(row()).db)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(reject({ ...scope, actor: officer, note: "x" }, fakeDb(row()).db)).rejects.toMatchObject({ code: "FORBIDDEN" })
    // The maker lost the make permission: withdrawing needs it too.
    await expect(withdraw({ ...scope, actor: { ...maker, role: "CREDIT_OFFICER" } }, fakeDb(row()).db)).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("an approve permission may depend on the payload", async () => {
    // LOAN_ADMIN holds disburse_loan but not delete_client (ADMIN).
    h.handler = handler({ approvePermission: (p) => (p.amount > 10 ? "delete_client" : "disburse_loan") })
    const loanAdmin = { ...checker, role: "LOAN_ADMIN" }
    await expect(approve({ ...scope, actor: loanAdmin }, fakeDb(row({ payload: { amount: 50 } })).db)).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect((await approve({ ...scope, actor: loanAdmin }, fakeDb(row({ payload: { amount: 5 } })).db)).id).toBe("cr1")
  })

  describe("a checker who controls the maker's account is not a second person", () => {
    it("refuses a checker who created or changed the maker's account in the last 30 days, writing nothing", async () => {
      h.control = { id: "audit-1" }
      const { db, tx } = fakeDb(row())
      await expect(approve({ ...scope, actor: checker }, db)).rejects.toMatchObject({ code: "MAKER_ACCOUNT_CONTROLLED", status: 403 })
      expect(tx.changeRequest.updateMany).not.toHaveBeenCalled()
      const query = (tx.auditLog.findFirst.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where
      expect(query).toMatchObject({ tenantId: "t", entity: "User", entityId: "u-maker", userId: "u-checker", action: { in: ["USER_CREATED", "USER_UPDATED", "TOTP_RESET_BY_ADMIN"] } })
      const since = (query.createdAt as { gte: Date }).gte.getTime()
      expect(Date.now() - since).toBeGreaterThan(29.9 * 86_400_000)
      expect(Date.now() - since).toBeLessThan(30.1 * 86_400_000)
    })

    it.each([
      ["a tenant user created (USER_CREATED)", { id: "audit-created" }],
      ["SSO provisioned (SSO_USER_PROVISIONED)", { id: "audit-sso" }],
    ])("refuses a maker account younger than 30 days that %s, writing nothing", async (_label, minted) => {
      h.makerCreatedAt = new Date(Date.now() - 29 * 86_400_000)
      h.minted = minted
      const { db, tx } = fakeDb(row())
      await expect(approve({ ...scope, actor: checker }, db)).rejects.toMatchObject({ code: "MAKER_ACCOUNT_CONTROLLED", status: 403 })
      expect(tx.changeRequest.updateMany).not.toHaveBeenCalled()
      const origin = (tx.auditLog.findFirst.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where
      expect(origin).toMatchObject({ tenantId: "t", entity: "User", entityId: "u-maker", action: { in: ["USER_CREATED", "SSO_USER_PROVISIONED"] } })
    })

    it("exempts a young account no tenant user or SSO minted (operator provisioning, bootstrap, the seed: no creation row)", async () => {
      h.makerCreatedAt = new Date(Date.now() - 2 * 86_400_000)
      h.minted = null
      expect((await approve({ ...scope, actor: checker }, fakeDb(row()).db)).id).toBe("cr1")
    })

    it("does not ask for the origin of an account that is 30 days old or more, and refuses one that no longer exists", async () => {
      h.makerCreatedAt = new Date(Date.now() - 31 * 86_400_000)
      h.minted = { id: "audit-created" }
      expect((await approve({ ...scope, actor: checker }, fakeDb(row()).db)).id).toBe("cr1")
      h.makerCreatedAt = null
      await expect(approve({ ...scope, actor: checker }, fakeDb(row()).db)).rejects.toMatchObject({ code: "MAKER_ACCOUNT_CONTROLLED" })
    })

    describe("an account taken over in the last 30 days, whoever wrote the row", () => {
      it.each(["SSO_IDENTITY_LINKED", "SSO_ROLE_SYNCED", "TOTP_REPLACED", "TOTP_DISABLED", "TOTP_RESET_BY_ADMIN", "SSO_PASSWORD_BREAK_GLASS"])("%s refuses the maker", async (action) => {
        h.recent = [{ action, oldValue: null, newValue: null }]
        const { db, tx } = fakeDb(row())
        await expect(approve({ ...scope, actor: checker }, db)).rejects.toMatchObject({ code: "MAKER_ACCOUNT_CONTROLLED", status: 403 })
        expect(tx.changeRequest.updateMany).not.toHaveBeenCalled()
      })

      it("a user's FIRST TOTP enrolment (none on record before it) is not a takeover: a new admin enrols at first login", async () => {
        h.recent = [{ action: "TOTP_ENROLLED", createdAt: new Date(Date.now() - 5 * 86_400_000), oldValue: null, newValue: null }]
        h.earlierTotp = null
        const { db, tx } = fakeDb(row())
        expect((await approve({ ...scope, actor: checker }, db)).id).toBe("cr1")
        const earlier = (tx.auditLog.findFirst.mock.calls.find((c) => (c[0] as { where: { action: { in: string[] } } }).where.action.in.includes("TOTP_ENROLLED")) as unknown as [{ where: Record<string, unknown> }])[0].where
        expect(earlier).toMatchObject({ tenantId: "t", entity: "User", entityId: "u-maker", createdAt: { lt: expect.any(Date) }, action: { in: expect.arrayContaining(["TOTP_ENROLLED", "TOTP_REPLACED", "TOTP_DISABLED", "TOTP_RESET_BY_ADMIN"]) } })
      })

      it("a TOTP enrolment after an earlier enrolment, replacement, disable or reset is a takeover (reset, then re-enrol)", async () => {
        h.recent = [{ action: "TOTP_ENROLLED", createdAt: new Date(Date.now() - 5 * 86_400_000), oldValue: null, newValue: null }]
        h.earlierTotp = { id: "earlier-reset" }
        await expect(approve({ ...scope, actor: checker }, fakeDb(row()).db)).rejects.toMatchObject({ code: "MAKER_ACCOUNT_CONTROLLED" })
      })

      it.each([
        ["a role change", { oldValue: { role: "READONLY" }, newValue: { role: "ADMIN", changed: ["role"] } }],
        ["an email change", { oldValue: { email: "a@x.invalid" }, newValue: { email: "b@x.invalid", changed: ["email"] } }],
        ["a password change by an administrator", { oldValue: null, newValue: { changed: [], passwordChanged: true } }],
        ["a password reset by the person (recovery link)", { oldValue: null, newValue: { passwordChanged: true, resetTokenConsumed: true } }],
      ])("a USER_UPDATED row recording %s refuses the maker", async (_label, trail) => {
        h.recent = [{ action: "USER_UPDATED", ...trail }]
        await expect(approve({ ...scope, actor: checker }, fakeDb(row()).db)).rejects.toMatchObject({ code: "MAKER_ACCOUNT_CONTROLLED" })
      })

      it("a USER_UPDATED row that changed only a name, phone or branch does not", async () => {
        h.recent = [{ action: "USER_UPDATED", oldValue: null, newValue: { changed: ["name", "phone", "branchId"] } }]
        expect((await approve({ ...scope, actor: checker }, fakeDb(row()).db)).id).toBe("cr1")
      })

      it("harmless USER_UPDATED rows cannot hide a takeover: 250 name edits newer than one role change still refuse", async () => {
        const harmless = Array.from({ length: 250 }, () => ({ action: "USER_UPDATED", oldValue: null, newValue: { changed: ["name"] } }))
        h.recent = [...harmless, { action: "USER_UPDATED", oldValue: { role: "READONLY" }, newValue: { role: "ADMIN" } }]
        await expect(approve({ ...scope, actor: checker }, fakeDb(row()).db)).rejects.toMatchObject({ code: "MAKER_ACCOUNT_CONTROLLED" })
      })

      it("a takeover row of another kind (second factor, SSO) behind 250 harmless rows is found too", async () => {
        const harmless = Array.from({ length: 250 }, () => ({ action: "USER_UPDATED", oldValue: null, newValue: { changed: ["phone"] } }))
        h.recent = [...harmless, { action: "TOTP_RESET_BY_ADMIN", oldValue: null, newValue: null }]
        await expect(approve({ ...scope, actor: checker }, fakeDb(row()).db)).rejects.toMatchObject({ code: "MAKER_ACCOUNT_CONTROLLED" })
      })

      it("fails closed when the trail is longer than the most it will read, rather than approve unseen rows", async () => {
        h.recent = Array.from({ length: 6000 }, () => ({ action: "USER_UPDATED", oldValue: null, newValue: { changed: ["name"] } }))
        await expect(approve({ ...scope, actor: checker }, fakeDb(row()).db)).rejects.toMatchObject({ code: "MAKER_ACCOUNT_CONTROLLED" })
      })

      it("reads the trail newest first, in pages", async () => {
        const { db, tx } = fakeDb(row())
        await approve({ ...scope, actor: checker }, db)
        const query = (tx.auditLog.findMany.mock.calls[0] as unknown as [{ orderBy: unknown; take: number }])[0]
        expect(query.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }])
        expect(query.take).toBe(200)
      })

      it("looks at the maker's own rows from the last 30 days, written by anyone", async () => {
        const { db, tx } = fakeDb(row())
        await approve({ ...scope, actor: checker }, db)
        const where = (tx.auditLog.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where
        expect(where).toMatchObject({ tenantId: "t", entity: "User", entityId: "u-maker" })
        expect(where).not.toHaveProperty("userId")
        expect((where.action as { in: string[] }).in.slice().sort()).toEqual(["SSO_IDENTITY_LINKED", "SSO_PASSWORD_BREAK_GLASS", "SSO_ROLE_SYNCED", "TOTP_DISABLED", "TOTP_ENROLLED", "TOTP_REPLACED", "TOTP_RESET_BY_ADMIN", "USER_UPDATED"])
        const age = Date.now() - (where.createdAt as { gte: Date }).gte.getTime()
        expect(age).toBeGreaterThan(29.9 * 86_400_000)
        expect(age).toBeLessThan(30.1 * 86_400_000)
      })
    })

    describe("a high-risk payload also needs a maker account that is itself 30 days old, wherever it came from", () => {
      const risky = () => handler({ makePermissionFor: (p) => (p.amount > 10 ? "delete_client" : "manage_decision_rules") })
      it("refuses a young, unminted (operator or seed) account for the risky payload, and allows it for an ordinary one", async () => {
        h.makerCreatedAt = new Date(Date.now() - 2 * 86_400_000)
        h.minted = null
        h.handler = risky()
        await expect(approve({ ...scope, actor: checker }, fakeDb(row({ payload: { amount: 50 } })).db)).rejects.toMatchObject({ code: "MAKER_ACCOUNT_CONTROLLED" })
        expect((await approve({ ...scope, actor: checker }, fakeDb(row({ payload: { amount: 5 } })).db)).id).toBe("cr1")
      })
      it("allows the risky payload from an account 30 days old or more", async () => {
        h.handler = risky()
        expect((await approve({ ...scope, actor: checker }, fakeDb(row({ payload: { amount: 50 } })).db)).id).toBe("cr1")
      })
    })

    it("lets a checker with no such history approve", async () => {
      expect((await approve({ ...scope, actor: checker }, fakeDb(row()).db)).id).toBe("cr1")
    })
  })

  describe("a handler may need a stronger maker for a high-risk payload", () => {
    const risky = () => handler({ makePermissionFor: (p) => (p.amount > 10 ? "delete_client" : "manage_decision_rules") })
    const loanAdmin = { ...maker, role: "LOAN_ADMIN" }
    it("refuses drafting, editing and submitting the risky payload to a role below it, and lets the ordinary one through", async () => {
      h.handler = risky()
      await expect(createDraft({ tenantId: "t", actor: loanAdmin, kind: "TEST_KIND", title: "t", payload: { amount: 50 } }, fakeDb(null).db)).rejects.toMatchObject({ code: "FORBIDDEN" })
      expect((await createDraft({ tenantId: "t", actor: loanAdmin, kind: "TEST_KIND", title: "t", payload: { amount: 5 } }, fakeDb(null).db)).id).toBe("new")
      await expect(updateDraft({ ...scope, actor: loanAdmin, payload: { amount: 50 } }, fakeDb(row({ status: "DRAFT" })).db)).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(submit({ ...scope, actor: loanAdmin }, fakeDb(row({ status: "DRAFT", payload: { amount: 50 } })).db)).rejects.toMatchObject({ code: "FORBIDDEN" })
      expect((await createDraft({ tenantId: "t", actor: maker, kind: "TEST_KIND", title: "t", payload: { amount: 50 } }, fakeDb(null).db)).id).toBe("new")
    })
  })

  it("answers not found for a request outside the tenant, without writing", async () => {
    const { db, tx } = fakeDb(null)
    await expect(approve({ ...scope, actor: checker }, db)).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(tx.changeRequest.updateMany).not.toHaveBeenCalled()
  })

  it("stops a maker approving or rejecting their own change before any write", async () => {
    const { db, tx } = fakeDb(row())
    await expect(approve({ ...scope, actor: maker }, db)).rejects.toMatchObject({ code: "SELF_APPROVAL" })
    await expect(reject({ ...scope, actor: maker, note: "no" }, db)).rejects.toMatchObject({ code: "SELF_APPROVAL" })
    expect(tx.changeRequest.updateMany).not.toHaveBeenCalled()
  })

  it("turns the database's four-eyes refusal into the same answer", async () => {
    const { db, tx } = fakeDb(row({ makerId: "someone-else" }))
    tx.changeRequest.updateMany.mockRejectedValueOnce(new Error('violates check constraint "ChangeRequest_four_eyes"'))
    await expect(approve({ ...scope, actor: checker }, db)).rejects.toMatchObject({ code: "SELF_APPROVAL" })
  })

  it("says wrong state when the request moved on (the guarded update matched nothing)", async () => {
    const { db } = fakeDb(row({ makerId: "someone-else" }), 0)
    await expect(approve({ ...scope, actor: checker }, db)).rejects.toMatchObject({ code: "WRONG_STATE" })
    await expect(reject({ ...scope, actor: checker, note: "x" }, db)).rejects.toMatchObject({ code: "WRONG_STATE" })
  })

  it("only the maker edits, submits or withdraws", async () => {
    const { db } = fakeDb(row({ status: "DRAFT" }))
    await expect(updateDraft({ ...scope, actor: checker, title: "x" }, db)).rejects.toMatchObject({ code: "NOT_MAKER" })
    await expect(submit({ ...scope, actor: checker }, db)).rejects.toMatchObject({ code: "NOT_MAKER" })
    await expect(withdraw({ ...scope, actor: checker }, db)).rejects.toMatchObject({ code: "NOT_MAKER" })
  })

  it("rejecting needs a reason", async () => {
    await expect(reject({ ...scope, actor: checker, note: "   " }, fakeDb(row()).db)).rejects.toBeInstanceOf(ChangeRequestError)
  })

  it("refuses a title that is empty or too long with a 4xx, not a database error", async () => {
    for (const title of ["   ", "x".repeat(201)]) {
      await expect(createDraft({ tenantId: "t", actor: maker, kind: "TEST_KIND", title, payload: {} }, fakeDb(null).db)).rejects.toMatchObject({ code: "INVALID_PAYLOAD", status: 422 })
    }
  })
})

describe("step-up two-factor", () => {
  it("refuses approve and reject from a session that did not verify a TOTP code when the lender requires it, before any write", async () => {
    const { db, tx } = fakeDb(row({ makerId: "someone-else" }))
    const noTotp = { ...checker, totpVerified: false }
    await expect(approve({ ...scope, actor: noTotp }, db)).rejects.toMatchObject({ code: "TOTP_REQUIRED", status: 403 })
    await expect(reject({ ...scope, actor: noTotp, note: "x" }, db)).rejects.toMatchObject({ code: "TOTP_REQUIRED" })
    expect(tx.changeRequest.updateMany).not.toHaveBeenCalled()
  })

  it("does not ask for it where the lender has switched the requirement off", async () => {
    h.totpRequired = false
    const { db } = fakeDb(row({ makerId: "someone-else" }))
    expect((await approve({ ...scope, actor: { ...checker, totpVerified: false } }, db)).id).toBe("cr1")
  })
})

describe("stale approval", () => {
  it("records what the change was drafted against at submit", async () => {
    h.handler = handler({ baseRef: vi.fn(async () => "v7") })
    const { db, tx } = fakeDb(row({ status: "DRAFT" }))
    await submit({ ...scope, actor: maker }, db)
    expect(tx.changeRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ baseRef: "v7", status: "SUBMITTED" }) }))
  })

  it("refuses to approve (STALE, 409) when what it was drafted against has moved, and applies nothing", async () => {
    const apply = vi.fn()
    h.handler = handler({ baseRef: async () => "v8", apply })
    const { db } = fakeDb(row({ makerId: "someone-else", baseRef: "v7" }))
    await expect(approve({ ...scope, actor: checker }, db)).rejects.toMatchObject({ code: "STALE", status: 409 })
    expect(apply).not.toHaveBeenCalled()
  })

  it("approves when it has not moved, serialising approvals of the kind first", async () => {
    const apply = vi.fn()
    h.handler = handler({ baseRef: async () => "v7", apply })
    const { db, tx } = fakeDb(row({ makerId: "someone-else", baseRef: "v7" }))
    await approve({ ...scope, actor: checker }, db)
    expect(tx.$executeRaw).toHaveBeenCalled()
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it("refuses a request drafted under an older payload format", async () => {
    h.handler = handler({ payloadVersion: 2 })
    await expect(approve({ ...scope, actor: checker }, fakeDb(row({ makerId: "someone-else", payloadVersion: 1 })).db)).rejects.toMatchObject({ code: "STALE" })
  })

  it("a unique violation from apply (two approvals racing for one version number) is a clean 409", async () => {
    h.handler = handler({ apply: async () => { throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" }) } })
    await expect(approve({ ...scope, actor: checker }, fakeDb(row({ makerId: "someone-else" })).db)).rejects.toMatchObject({ code: "STALE", status: 409 })
  })

  it("a draft made under an older payload format cannot be submitted (STALE), and submit does not re-stamp its version", async () => {
    h.handler = handler({ payloadVersion: 2 })
    const { db, tx } = fakeDb(row({ status: "DRAFT", payloadVersion: 1 }))
    await expect(submit({ ...scope, actor: maker }, db)).rejects.toMatchObject({ code: "STALE", status: 409 })
    expect(tx.changeRequest.updateMany).not.toHaveBeenCalled()
    const ok = fakeDb(row({ status: "DRAFT", payloadVersion: 2 }))
    await submit({ ...scope, actor: maker }, ok.db)
    expect((ok.tx.changeRequest.updateMany.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data).not.toHaveProperty("payloadVersion")
  })

  it("editing a draft stamps the current payload format on it", async () => {
    h.handler = handler({ payloadVersion: 2 })
    const { db, tx } = fakeDb(row({ status: "DRAFT", payloadVersion: 1 }))
    await updateDraft({ ...scope, actor: maker, payload: { amount: 7 } }, db)
    expect((tx.changeRequest.updateMany.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data).toMatchObject({ payloadVersion: 2 })
  })
})
