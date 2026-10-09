import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SendWhatsAppModal } from "./SendWhatsAppModal"

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

function props(overrides: Partial<Parameters<typeof SendWhatsAppModal>[0]> = {}) {
  return {
    clientId: "client-a",
    clientName: "Synthetic Client",
    phone: "0821234567",
    isOpen: true,
    onClose: vi.fn(),
    onSent: vi.fn(),
    ...overrides,
  }
}

function sendButton(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType("button").find((button) => {
    const children = Array.isArray(button.props.children)
      ? button.props.children
      : [button.props.children]
    return children.some((child: unknown) => child === "Send")
  })!
}

describe("SendWhatsAppModal request isolation", () => {
  let operationSequence = 0

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    operationSequence = 0
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

  it("does not let an old success timer close a newly reopened same-client modal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, messageId: "message-1" }),
    })))
    const onClose = vi.fn()
    const onSent = vi.fn()
    const openProps = props({ onClose, onSent })
    let renderer!: ReactTestRenderer

    await act(async () => { renderer = create(<SendWhatsAppModal {...openProps} />) })
    await act(async () => { await sendButton(renderer).props.onClick() })

    // The parent closes and reopens the mounted modal before the 1.5 second
    // success callback from the previous open generation fires.
    await act(async () => {
      renderer.update(<SendWhatsAppModal {...openProps} isOpen={false} />)
    })
    await act(async () => {
      renderer.update(<SendWhatsAppModal {...openProps} isOpen />)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_600) })

    expect(onSent).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(renderer.toJSON()).not.toBeNull()
    await act(async () => renderer.unmount())
  })

  it("ignores an in-flight response from a prior same-client open generation", async () => {
    let resolveFetch!: (value: {
      ok: boolean
      json: () => Promise<{ ok: boolean; messageId: string }>
    }) => void
    const response = new Promise<{
      ok: boolean
      json: () => Promise<{ ok: boolean; messageId: string }>
    }>((resolve) => {
      resolveFetch = resolve
    })
    vi.stubGlobal("fetch", vi.fn(() => response))
    const onClose = vi.fn()
    const onSent = vi.fn()
    const openProps = props({ onClose, onSent })
    let renderer!: ReactTestRenderer

    await act(async () => { renderer = create(<SendWhatsAppModal {...openProps} />) })
    let sendPromise!: Promise<void>
    await act(async () => {
      sendPromise = sendButton(renderer).props.onClick()
      await Promise.resolve()
    })
    await act(async () => {
      renderer.update(<SendWhatsAppModal {...openProps} isOpen={false} />)
    })
    await act(async () => {
      renderer.update(<SendWhatsAppModal {...openProps} isOpen />)
    })
    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({ ok: true, messageId: "stale-message" }),
      })
      await sendPromise
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_600) })

    expect(onSent).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(renderer.toJSON()).not.toBeNull()
    await act(async () => renderer.unmount())
  })

  it("clears the pending callback on unmount", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, messageId: "message-1" }),
    })))
    const onClose = vi.fn()
    const onSent = vi.fn()
    let renderer!: ReactTestRenderer

    await act(async () => {
      renderer = create(<SendWhatsAppModal {...props({ onClose, onSent })} />)
    })
    await act(async () => { await sendButton(renderer).props.onClick() })
    await act(async () => renderer.unmount())
    await act(async () => { await vi.advanceTimersByTimeAsync(1_600) })

    expect(onSent).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it.each([
    "network rejection",
    "HTTP 409",
    "pending",
    "simulated",
    "reconciliation",
  ] as const)("preserves one operation id across close/reopen after %s", async (outcome) => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => {
      if (outcome === "network rejection") throw new Error("connection lost")
      if (outcome === "HTTP 409") {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: "Operation is already being reconciled" }),
        }
      }
      if (outcome === "pending") {
        return {
          ok: true,
          status: 202,
          json: async () => ({ ok: true, messageId: "message-1", pending: true }),
        }
      }
      if (outcome === "simulated") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, messageId: "message-1", simulated: true }),
        }
      }
      return {
        ok: true,
        status: 202,
        json: async () => ({ ok: true, messageId: "message-1", reconciliationRequired: true }),
      }
    })
    vi.stubGlobal("fetch", fetchMock)
    const openProps = props()
    let renderer!: ReactTestRenderer

    await act(async () => { renderer = create(<SendWhatsAppModal {...openProps} />) })
    await act(async () => { await sendButton(renderer).props.onClick() })
    await act(async () => {
      renderer.update(<SendWhatsAppModal {...openProps} isOpen={false} />)
    })
    await act(async () => {
      renderer.update(<SendWhatsAppModal {...openProps} isOpen />)
    })
    await act(async () => {
      renderer.root.findByType("select").props.onChange({ target: { value: "dpd_3" } })
    })
    await act(async () => { await sendButton(renderer).props.onClick() })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const operationIds = fetchMock.mock.calls.map(([, init]) => (
      JSON.parse(String(init?.body)).operationId
    ))
    expect(operationIds).toEqual(
      outcome === "simulated"
        ? ["operation-1", "operation-2"]
        : ["operation-1", "operation-1"],
    )
    expect(crypto.randomUUID).toHaveBeenCalledTimes(outcome === "simulated" ? 2 : 1)
    await act(async () => renderer.unmount())
  })

  it("the 1-day-overdue prefill warns of default interest and charges, not late fees", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) => ({
      ok: true,
      json: async () => ({ ok: true, messageId: "message-1" }),
    }))
    vi.stubGlobal("fetch", fetchMock)
    let renderer!: ReactTestRenderer

    await act(async () => { renderer = create(<SendWhatsAppModal {...props({ defaultDpdBucket: "dpd_1" })} />) })
    await act(async () => { await sendButton(renderer).props.onClick() })

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body).message as string
    expect(sent).toBe(
      "Hi Synthetic Client, your payment was due yesterday. Please pay immediately to avoid further default interest and charges. Contact us if you're experiencing difficulty.",
    )
    await act(async () => renderer.unmount())
  })
})
