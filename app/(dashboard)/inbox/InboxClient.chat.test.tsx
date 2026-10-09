import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

// The real api-client runs here, over a stubbed fetch: what matters is the
// request InboxClient's onSend actually puts on the wire for a website chat.
vi.mock("./QueuePanel", () => ({ QueuePanel: () => null }))
vi.mock("./ContactPanel", () => ({ ContactPanel: () => null }))
let threadViewProps: Record<string, any> | null = null // eslint-disable-line @typescript-eslint/no-explicit-any
vi.mock("./ThreadView", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ThreadView: (p: any) => { threadViewProps = p; return null },
}))

import { InboxClient } from "./InboxClient"
import { ThreadView } from "./ThreadView"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const REPLY_URL = "/api/inbox/conversations/cv1/reply"
const ASSIGNMENT_URL = "/api/inbox/conversations/cv1/assignment"
let replyResponse: Record<string, unknown>
/** What the next assignment call answers, and what the queue's list holds from then on. */
let assignment: { status: number; body: Record<string, unknown> }
let listed: { id: string }[]
let channel: string
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  threadViewProps = null
  replyResponse = { ok: true, outcome: "sent" }
  assignment = { status: 200, body: { ok: true } }
  listed = [{ id: "cv1" }]
  channel = "CHATBOT"
  fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    if (url === ASSIGNMENT_URL) return { ok: assignment.status === 200, status: assignment.status, json: async () => assignment.body }
    const body = url === REPLY_URL
      ? replyResponse
      : url.startsWith("/api/inbox/conversations?")
        ? { conversations: listed, nextCursor: null }
        : init?.method === "PATCH" ? { ok: true } : { conversation: { id: "cv1", channel }, messages: [] }
    return { ok: true, status: 200, json: async () => body }
  })
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

async function mounted(canReleaseChats?: boolean): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(
      <InboxClient
        currentUserId="u1" canReconcile={false} canReleaseChats={canReleaseChats} initialQueue="mine" initialSelectedId="cv1"
        initialConversations={[]} cannedReplies={[]} roster={[]}
      />,
    )
  })
  return renderer
}

function replyCall() {
  return fetchMock.mock.calls.find(([url]) => url === REPLY_URL)!
}

it("posts a website-chat reply without a channel field", async () => {
  const renderer = await mounted()

  let accepted: boolean | undefined
  await act(async () => {
    accepted = await threadViewProps!.onSend("cv1", "Hello there", "op-1", "CHATBOT")
  })

  expect(JSON.parse(replyCall()[1].body)).toEqual({ text: "Hello there", operationId: "op-1" })
  expect(accepted).toBe(true)
  expect(threadViewProps!.fallback).toBeNull()
  await act(async () => renderer.unmount())
})

it("hands the server's reason for a refused chat reply to the composer banner", async () => {
  replyResponse = { ok: false, reason: "CHANNEL_DISABLED", detail: "Join the chat before replying." }
  const renderer = await mounted()

  let accepted: boolean | undefined
  await act(async () => {
    accepted = await threadViewProps!.onSend("cv1", "Hello there", "op-1", "CHATBOT")
  })

  expect(accepted).toBe(false)
  expect(threadViewProps!.fallback).toEqual({ reason: "CHANNEL_DISABLED", detail: "Join the chat before replying." })
  await act(async () => renderer.unmount())
})

const threadLoads = () => fetchMock.mock.calls.filter(([url, init]) => url === "/api/inbox/conversations/cv1" && !init).length

it.each([
  ["joining", (p: Record<string, any>) => p.onClaim()], // eslint-disable-line @typescript-eslint/no-explicit-any
  ["leaving or releasing", (p: Record<string, any>) => p.onRelease()], // eslint-disable-line @typescript-eslint/no-explicit-any
  ["a status change", (p: Record<string, any>) => p.onStatus("PENDING_CUSTOMER")], // eslint-disable-line @typescript-eslint/no-explicit-any
])("after %s the open thread stays in the pane though it left the queue's list", async (_name, action) => {
  const renderer = await mounted()
  expect(renderer.root.findAllByType(ThreadView)).toHaveLength(1)
  const loads = threadLoads()
  // The action moves the thread out of this queue: the reloaded list no longer holds it.
  listed = []
  await act(async () => { await action(threadViewProps!) })

  expect(renderer.root.findAllByType(ThreadView)).toHaveLength(1)
  expect(threadViewProps!.thread.conversation.id).toBe("cv1")
  expect(threadLoads()).toBeGreaterThan(loads)
  await act(async () => renderer.unmount())
})

it("a join someone else won is not silent: the banner says so and the thread is reloaded to show who holds it", async () => {
  const renderer = await mounted()
  const loads = threadLoads()
  assignment = { status: 409, body: { ok: false, reason: "ALREADY_CLAIMED" } }
  await act(async () => { await threadViewProps!.onClaim() })

  expect(threadViewProps!.fallback).toEqual({ reason: "CLAIM_REFUSED", detail: "Someone else has already joined this chat." })
  expect(threadLoads()).toBe(loads + 1)
  expect(renderer.root.findAllByType(ThreadView)).toHaveLength(1)
  await act(async () => renderer.unmount())
})

it("a join refused because the chat is gone or closed says that instead", async () => {
  const renderer = await mounted()
  assignment = { status: 409, body: { ok: false, reason: "NOT_FOUND" } }
  await act(async () => { await threadViewProps!.onClaim() })
  expect(threadViewProps!.fallback).toEqual({ reason: "CLAIM_REFUSED", detail: "This chat can no longer be joined." })
  await act(async () => renderer.unmount())
})

it("a join that succeeds leaves no banner, and clears one left by an earlier refusal", async () => {
  const renderer = await mounted()
  assignment = { status: 409, body: { ok: false, reason: "ALREADY_CLAIMED" } }
  await act(async () => { await threadViewProps!.onClaim() })
  assignment = { status: 200, body: { ok: true } }
  await act(async () => { await threadViewProps!.onClaim() })
  expect(threadViewProps!.fallback).toBeNull()
  await act(async () => renderer.unmount())
})

it("a refused claim on any other channel keeps its existing behaviour: no chat wording in the banner", async () => {
  channel = "WHATSAPP"
  const renderer = await mounted()
  assignment = { status: 409, body: { ok: false, reason: "ALREADY_CLAIMED" } }
  await act(async () => { await threadViewProps!.onClaim() })
  expect(threadViewProps!.fallback).toBeNull()
  await act(async () => renderer.unmount())
})

it.each([[true, true], [false, false], [undefined, undefined]])("hands the admin's release permission (%s) down to the thread header", async (given, seen) => {
  const renderer = await mounted(given)
  expect(threadViewProps!.canReleaseChats).toBe(seen)
  await act(async () => renderer.unmount())
})
