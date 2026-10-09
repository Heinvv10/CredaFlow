import { afterEach, expect, it, vi } from "vitest"
import { inboxApi } from "./api-client"

afterEach(() => { vi.unstubAllGlobals() })

function stubFetch() {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "n1" }) })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

// The composer resolves who to ping and hands the ids down; if this layer drops
// them the note still saves and the UI looks correct, but nobody is ever
// notified — a silent failure with no other test in the suite able to see it.
it("forwards mentionUserIds in the note POST body", async () => {
  const fetchMock = stubFetch()

  await inboxApi.note("cv1", "please chase @Bo Nkosi", ["u2"])

  expect(fetchMock).toHaveBeenCalledWith("/api/inbox/conversations/cv1/note", {
    method: "POST",
    body: JSON.stringify({ text: "please chase @Bo Nkosi", mentionUserIds: ["u2"] }),
  })
})

// Same silent failure one layer later: the edit box now resolves mentions too,
// and a PATCH that drops them saves the reworded note while notifying nobody.
it("forwards mentionUserIds in the note edit PATCH body", async () => {
  const fetchMock = stubFetch()

  await inboxApi.editNote("cv1", "n1", "please chase @Bo Nkosi", ["u2"])

  expect(fetchMock).toHaveBeenCalledWith("/api/inbox/conversations/cv1/note/n1", {
    method: "PATCH",
    body: JSON.stringify({ text: "please chase @Bo Nkosi", mentionUserIds: ["u2"] }),
  })
})

it("still patches an explicit empty list for an edit that tags nobody", async () => {
  const fetchMock = stubFetch()

  await inboxApi.editNote("cv1", "n1", "chased twice", [])

  expect(fetchMock.mock.calls[0][1].body).toBe(
    JSON.stringify({ text: "chased twice", mentionUserIds: [] }),
  )
})

it("still posts an explicit empty list for an untagged note", async () => {
  const fetchMock = stubFetch()

  await inboxApi.note("cv1", "chased twice", [])

  expect(fetchMock.mock.calls[0][1].body).toBe(
    JSON.stringify({ text: "chased twice", mentionUserIds: [] }),
  )
})

// The reply route's schema accepts WHATSAPP, EMAIL or no channel at all: a
// website-chat reply that names its channel is refused with a 400.
it("posts a website-chat reply with no channel key", async () => {
  const fetchMock = stubFetch()

  await inboxApi.reply("cv1", "Hello there", "op-1", "CHATBOT")

  expect(fetchMock).toHaveBeenCalledWith("/api/inbox/conversations/cv1/reply", {
    method: "POST",
    body: JSON.stringify({ text: "Hello there", operationId: "op-1" }),
  })
})

it("still names the channel on a WhatsApp or email reply", async () => {
  const fetchMock = stubFetch()

  await inboxApi.reply("cv1", "Hello there", "op-1", "EMAIL")

  expect(fetchMock.mock.calls[0][1].body).toBe(
    JSON.stringify({ text: "Hello there", operationId: "op-1", channel: "EMAIL" }),
  )
})
