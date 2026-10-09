import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { matchesQueue } from "@/lib/inbox/queue-membership"
import { nextSelection } from "./queue-selection"

const noteMock = vi.fn().mockResolvedValue({ id: "n1" })
const threadMock = vi.fn()
const listMock = vi.fn()
vi.mock("./api-client", async (importOriginal) => ({
  newestThreadReads: (await importOriginal<typeof import("./api-client")>()).newestThreadReads,
  inboxApi: {
    list: (q: string) => listMock(q),
    deltas: vi.fn().mockResolvedValue({ conversations: [], cursor: "c" }),
    thread: (id: string) => threadMock(id),
    note: (id: string, text: string, mentionUserIds: string[]) => noteMock(id, text, mentionUserIds),
  },
}))
// The three panels are mocked out: this file is about the handlers InboxClient
// hands down, not about what they render. ThreadView and QueuePanel keep their
// props so the callbacks can be invoked directly — reaching them through the
// real Composer/QueuePanel would re-test those, which have their own suites.
let queuePanelProps: Record<string, any> | null = null // eslint-disable-line @typescript-eslint/no-explicit-any
vi.mock("./QueuePanel", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  QueuePanel: (p: any) => { queuePanelProps = p; return null },
}))
vi.mock("./ContactPanel", () => ({ ContactPanel: () => null }))
let threadViewProps: Record<string, any> | null = null // eslint-disable-line @typescript-eslint/no-explicit-any
vi.mock("./ThreadView", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ThreadView: (p: any) => { threadViewProps = p; return null },
}))

import { InboxClient } from "./InboxClient"
import { ThreadView } from "./ThreadView"
import type { ConversationSummary } from "./types"

function conversation(overrides: Partial<ConversationSummary> & { id: string }): ConversationSummary {
  return {
    channel: "WHATSAPP",
    status: "OPEN",
    priority: "NORMAL",
    subject: null,
    assigneeId: null,
    assigneeName: null,
    contactId: "contact-1",
    contactName: "Test Contact",
    contactStatus: "ACTIVE",
    primaryPhone: null,
    primaryWaJid: null,
    lastMessagePreview: null,
    lastMessageAt: null,
    lastInboundAt: null,
    lastActivityAt: null,
    unreadCount: 0,
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  threadViewProps = null
  queuePanelProps = null
  noteMock.mockClear()
  listMock.mockReset()
  // Default: the queue's own list already contains cv1, so mention tests
  // below (which don't care about queue-membership races) mount cleanly.
  // Tests that specifically exercise the pin/clear race override this with
  // mockResolvedValueOnce per call.
  listMock.mockResolvedValue({ conversations: [{ id: "cv1" }], nextCursor: null })
  // Selecting a conversation is what mounts ThreadView; the shape doesn't
  // matter here because ThreadView is mocked.
  threadMock.mockResolvedValue({ conversation: { id: "cv1" }, messages: [] })
})

afterEach(() => {
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

async function renderClient(
  overrides: Partial<React.ComponentProps<typeof InboxClient>> = {},
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(
      <InboxClient
        currentUserId="u1"
        canReconcile={false}
        initialQueue="mine"
        // Not present in initialConversations by default: that leaves the
        // deep-link pin unset, so mounting doesn't drag matchesQueue in.
        initialSelectedId="cv1"
        initialConversations={[]}
        cannedReplies={[]}
        roster={[]}
        {...overrides}
      />,
    )
  })
  return renderer
}

async function mounted(): Promise<ReactTestRenderer> {
  return renderClient()
}

// The composer resolves who was tagged and hands the ids to onNote; InboxClient
// is the only thing that forwards them to the API. Nothing but tsc guarded that
// third argument, and dropping it silently ships a note that tags nobody.
it("forwards the mention ids from onNote through to inboxApi.note", async () => {
  const renderer = await mounted()
  expect(threadViewProps).not.toBeNull()

  await act(async () => {
    await threadViewProps!.onNote("cv1", "@Bo Nkosi please chase", ["u2", "u3"])
  })

  expect(noteMock).toHaveBeenCalledWith("cv1", "@Bo Nkosi please chase", ["u2", "u3"])
  await act(async () => renderer.unmount())
})

