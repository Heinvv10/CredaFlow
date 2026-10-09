/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireCommsAgentMock = vi.fn()
const editMock = vi.fn()
const deleteMock = vi.fn()
const notifyMock = vi.fn()
vi.mock("@/lib/inbox/authz", () => ({ requireCommsAgent: () => requireCommsAgentMock() }))
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

import { PATCH, DELETE } from "./route"
const ctx = { params: Promise.resolve({ id: "cv1", noteId: "n1" }) }
const patchReq = (body: unknown) =>
  new NextRequest("http://x/api/inbox/conversations/cv1/note/n1", { method: "PATCH", body: JSON.stringify(body) })
const deleteReq = () =>
  new NextRequest("http://x/api/inbox/conversations/cv1/note/n1", { method: "DELETE" })

beforeEach(() => {
  vi.clearAllMocks()
  requireCommsAgentMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "ADMIN" } })
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

it("404 when the id is not a note", async () => {
  editMock.mockResolvedValue({ ok: false, reason: "NOT_A_NOTE" })
  const res = await PATCH(patchReq({ text: "x" }), ctx)
  expect(res.status).toBe(404)
})

it("400 on empty text", async () => {
  const res = await PATCH(patchReq({ text: "  " }), ctx)
  expect(res.status).toBe(400)
  expect(editMock).not.toHaveBeenCalled()
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

// An edit can add a tag that was not in the original note. Without the body
// parse the service would always see undefined and the delta would always be
// empty, so the fan-out below would be unreachable.
it("forwards mentionUserIds on an edit and drops non-string members", async () => {
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

// The [id] segment IS the conversationId — it must reach editInternalNote /
// softDeleteInternalNote so a note id from a DIFFERENT conversation 404s
// there (loadMutableNote filters on conversationId), not just on author.
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
