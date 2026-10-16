import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const listMock = vi.fn()
const threadMock = vi.fn()
vi.mock("./api-client", async (importOriginal) => ({
  newestThreadReads: (await importOriginal<typeof import("./api-client")>()).newestThreadReads,
  inboxApi: {
    list: (q: string) => listMock(q),
    deltas: vi.fn().mockResolvedValue({ conversations: [], cursor: "c" }),
    thread: (id: string) => threadMock(id),
  },
}))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let queuePanelProps: Record<string, any> | null = null
vi.mock("./QueuePanel", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  QueuePanel: (p: any) => { queuePanelProps = p; return null },
}))
vi.mock("./ContactPanel", () => ({ ContactPanel: () => null }))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let threadViewProps: Record<string, any> | null = null
vi.mock("./ThreadView", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ThreadView: (p: any) => { threadViewProps = p; return null },
}))

import { InboxClient } from "./InboxClient"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

let renderer: ReactTestRenderer

function summary(id: string) {
  return { id, unreadCount: 0 }
}

async function mount(props: Partial<React.ComponentProps<typeof InboxClient>> = {}) {
  await act(async () => {
    renderer = create(
      <InboxClient
        currentUserId="u1"
        canReconcile={false}
        initialQueue="mine"
        initialConversations={[]}
        cannedReplies={[]}
        roster={[]}
        {...props}
      />,
    )
  })
}

function listedIds(): string[] {
  return (queuePanelProps!.conversations as Array<{ id: string }>).map((c) => c.id)
}

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  queuePanelProps = null
  threadViewProps = null
  listMock.mockReset()
  threadMock.mockReset()
  threadMock.mockResolvedValue({ conversation: { id: "cv1" }, messages: [] })
})

afterEach(() => {
  act(() => renderer.unmount())
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("InboxClient queue loading", () => {
  it("shows the loading state until the first list lands, then the list", async () => {
    let resolveList!: (v: unknown) => void
    listMock.mockReturnValue(new Promise((resolve) => { resolveList = resolve }))
    await mount()
    expect(queuePanelProps!.loading).toBe(true)

    await act(async () => { resolveList({ conversations: [summary("a")], nextCursor: null }) })
    expect(queuePanelProps!.loading).toBe(false)
    expect(listedIds()).toEqual(["a"])
  })

  it("loads the chosen queue on a switch and shows loading meanwhile", async () => {
    listMock.mockResolvedValueOnce({ conversations: [summary("a")], nextCursor: null })
    await mount()

    let resolveOpen!: (v: unknown) => void
    listMock.mockReturnValueOnce(new Promise((resolve) => { resolveOpen = resolve }))
    await act(async () => { queuePanelProps!.onQueueChange("unassigned") })
    expect(listMock).toHaveBeenLastCalledWith("unassigned")
    expect(queuePanelProps!.loading).toBe(true)

    await act(async () => { resolveOpen({ conversations: [summary("b")], nextCursor: null }) })
    expect(queuePanelProps!.loading).toBe(false)
    expect(listedIds()).toEqual(["b"])
  })

  it("drops a slow list for the queue the agent has already left", async () => {
    let resolveMine!: (v: unknown) => void
    listMock.mockReturnValueOnce(new Promise((resolve) => { resolveMine = resolve }))
    await mount()
    listMock.mockResolvedValueOnce({ conversations: [summary("b")], nextCursor: null })
    await act(async () => { queuePanelProps!.onQueueChange("unassigned") })

    await act(async () => { resolveMine({ conversations: [summary("a")], nextCursor: null }) })
    expect(listedIds()).toEqual(["b"])
    expect(queuePanelProps!.loading).toBe(false)
  })

  it("keeps a deep-linked thread selected and loads it", async () => {
    listMock.mockResolvedValue({ conversations: [summary("cv1")], nextCursor: null })
    await mount({ initialSelectedId: "cv1" })
    expect(queuePanelProps!.selectedId).toBe("cv1")
    expect(threadMock).toHaveBeenCalledWith("cv1")
    expect(threadViewProps).not.toBeNull()
  })

  it("drops a deep-linked selection the loaded queue does not hold", async () => {
    listMock.mockResolvedValue({ conversations: [summary("other")], nextCursor: null })
    await mount({ initialSelectedId: "cv1" })
    expect(queuePanelProps!.selectedId).toBeNull()
  })
})