it("forwards an empty mention list rather than omitting it", async () => {
  const renderer = await mounted()

  await act(async () => {
    await threadViewProps!.onNote("cv1", "just a note", [])
  })

  expect(noteMock).toHaveBeenCalledWith("cv1", "just a note", [])
  await act(async () => renderer.unmount())
})

describe("queue switch clears a selection that left the list", () => {
  // The rule InboxClient.reloadList applies: after loading queue q, a
  // selectedId absent from the new list must be cleared. Covered here via
  // the real exported helper (./queue-selection.ts), not a local copy.
  it("keeps a selection that is present in the new queue", () => {
    expect(nextSelection([{ id: "a" }, { id: "b" }], "b")).toBe("b")
  })

  it("clears a selection that is absent from the new queue", () => {
    expect(nextSelection([{ id: "a" }], "b")).toBeNull()
  })

  it("is a no-op with nothing selected", () => {
    expect(nextSelection([{ id: "a" }], null)).toBeNull()
  })

  it("agrees with matchesQueue on a mine-tab miss", () => {
    const cv = { status: "OPEN", assigneeId: "someone-else" }
    expect(matchesQueue("mine", cv as any, "me")).toBe(false) // eslint-disable-line @typescript-eslint/no-explicit-any
  })

  // The unit-level helper above proves the rule in isolation; these two cover
  // it wired into the real component, including the pin re-add path that the
  // helper alone can't see (reloadList prepends a pinned conversation to
  // `next` BEFORE nextSelection runs — the pin has to land first, or a
  // deep-linked selection would be wrongly cleared the instant it's opened).
  it("keeps a pinned deep-link selection when the initial reload's list omits it", async () => {
    // page.tsx guarantees a deep-linked conversation is either already in
    // list.conversations or pinned into initialConversations (see its
    // getConversationSummary fallback) — so pinnedRef.current is populated
    // here, same as production. The mocked initial reload comes back WITHOUT
    // cv1, forcing reloadList's needsPin path to re-add it before the
    // selection-clearing pass runs.
    listMock.mockResolvedValueOnce({ conversations: [], nextCursor: null })

    const renderer = await renderClient({
      initialQueue: "mine",
      initialSelectedId: "cv1",
      initialConversations: [conversation({ id: "cv1", status: "OPEN", assigneeId: "u1" })],
    })

    expect(listMock).toHaveBeenCalledTimes(1)
    expect(renderer.root.findAllByType(ThreadView)).toHaveLength(1)
    expect(threadViewProps).not.toBeNull()

    await act(async () => renderer.unmount())
  })

  it("clears the selection when a queue switch's list genuinely omits it", async () => {
    // First call is the mount-time reload for the initial queue (contains
    // cv1, no pin needed). Second call is the switch to "all" — cv1 is gone
    // for a real reason (reassigned out of it, say), not a pin-timing
    // artifact, so this time the clear must actually happen.
    listMock
      .mockResolvedValueOnce({ conversations: [{ id: "cv1" }], nextCursor: null })
      .mockResolvedValueOnce({ conversations: [], nextCursor: null })

    const renderer = await renderClient({
      initialQueue: "mine",
      initialSelectedId: "cv1",
      initialConversations: [conversation({ id: "cv1" })],
    })

    expect(renderer.root.findAllByType(ThreadView)).toHaveLength(1)
    expect(queuePanelProps).not.toBeNull()

    await act(async () => {
      queuePanelProps!.onQueueChange("all")
    })

    expect(listMock).toHaveBeenCalledTimes(2)
    expect(renderer.root.findAllByType(ThreadView)).toHaveLength(0)

    await act(async () => renderer.unmount())
  })
})
