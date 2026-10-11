import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

// After Send the composer cleared but the reply showed only seconds later, though the
// server had stored it. The 4s poll's thread read, sent before the reply was stored, could land
// after the read that followed the send and put the thread back as it was.
vi.mock("./QueuePanel", () => ({ QueuePanel: () => null }))
vi.mock("./ContactPanel", () => ({ ContactPanel: () => null }))
let threadViewProps: Record<string, any> | null = null // eslint-disable-line @typescript-eslint/no-explicit-any
vi.mock("./ThreadView", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ThreadView: (p: any) => { threadViewProps = p; return null },
}))

import { InboxClient } from "./InboxClient"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
type Thread = { conversation: { id: string; channel: string }; messages: { id: string }[] }
let channel: string
/** Answers the thread reads in order; one left pending stays in flight until it is resolved. */
let threadReads: Array<() => Promise<Thread>>
let renderer: ReactTestRenderer

const thread = (...ids: string[]): Thread => ({ conversation: { id: "cv1", channel }, messages: ids.map((id) => ({ id })) })
const respond = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const shownIds = () => (threadViewProps!.thread as Thread).messages.map((m) => m.id)

/** The next thread read waits until the returned function is called with what it answers. */
function holdNextRead(): (t: Thread) => Promise<void> {
  let release!: (t: Thread) => void
  threadReads.push(() => new Promise<Thread>((resolve) => { release = resolve }))
  return (t) => act(async () => { release(t) })
}

beforeEach(async () => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  threadViewProps = null
  channel = "CHATBOT"
  threadReads = []
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
    if (url.startsWith("/api/inbox/conversations?")) return respond({ conversations: [{ id: "cv1" }], nextCursor: null })
    if (url.startsWith("/api/inbox/deltas")) return respond({ conversations: [], cursor: "c1" })
    if (url === "/api/inbox/conversations/cv1/reply") return respond({ ok: true, outcome: "sent" })
    if (url === "/api/inbox/conversations/cv1/note") return respond({ id: "n1" })
    if (url === "/api/inbox/conversations/cv1" && !init) return respond(await (threadReads.shift() ?? (async () => thread()))())
    throw new Error(`unexpected fetch ${url}`)
  }))
})

afterEach(async () => {
  await act(async () => renderer.unmount())
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

async function mount() {
  await act(async () => {
    renderer = create(
      <InboxClient
        currentUserId="u1" canReconcile={false} initialQueue="mine" initialSelectedId="cv1"
        initialConversations={[]} cannedReplies={[]} roster={[]}
      />,
    )
  })
}

it.each(["CHATBOT", "WHATSAPP", "EMAIL"])("%s: the sent reply is on screen when Send resolves, and a stale poll read cannot take it away", async (c) => {
  channel = c
  await mount()
  expect(shownIds()).toEqual([])

  // The poll's read goes out before the reply is stored, and is slow to come back.
  const pollRead = holdNextRead()
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })

  threadReads.push(async () => thread("r1"))
  let accepted: boolean | undefined
  await act(async () => { accepted = await threadViewProps!.onSend("cv1", "Hello there", "op-1", c) })
  expect(accepted).toBe(true)
  expect(shownIds()).toEqual(["r1"])

  await pollRead(thread())
  expect(shownIds()).toEqual(["r1"])
})

it("a poll read sent after the send's read is still applied: polling keeps the thread current", async () => {
  await mount()
  threadReads.push(async () => thread("r1"))
  await act(async () => { await threadViewProps!.onSend("cv1", "Hello there", "op-1", "CHATBOT") })
  threadReads.push(async () => thread("r1", "v2"))
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  expect(shownIds()).toEqual(["r1", "v2"])
})

it("of two overlapping reads, the newer one wins even when it lands first", async () => {
  await mount()
  const older = holdNextRead()
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  threadReads.push(async () => thread("n1"))
  await act(async () => { await threadViewProps!.onNote("cv1", "a note", []) })
  expect(shownIds()).toEqual(["n1"])
  await older(thread())
  expect(shownIds()).toEqual(["n1"])
})
