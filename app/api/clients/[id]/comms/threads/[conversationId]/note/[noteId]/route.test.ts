/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const editMock = vi.fn()
const deleteMock = vi.fn()
const notifyMock = vi.fn()
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/inbox/note-mentions", () => ({ notifyNoteMentions: (a: unknown) => notifyMock(a) }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }) }))
vi.mock("@/lib/inbox/notes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inbox/notes")>()
  return {
    ...actual,
    editInternalNote: (a: unknown) => editMock(a),
    softDeleteInternalNote: (a: unknown) => deleteMock(a),
  }
})
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: { findFirst: vi.fn() },
    conversation: { findFirst: vi.fn() },
  },
}))

import { PATCH, DELETE } from "./route"
import { prisma } from "@/lib/prisma"

const ctx = { params: Promise.resolve({ id: "c1", conversationId: "cv1", noteId: "n1" }) }
const patchReq = (body: unknown) =>
  new NextRequest("http://x/api/clients/c1/comms/threads/cv1/note/n1", { method: "PATCH", body: JSON.stringify(body) })
const deleteReq = () =>
  new NextRequest("http://x/api/clients/c1/comms/threads/cv1/note/n1", { method: "DELETE" })

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "READONLY" } })
  vi.mocked(prisma.client.findFirst).mockResolvedValue({ id: "c1", contact: { id: "ct1" } } as any)
  vi.mocked(prisma.conversation.findFirst).mockResolvedValue({ id: "cv1" } as any)
})

it("short-circuits on guard failure", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
  const res = await PATCH(patchReq({ text: "x" }), ctx)
  expect(res.status).toBe(401)
  expect(editMock).not.toHaveBeenCalled()
})

it("400 on empty text", async () => {
  const res = await PATCH(patchReq({ text: "  " }), ctx)
  expect(res.status).toBe(400)
  expect(editMock).not.toHaveBeenCalled()
})

it("400 when the client has no contact record", async () => {
  vi.mocked(prisma.client.findFirst).mockResolvedValue({ id: "c1", contact: null } as any)
  const res = await PATCH(patchReq({ text: "x" }), ctx)
  expect(res.status).toBe(400)
  expect(editMock).not.toHaveBeenCalled()
})

// assertOwned proves the CONVERSATION belongs to this client's contact. It
// does NOT prove the NOTE belongs to that conversation — that's a separate
// guard, enforced by editInternalNote/softDeleteInternalNote via
// loadMutableNote's conversationId filter (see the "scopes the edit" test
// below and lib/inbox/notes.test.ts).
it("404 when the conversation does not belong to this client's contact", async () => {
  vi.mocked(prisma.conversation.findFirst).mockResolvedValue(null as any)
  const res = await PATCH(patchReq({ text: "x" }), ctx)
  expect(res.status).toBe(404)
  expect(editMock).not.toHaveBeenCalled()
  expect(vi.mocked(prisma.conversation.findFirst).mock.calls[0][0]).toEqual({
    where: { id: "cv1", tenantId: "t1", contactId: "ct1" },
    select: { id: true },
  })
})

it("403 when the actor is not the author", async () => {
  editMock.mockResolvedValue({ ok: false, reason: "NOT_AUTHOR" })
  const res = await PATCH(patchReq({ text: "x" }), ctx)
  expect(res.status).toBe(403)
})

it("409 on a second delete", async () => {
  deleteMock.mockResolvedValue({ ok: false, reason: "ALREADY_DELETED" })
  const res = await DELETE(deleteReq(), ctx)
  expect(res.status).toBe(409)
})

it("edits the note", async () => {
  editMock.mockResolvedValue({ ok: true, id: "n1" })
  const res = await PATCH(patchReq({ text: "corrected" }), ctx)
  expect(res.status).toBe(200)
  expect(editMock).toHaveBeenCalledWith({
    tenantId: "t1", conversationId: "cv1", noteId: "n1", actorUserId: "u1", actorEmail: "a@b.c", text: "corrected",
    mentionUserIds: undefined,
  })
})

// Without the body parse the service always sees undefined, the delta is
// always empty, and the fan-out below can never run.
it("forwards mentionUserIds on an edit and coerces a malformed body", async () => {
  editMock.mockResolvedValue({ ok: true, id: "n1", newMentionUserIds: [] })
  await PATCH(patchReq({ text: "@Bo now too", mentionUserIds: ["u2", 7, null] }), ctx)
  expect(editMock).toHaveBeenCalledWith(expect.objectContaining({ mentionUserIds: ["u2"] }))

  editMock.mockClear()
  await PATCH(patchReq({ text: "x", mentionUserIds: "u2" }), ctx)
  expect(editMock).toHaveBeenCalledWith(expect.objectContaining({ mentionUserIds: undefined }))
})

it("fans out to mentions newly added by an edit", async () => {
  editMock.mockResolvedValue({ ok: true, id: "n1", newMentionUserIds: ["u3"] })
  const res = await PATCH(patchReq({ text: "@Cy too", mentionUserIds: ["u2", "u3"] }), ctx)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, id: "n1" })
  expect(notifyMock).toHaveBeenCalledWith({
    tenantId: "t1", noteId: "n1", conversationId: "cv1",
    authorName: "a@b.c", text: "@Cy too", userIds: ["u3"],
  })
})

it("does not fan out when the edit added no new mentions", async () => {
  editMock.mockResolvedValue({ ok: true, id: "n1", newMentionUserIds: [] })
  await PATCH(patchReq({ text: "typo fixed" }), ctx)
  expect(notifyMock).not.toHaveBeenCalled()
})

// newMentionUserIds is readable on the failure branch of the intersection
// type, so the success check must come first or a rejected edit could notify.
it("does not fan out when the edit failed", async () => {
  editMock.mockResolvedValue({ ok: false, reason: "NOT_AUTHOR", newMentionUserIds: ["u3"] })
  const res = await PATCH(patchReq({ text: "x", mentionUserIds: ["u3"] }), ctx)
  expect(res.status).toBe(403)
  expect(notifyMock).not.toHaveBeenCalled()
})

it("deletes the note", async () => {
  deleteMock.mockResolvedValue({ ok: true, id: "n1" })
  const res = await DELETE(deleteReq(), ctx)
  expect(res.status).toBe(200)
  expect(deleteMock).toHaveBeenCalledWith({
    tenantId: "t1", conversationId: "cv1", noteId: "n1", actorUserId: "u1", actorEmail: "a@b.c",
  })
})

// assertOwned only proves the conversation belongs to this client; it says
// nothing about whether noteId is a note IN that conversation. Proves the
// route plumbs the URL's conversationId down to the guard that does check.
it("scopes the edit to the URL's conversation, so a note from another conversation 404s", async () => {
  editMock.mockResolvedValue({ ok: false, reason: "NOT_FOUND" })
  const res = await PATCH(patchReq({ text: "x" }), ctx)
  expect(res.status).toBe(404)
  expect(editMock).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "cv1", noteId: "n1" }))
})

it("scopes the delete to the URL's conversation, so a note from another conversation 404s", async () => {
  deleteMock.mockResolvedValue({ ok: false, reason: "NOT_FOUND" })
  const res = await DELETE(deleteReq(), ctx)
  expect(res.status).toBe(404)
  expect(deleteMock).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "cv1", noteId: "n1" }))
})
