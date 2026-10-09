/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    notification: {},
    conversation: { findFirst: vi.fn() },
    user: { findMany: vi.fn() },
  },
}))
const createNotificationMock = vi.fn()
const sendEmailMock = vi.fn()
vi.mock("@/lib/notifications/bell", () => ({ createNotification: (a: unknown, c: unknown) => createNotificationMock(a, c) }))
vi.mock("@/lib/email/service", () => ({ sendEmail: (o: unknown) => sendEmailMock(o) }))

import { notifyNoteMentions } from "./note-mentions"
import { prisma } from "@/lib/prisma"

const base = {
  tenantId: "t1", noteId: "n1", conversationId: "cv1",
  authorName: "Ana", text: "please chase this today", userIds: ["u2"],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("NEXTAUTH_URL", "https://app.lender.example")
  vi.mocked(prisma.conversation.findFirst).mockResolvedValue({ contact: { clientId: "c1" } } as any)
  vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: "u2", name: "Bo", email: "bo@x.co" }] as any)
  createNotificationMock.mockResolvedValue({ id: "nt1" })
  sendEmailMock.mockResolvedValue({ ok: true })
})

it("deep-links to the client page when the thread has one", async () => {
  await notifyNoteMentions(base)
  expect(createNotificationMock.mock.calls[0][0]).toEqual(expect.objectContaining({
    tenantId: "t1", userId: "u2", type: "COMMS_MENTION",
    entityType: "Client", entityId: "c1",
  }))
})

it("falls back to the conversation when the thread has no client", async () => {
  vi.mocked(prisma.conversation.findFirst).mockResolvedValue({ contact: { clientId: null } } as any)
  await notifyNoteMentions(base)
  expect(createNotificationMock.mock.calls[0][0]).toEqual(expect.objectContaining({
    entityType: "Conversation", entityId: "cv1",
  }))
})

// A bounced mention must not fail a note that is already written. Note that
// since the fan-out became concurrent this is guaranteed by allSettled plus the
// outer catch, NOT by the per-recipient email catch — see below.
it("does not throw when the email fails", async () => {
  sendEmailMock.mockRejectedValue(new Error("smtp down"))
  await expect(notifyNoteMentions(base)).resolves.toBeUndefined()
  expect(createNotificationMock).toHaveBeenCalled()
})

// The email catch is the LAST statement in each recipient's callback, so under
// allSettled it no longer buys isolation: delete it and the callback merely
// rejects, allSettled absorbs it, and every other recipient is unaffected. What
// it still buys is this log — the only trace a bounced mention leaves, and the
// only thing naming WHICH recipient it was. That is what is pinned here.
it("logs which recipient's mention email failed", async () => {
  const err = new Error("smtp down")
  sendEmailMock.mockRejectedValue(err)
  const spy = vi.spyOn(console, "error").mockImplementation(() => {})
  try {
    await notifyNoteMentions(base)
    expect(spy).toHaveBeenCalledWith("Failed to email mention:", { noteId: "n1", userId: "u2" }, err)
  } finally {
    spy.mockRestore()
  }
})

// Recipients now run concurrently, so "the second person was still called" no
// longer proves anything: with allSettled the other recipient's promise is
// already in flight and survives whether or not the failure was caught. What
// the per-recipient catch actually buys is that the SAME recipient's email
// still goes out after their bell write threw — that is what is asserted.
it("still emails the person whose own bell write threw, and everyone else", async () => {
  vi.mocked(prisma.user.findMany).mockResolvedValue([
    { id: "u2", name: "Bo", email: "bo@x.co" },
    { id: "u3", name: "Cy", email: "cy@x.co" },
  ] as any)
  createNotificationMock.mockRejectedValueOnce(new Error("db blip"))
  await notifyNoteMentions({ ...base, userIds: ["u2", "u3"] })
  expect(createNotificationMock).toHaveBeenCalledTimes(2)
  expect(sendEmailMock.mock.calls.map((c) => c[0].to).sort()).toEqual(["bo@x.co", "cy@x.co"])
})

