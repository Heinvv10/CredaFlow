/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const addNoteMock = vi.fn()
const notifyMock = vi.fn()
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }) }))
vi.mock("@/lib/inbox/notes", () => ({ addInternalNote: (a: unknown) => addNoteMock(a) }))
vi.mock("@/lib/inbox/note-mentions", () => ({ notifyNoteMentions: (a: unknown) => notifyMock(a) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: { findFirst: vi.fn() },
    conversation: { findFirst: vi.fn() },
  },
}))

import { POST } from "./route"
import { prisma } from "@/lib/prisma"

const ctx = { params: Promise.resolve({ id: "c1", conversationId: "cv1" }) }
const req = (body: unknown) =>
  new NextRequest("http://x/api/clients/c1/comms/threads/cv1/note", { method: "POST", body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "READONLY" } })
  vi.mocked(prisma.client.findFirst).mockResolvedValue({ id: "c1", contact: { id: "ct1" } } as any)
  vi.mocked(prisma.conversation.findFirst).mockResolvedValue({ id: "cv1" } as any)
  addNoteMock.mockResolvedValue({ id: "n1", newMentionUserIds: [] })
})

it("400 on empty note", async () => {
  const res = await POST(req({ text: "   " }), ctx)
  expect(res.status).toBe(400)
  expect(addNoteMock).not.toHaveBeenCalled()
})

it("short-circuits on guard failure", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
  const res = await POST(req({ text: "careful" }), ctx)
  expect(res.status).toBe(401)
  expect(addNoteMock).not.toHaveBeenCalled()
})

it("400 when the client has no contact record", async () => {
  vi.mocked(prisma.client.findFirst).mockResolvedValue({ id: "c1", contact: null } as any)
  const res = await POST(req({ text: "careful" }), ctx)
  expect(res.status).toBe(400)
  expect(addNoteMock).not.toHaveBeenCalled()
})

// Ownership, not merely existence: a conversation belonging to a DIFFERENT
// client's contact must not accept a note through this client's URL.
it("404 when the conversation does not belong to this client's contact", async () => {
  vi.mocked(prisma.conversation.findFirst).mockResolvedValue(null as any)
  const res = await POST(req({ text: "careful" }), ctx)
  expect(res.status).toBe(404)
  expect(addNoteMock).not.toHaveBeenCalled()
  expect(vi.mocked(prisma.conversation.findFirst).mock.calls[0][0]).toEqual({
    where: { id: "cv1", tenantId: "t1", contactId: "ct1" },
    select: { id: true },
  })
})

it("creates the note", async () => {
  const res = await POST(req({ text: "careful" }), ctx)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ id: "n1" })
  expect(addNoteMock).toHaveBeenCalledWith({
    tenantId: "t1", conversationId: "cv1", authorUserId: "u1", authorEmail: "a@b.c", text: "careful",
    mentionUserIds: undefined,
  })
})

it("forwards mentionUserIds and drops non-string members", async () => {
  await POST(req({ text: "@Bo look", mentionUserIds: ["u2", 7] }), ctx)
  expect(addNoteMock).toHaveBeenCalledWith(expect.objectContaining({ mentionUserIds: ["u2"] }))
})

// A non-array must become undefined, not reach Prisma as `{ in: [null] }`.
// Covered in the sibling /inbox suite too — a regression in the shared inline
// coercion has to fail in both places, not only there.
it("coerces a non-array mentionUserIds to undefined", async () => {
  await POST(req({ text: "x", mentionUserIds: "u2" }), ctx)
  // toStrictEqual, not objectContaining({ mentionUserIds: undefined }): the
  // loose form also passes when the key is ABSENT, so it could not tell a
  // coercion from a caller that simply dropped the field.
  expect(addNoteMock.mock.calls[0][0]).toStrictEqual({
    tenantId: "t1", conversationId: "cv1", authorUserId: "u1", authorEmail: "a@b.c", text: "x",
    mentionUserIds: undefined,
  })
})

it("fans out to the newly mentioned users", async () => {
  addNoteMock.mockResolvedValue({ id: "n1", newMentionUserIds: ["u2"] })
  await POST(req({ text: "@Bo look", mentionUserIds: ["u2"] }), ctx)
  expect(notifyMock).toHaveBeenCalledWith({
    tenantId: "t1", noteId: "n1", conversationId: "cv1",
    authorName: "a@b.c", text: "@Bo look", userIds: ["u2"],
  })
})

it("does not fan out when nobody new was mentioned", async () => {
  await POST(req({ text: "careful" }), ctx)
  expect(notifyMock).not.toHaveBeenCalled()
})

// newMentionUserIds feeds the notification fan-out server-side; the browser
// gets only the id, so who was notified is not enumerable by POSTing ids.
it("does not leak newMentionUserIds to the caller", async () => {
  addNoteMock.mockResolvedValue({ id: "n1", newMentionUserIds: ["u2"] })
  const res = await POST(req({ text: "@Bo", mentionUserIds: ["u2"] }), ctx)
  expect(await res.json()).toEqual({ id: "n1" })
})
