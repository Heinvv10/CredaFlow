import { describe, expect, it, vi } from "vitest"
import { ChangeRequestError } from "./errors"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))
import { approve, createDraft, reject, submit, updateDraft, withdraw } from "./service"

const maker = { id: "u-maker", email: "m@x.invalid", role: "ADMIN" }
const checker = { id: "u-checker", email: "c@x.invalid", role: "ADMIN" }
const officer = { id: "u-off", email: "o@x.invalid", role: "CREDIT_OFFICER" }
const row = (over: Record<string, unknown> = {}) => ({ id: "cr1", tenantId: "t", kind: "DECISION_RULE_SET", status: "SUBMITTED", makerId: "u-maker", payload: {}, ...over })

/** A db whose transaction hands the callback a tx that finds `found` and records writes. */
function fakeDb(found: unknown, count = 1) {
  const tx = {
    changeRequest: { findFirst: vi.fn(async () => found), updateMany: vi.fn(async () => ({ count })), create: vi.fn() },
    auditLog: { create: vi.fn() },
  }
  const db = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)), changeRequest: tx.changeRequest }
  return { db: db as never, tx }
}
const scope = { tenantId: "t", id: "cr1" }

describe("maker-checker service (state and permission checks; the database rules are in the integration suite)", () => {
  it("refuses an unknown kind before touching the database", async () => {
    const { db, tx } = fakeDb(null)
    await expect(createDraft({ tenantId: "t", actor: maker, kind: "NOPE", title: "t", payload: {} }, db)).rejects.toMatchObject({ code: "UNKNOWN_KIND" })
    expect(tx.changeRequest.create).not.toHaveBeenCalled()
  })

  it("refuses a user without the kind's permission", async () => {
    const { db } = fakeDb(row())
    await expect(createDraft({ tenantId: "t", actor: officer, kind: "DECISION_RULE_SET", title: "t", payload: {} }, db)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(approve({ ...scope, actor: officer }, fakeDb(row()).db)).rejects.toMatchObject({ code: "FORBIDDEN" })
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
    await expect(updateDraft({ ...scope, actor: { ...checker, role: "ADMIN" }, title: "x" }, db)).rejects.toMatchObject({ code: "NOT_MAKER" })
    await expect(submit({ ...scope, actor: checker }, db)).rejects.toMatchObject({ code: "NOT_MAKER" })
    await expect(withdraw({ ...scope, actor: checker }, db)).rejects.toMatchObject({ code: "NOT_MAKER" })
  })

  it("rejecting needs a reason", async () => {
    await expect(reject({ ...scope, actor: checker, note: "   " }, fakeDb(row()).db)).rejects.toBeInstanceOf(ChangeRequestError)
  })
})