// The other half of per-recipient isolation: a bad address must not cost the
// rest of the list their bell OR their mail.
it("still notifies the rest of the list when one address rejects", async () => {
  vi.mocked(prisma.user.findMany).mockResolvedValue([
    { id: "u2", name: "Bo", email: "bo@x.co" },
    { id: "u3", name: "Cy", email: "cy@x.co" },
  ] as any)
  sendEmailMock.mockRejectedValueOnce(new Error("550 no such mailbox"))
  await notifyNoteMentions({ ...base, userIds: ["u2", "u3"] })
  expect(createNotificationMock).toHaveBeenCalledTimes(2)
  expect(sendEmailMock).toHaveBeenCalledTimes(2)
})

// The point of the fan-out change: five recipients must cost roughly one SMTP
// round trip, not five. Sequential code cannot satisfy this — each send only
// settles once the next has already started.
it("fans the recipients out concurrently rather than one round trip at a time", async () => {
  vi.mocked(prisma.user.findMany).mockResolvedValue(
    ["u2", "u3", "u4"].map((id) => ({ id, name: id, email: `${id}@x.co` })) as any,
  )
  let inFlight = 0
  let peak = 0
  const release: (() => void)[] = []
  sendEmailMock.mockImplementation(() => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    return new Promise<void>((resolve) => release.push(() => { inFlight -= 1; resolve() }))
  })

  const pending = notifyNoteMentions({ ...base, userIds: ["u2", "u3", "u4"] })
  // Let every recipient's bell write settle and its send start.
  await new Promise((r) => setImmediate(r))

  // Asserted BEFORE the sends are released: a sequential implementation only
  // ever has one release fn, so `await pending` would never resolve and the
  // test would fail by hanging instead of on this line.
  expect(peak).toBe(3)

  release.forEach((fn) => fn())
  await pending
})

// The never-throws contract has to cover the lookups too, not just the
// per-recipient sends: the note is committed before this runs, and every
// caller awaits it inside the request that would otherwise 500.
it("does not throw when the recipient lookup fails", async () => {
  vi.mocked(prisma.user.findMany).mockRejectedValue(new Error("db down"))
  await expect(notifyNoteMentions(base)).resolves.toBeUndefined()
})

it("does not throw when the conversation lookup fails", async () => {
  vi.mocked(prisma.conversation.findFirst).mockRejectedValue(new Error("db down"))
  await expect(notifyNoteMentions(base)).resolves.toBeUndefined()
  expect(createNotificationMock).not.toHaveBeenCalled()
})

it("does nothing for an empty list", async () => {
  await notifyNoteMentions({ ...base, userIds: [] })
  expect(prisma.user.findMany).not.toHaveBeenCalled()
  expect(createNotificationMock).not.toHaveBeenCalled()
})

// Only the tenant-checked list from resolveMentions may be mailed. The query
// is the boundary that stops a widened id list reaching a real inbox. `active`
// is not redundant with resolveMentions' own filter: a staffer deactivated
// between the resolve and this fan-out would otherwise still be emailed.
it("looks recipients up scoped to the tenant, active users, and the passed id list", async () => {
  await notifyNoteMentions({ ...base, userIds: ["u2", "u3"] })
  expect(vi.mocked(prisma.user.findMany).mock.calls[0][0]).toEqual({
    where: { tenantId: "t1", active: true, id: { in: ["u2", "u3"] } },
    select: { id: true, name: true, email: true },
  })
})

// The shape assertion above pins the clause; this pins the OUTCOME against a
// mock that honours it, so dropping `active` mails a deactivated account here
// rather than only failing on a shape mismatch.
it("does not email a user deactivated between the resolve and the fan-out", async () => {
  const users = [
    { id: "u2", tenantId: "t1", active: true, name: "Bo", email: "bo@x.co" },
    { id: "u3", tenantId: "t1", active: false, name: "Cy", email: "cy@x.co" },
  ]
  vi.mocked(prisma.user.findMany).mockImplementation((async (args: any) => {
    const w = args.where ?? {}
    return users
      .filter((u) => w.tenantId === undefined || u.tenantId === w.tenantId)
      .filter((u) => w.active === undefined || u.active === w.active)
      .filter((u) => w.id?.in === undefined || w.id.in.includes(u.id))
  }) as any)
  await notifyNoteMentions({ ...base, userIds: ["u2", "u3"] })
  expect(sendEmailMock.mock.calls.map((c) => c[0].to)).toEqual(["bo@x.co"])
})

