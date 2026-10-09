import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MessageClientDrawer, type MessageClientDrawerProps } from "./MessageClientDrawer"

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}))

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

type FetchResponse = { ok: boolean; status?: number; json: () => Promise<unknown> }

function response(body: unknown, ok = true): FetchResponse {
  return { ok, status: ok ? 200 : 500, json: async () => body }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const availability = {
  EMAIL: { enabled: false, reason: "disabled for test" },
  WHATSAPP: { enabled: false, reason: "disabled for test" },
  SMS: { enabled: true },
}

function drawerProps(overrides: Partial<MessageClientDrawerProps> = {}): MessageClientDrawerProps {
  return {
    open: true,
    onClose: vi.fn(),
    clientId: "client-a",
    clientName: "Synthetic Client A",
    cannedReplies: [],
    apiBase: "/api/clients/client-a",
    ...overrides,
  }
}

function sendButton(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType("button").find((button) => button.props.children === "Send")!
}

function smsButton(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType("button").find((button) => (
    button.findAllByType("p").some((paragraph) => paragraph.props.children === "SMS")
  ))!
}

function renderedText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON())
}

describe("MessageClientDrawer request isolation", () => {
  let operationSequence = 0

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    operationSequence = 0
    refresh.mockReset()
    vi.useFakeTimers()
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => `operation-${++operationSequence}`),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it("treats an immediate sent response as terminal and never starts a status poll", async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/channel-availability")) return response(availability)
      if (input.endsWith("/messages") && init?.method === "POST") {
        return response({ messageId: "message-a", outcome: "sent", status: "SENT" })
      }
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<MessageClientDrawer {...drawerProps()} />) })
    await act(async () => {
      renderer.root.findByType("textarea").props.onChange({ target: { value: "Hello" } })
    })
    await act(async () => { await sendButton(renderer).props.onClick() })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })

    expect(renderedText(renderer)).toContain("Sent. Appears in the Inbox.")
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/messages/")).length).toBe(0)
    expect(refresh).toHaveBeenCalledOnce()
    await act(async () => renderer.unmount())
  })

  it.each([
    "network rejection",
    "HTTP 409",
    "pending",
    "simulated",
    "reconciliation",
  ] as const)("preserves one operation id after close/reopen and same-channel click for %s", async (outcome) => {
    let postCount = 0
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/channel-availability")) return response(availability)
      if (input.endsWith("/messages/message-a")) {
        return response({ status: "FAILED_PERMANENT" })
      }
      if (input.endsWith("/messages") && init?.method === "POST") {
        postCount += 1
        if (postCount > 1) {
          return response({ messageId: "message-b", outcome: "simulated", status: "SIMULATED" })
        }
        if (outcome === "network rejection") throw new Error("connection lost")
        if (outcome === "HTTP 409") {
          return {
            ok: false,
            status: 409,
            json: async () => ({ error: "Operation is already being reconciled" }),
          }
        }
        if (outcome === "pending") {
          return response({ messageId: "message-a", outcome: "pending", status: "QUEUED" })
        }
        if (outcome === "simulated") {
          return response({ messageId: "message-a", outcome: "simulated", status: "SIMULATED" })
        }
        return response({
          messageId: "message-a",
          outcome: "pending",
          status: "QUEUED",
          reconciliationRequired: true,
        })
      }
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal("fetch", fetchMock)
    const stableProps = drawerProps()
    let renderer!: ReactTestRenderer

    await act(async () => { renderer = create(<MessageClientDrawer {...stableProps} />) })
    await act(async () => {
      renderer.root.findByType("textarea").props.onChange({ target: { value: "Protected payload" } })
    })
    await act(async () => { await sendButton(renderer).props.onClick() })
    await act(async () => {
      renderer.update(<MessageClientDrawer {...stableProps} open={false} />)
    })
    await act(async () => {
      renderer.update(<MessageClientDrawer {...stableProps} open />)
      await Promise.resolve()
    })

    if (outcome === "pending") {
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
      expect(renderedText(renderer)).toContain("Failed. Appears in the Inbox.")
    }

    await act(async () => {
      renderer.root.findByType("textarea").props.onChange({ target: { value: "Protected payload edited" } })
    })
    await act(async () => { smsButton(renderer).props.onClick() })
    await act(async () => { await sendButton(renderer).props.onClick() })

    const postOperationIds = fetchMock.mock.calls
      .filter(([input, init]) => String(input).endsWith("/messages") && init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)).operationId)
    expect(postOperationIds).toEqual(
      outcome === "simulated"
        ? ["operation-1", "operation-2"]
        : ["operation-1", "operation-1"],
    )
    expect(operationSequence).toBe(outcome === "simulated" ? 2 : 1)
    await act(async () => renderer.unmount())
  })

  it("ignores a stale poll after edit while retaining the protected operation key", async () => {
    const stalePoll = deferred<FetchResponse>()
    let postCount = 0
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input.endsWith("/channel-availability")) return Promise.resolve(response(availability))
      if (input.endsWith("/messages") && init?.method === "POST") {
        postCount += 1
        if (postCount === 1) {
          return Promise.resolve(response({ messageId: "message-a", outcome: "pending", status: "QUEUED" }))
        }
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({ error: "The idempotency key is already reserved for a different message request" }),
        })
      }
      if (input.endsWith("/messages/message-a")) return stalePoll.promise
      throw new Error(`Unexpected fetch: ${input}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<MessageClientDrawer {...drawerProps()} />) })
    await act(async () => {
      renderer.root.findByType("textarea").props.onChange({ target: { value: "First payload" } })
    })
    await act(async () => { await sendButton(renderer).props.onClick() })
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })

    await act(async () => {
      renderer.root.findByType("textarea").props.onChange({ target: { value: "Replacement payload" } })
    })
    await act(async () => {
      stalePoll.resolve(response({ status: "FAILED_PERMANENT" }))
      await stalePoll.promise
    })

    expect(renderedText(renderer)).not.toContain("Failed. Appears in the Inbox.")
    expect(sendButton(renderer).props.disabled).toBe(false)

    await act(async () => { await sendButton(renderer).props.onClick() })
    expect(renderedText(renderer)).toContain("already reserved for a different message request")
    expect(postCount).toBe(2)
    const operationIds = fetchMock.mock.calls
      .filter(([input, init]) => String(input).endsWith("/messages") && init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)).operationId)
    expect(operationIds).toEqual(["operation-1", "operation-1"])
    expect(operationSequence).toBe(1)
    await act(async () => renderer.unmount())
  })

  it("does not attach a file that finishes reading after the drawer target changes", async () => {
    let completeRead: (() => void) | null = null
    class DeferredFileReader {
      result: string | null = null
      error: Error | null = null
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      readAsDataURL = vi.fn()
      constructor() {
        completeRead = () => {
          this.result = "data:application/pdf;base64,cGRm"
          this.onload?.()
        }
      }
    }
    vi.stubGlobal("FileReader", DeferredFileReader)
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input.endsWith("/channel-availability")) return response({
        EMAIL: { enabled: true },
        WHATSAPP: { enabled: false },
        SMS: { enabled: false },
      })
      throw new Error(`Unexpected fetch: ${input}`)
    }))

    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<MessageClientDrawer {...drawerProps()} />) })
    const fileInput = renderer.root.findByProps({ type: "file" })
    await act(async () => {
      void fileInput.props.onChange({
        target: {
          files: [{ name: "stale.pdf", type: "application/pdf", size: 3 }],
          value: "stale.pdf",
        },
      })
    })

    await act(async () => {
      renderer.update(<MessageClientDrawer {...drawerProps({
        clientId: "client-b",
        clientName: "Synthetic Client B",
        apiBase: "/api/clients/client-b",
      })} />)
    })
    await act(async () => {
      if (!completeRead) throw new Error("FileReader was not created")
      completeRead()
      await Promise.resolve()
    })

    expect(renderedText(renderer)).not.toContain("stale.pdf")
    await act(async () => renderer.unmount())
  })
})
