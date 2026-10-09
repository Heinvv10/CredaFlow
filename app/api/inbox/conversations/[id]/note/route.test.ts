/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireCommsAgentMock = vi.fn()
const addNoteMock = vi.fn()
const notifyMock = vi.fn()
vi.mock("@/lib/inbox/authz", () => ({ requireCommsAgent: () => requireCommsAgentMock() }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }) }))
vi.mock("@/lib/inbox/notes", () => ({ addInternalNote: (a: unknown) => addNoteMock(a) }))
vi.mock("@/lib/inbox/note-mentions", () => ({ notifyNoteMentions: (a: unknown) => notifyMock(a) }))

import { POST } from "./route"
const ctx = { params: Promise.resolve({ id: "cv1" }) }
const req = (body: unknown) => new NextRequest("http://x/api/inbox/conversations/cv1/note", { method: "POST", body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  requireCommsAgentMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "ADMIN" } })
})

it("400 on empty note", async () => {
  const res = await POST(req({ text: "" }), ctx)
  expect(res.status).toBe(400)
})

it("creates an internal note", async () => {
  addNoteMock.mockResolvedValue({ id: "n1", newMentionUserIds: [] })
  const res = await POST(req({ text: "careful" }), ctx)
  expect(res.status).toBe(200)
  expect(addNoteMock).toHaveBeenCalledWith({ tenantId: "t1", conversationId: "cv1", authorUserId: "u1", authorEmail: "a@b.c", text: "careful", mentionUserIds: undefined })
})

it("forwards mentionUserIds to the service", async () => {
  addNoteMock.mockResolvedValue({ id: "n1", newMentionUserIds: ["u2"] })
  const res = await POST(req({ text: "@Bo look", mentionUserIds: ["u2"] }), ctx)
  expect(res.status).toBe(200)
  expect(addNoteMock).toHaveBeenCalledWith(expect.objectContaining({ mentionUserIds: ["u2"] }))
})

// A JSON body can carry anything. Non-strings are dropped and a non-array
// becomes undefined, so nothing reaches Prisma as `{ in: [null] }`.
it("coerces a malformed mentionUserIds body", async () => {
  addNoteMock.mockResolvedValue({ id: "n1", newMentionUserIds: [] })
  await POST(req({ text: "x", mentionUserIds: ["u2", 7, null, { id: "u3" }] }), ctx)
  expect(addNoteMock).toHaveBeenCalledWith(expect.objectContaining({ mentionUserIds: ["u2"] }))

  addNoteMock.mockClear()
  await POST(req({ text: "x", mentionUserIds: "u2" }), ctx)
  expect(addNoteMock).toHaveBeenCalledWith(expect.objectContaining({ mentionUserIds: undefined }))
})

// newMentionUserIds is the notification fan-out's input, not the browser's: a
// caller must not be able to enumerate who got notified by POSTing ids.
it("does not leak newMentionUserIds to the caller", async () => {
  addNoteMock.mockResolvedValue({ id: "n1", newMentionUserIds: ["u2", "u3"] })
  const res = await POST(req({ text: "@Bo", mentionUserIds: ["u2", "u3"] }), ctx)
  expect(await res.json()).toEqual({ id: "n1" })
})

// The [id] segment IS the conversationId here — the fan-out's deep link is
// resolved from it, so passing the wrong one would mail a link to the wrong
// thread.
it("fans out to the newly mentioned users", async () => {
  addNoteMock.mockResolvedValue({ id: "n1", newMentionUserIds: ["u2"] })
  await POST(req({ text: "@Bo look", mentionUserIds: ["u2"] }), ctx)
  expect(notifyMock).toHaveBeenCalledWith({
    tenantId: "t1", noteId: "n1", conversationId: "cv1",
    authorName: "a@b.c", text: "@Bo look", userIds: ["u2"],
  })
})

it("prefers the author's name over the email when set", async () => {
  requireCommsAgentMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", name: "Ana", role: "ADMIN" } })
  addNoteMock.mockResolvedValue({ id: "n1", newMentionUserIds: ["u2"] })
  await POST(req({ text: "@Bo", mentionUserIds: ["u2"] }), ctx)
  expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ authorName: "Ana" }))
})

it("does not fan out when nobody new was mentioned", async () => {
  addNoteMock.mockResolvedValue({ id: "n1", newMentionUserIds: [] })
  await POST(req({ text: "careful" }), ctx)
  expect(notifyMock).not.toHaveBeenCalled()
})

it("short-circuits on guard failure without calling addInternalNote", async () => {
  const { NextResponse } = await import("next/server")
  requireCommsAgentMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
  const res = await POST(req({ text: "careful" }), ctx)
  expect(res.status).toBe(403)
  expect(addNoteMock).not.toHaveBeenCalled()
})

it("404s when the conversation isn't found (cross-tenant or missing)", async () => {
  addNoteMock.mockResolvedValue(null)
  const res = await POST(req({ text: "careful" }), ctx)
  expect(res.status).toBe(404)
})