it("emails the recipient with an absolute deep link", async () => {
  await notifyNoteMentions(base)
  const opts = sendEmailMock.mock.calls[0][0]
  expect(opts).toEqual(expect.objectContaining({
    tenantId: "t1", to: "bo@x.co", toName: "Bo",
    subject: "Ana mentioned you in a note",
    category: "comms_note_mention", referenceId: "n1",
  }))
  // Relative in a mail body is a dead link — there is no page to resolve it.
  expect(opts.html).toContain("https://app.lender.example/clients/c1?tab=comms")
  expect(opts.text).toContain("https://app.lender.example/clients/c1?tab=comms")
})

// The note text is staff-authored free text and this is the one place it
// reaches an HTML mail body. Raw markup there would render as markup.
it("escapes the note text and the author name in the html part", async () => {
  await notifyNoteMentions({
    ...base,
    authorName: "Ana <ana@x.co>",
    text: "<script>alert(1)</script> chase R&D",
  })
  const opts = sendEmailMock.mock.calls[0][0]
  expect(opts.html).not.toContain("<script>")
  expect(opts.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
  expect(opts.html).toContain("chase R&amp;D")
  expect(opts.html).not.toContain("Ana <ana@x.co>")
  expect(opts.html).toContain("Ana &lt;ana@x.co&gt;")
  // The plain-text part carries the note exactly as it was written.
  expect(opts.text).toContain("<script>alert(1)</script> chase R&D")
})

// User.name is staff-controlled and this is the only interpolation that reaches
// a mail header. Nodemailer strips CR/LF today, so this is defence in depth —
// but the subject must never carry a line break out of this function.
it("strips line breaks from the author name before it reaches the subject", async () => {
  await notifyNoteMentions({ ...base, authorName: "Ana\r\nBcc: leak@evil.co" })
  const opts = sendEmailMock.mock.calls[0][0]
  expect(opts.subject).toBe("Ana Bcc: leak@evil.co mentioned you in a note")
  expect(opts.subject).not.toMatch(/[\r\n]/)
})

// A subject is not HTML. Escaping it would put "&amp;" in people's inboxes.
it("does not html-escape the author name in the subject", async () => {
  await notifyNoteMentions({ ...base, authorName: "Ana & Bo" })
  expect(sendEmailMock.mock.calls[0][0].subject).toBe("Ana & Bo mentioned you in a note")
})

// The plain-text part is already faithful; without pre-line the html part
// collapsed a multi-line note into one run-on line.
// <br>, not white-space: pre-line — Outlook 2007+ renders through Word, which
// ignores white-space, so pre-line collapsed the note there.
it("preserves line breaks in the html part as <br>", async () => {
  await notifyNoteMentions({ ...base, text: "line one\nline two\nline three" })
  const opts = sendEmailMock.mock.calls[0][0]
  expect(opts.html).toContain("<blockquote>line one<br>line two<br>line three</blockquote>")
  // Exactly one per newline: a stray extra would double-space the quote, and a
  // leftover pre-line style alongside them would too.
  expect(opts.html.match(/<br>/g)).toHaveLength(2)
  expect(opts.html).not.toContain("white-space")
  expect(opts.text).toContain("line one\nline two\nline three")
})

// The <br> goes in AFTER escaping, so a note that itself contains "<br>" must
// still render as literal text — this is what makes the injection safe.
it("does not let the note's own markup survive the line-break substitution", async () => {
  await notifyNoteMentions({ ...base, text: "a<br>b\nreal break" })
  const opts = sendEmailMock.mock.calls[0][0]
  expect(opts.html).toContain("a&lt;br&gt;b<br>real break")
  expect(opts.html.match(/<br>/g)).toHaveLength(1)
})
