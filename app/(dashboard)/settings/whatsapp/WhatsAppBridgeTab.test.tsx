import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WaBridgeSlot } from "@/lib/whatsapp-bridge-admin"
import { WhatsAppBridgeTab } from "./WhatsAppBridgeTab"

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((button) => {
    const children = Array.isArray(button.props.children) ? button.props.children : [button.props.children]
    return children.some((child: unknown) => child === label)
  })!
}

function findInput(renderer: ReactTestRenderer, placeholder: string) {
  return renderer.root.findAllByType("input").find((input) => input.props.placeholder === placeholder)!
}

describe("WhatsAppBridgeTab pairing panel vs background poll failures", () => {
  let renderer: ReactTestRenderer

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    // No jsdom in this suite (vitest.config.ts environment is "node"), so the
    // component's document.visibilityState / addEventListener calls need a
    // minimal stub. "visible" throughout — visibility gating has its own
    // requirement and isn't what this regression covers.
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  })

  afterEach(async () => {
    await act(async () => renderer?.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  // Regression: numbers === null used to hit an unconditional early return
  // that replaced the ENTIRE tab -- including the pairing code panel -- with
  // the "unreachable" banner. An operator has ~2.5 minutes to enter that code
  // on their phone; a background poll flipping to unreachable on a transient
  // bridge blip must not take the code off screen with it, or the fix that
  // was supposed to make pairing feel responsive makes it actively worse.
  it("keeps the pairing code on screen after consecutive background poll failures", async () => {
    let getCalls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET"
        if (method === "POST") {
          return {
            ok: true,
            json: async () => ({ slotId: "slot-1", pairingCode: "123-456", expiresAt: "2026-08-04T10:05:00.000Z" }),
          }
        }
        getCalls += 1
        if (getCalls === 1) {
          // The refresh() that runs immediately after addNumber() succeeds.
          const slots: WaBridgeSlot[] = [{
            slotId: "slot-1", number: null, status: "CONNECTING", priority: 1,
            connectedAt: null, disconnectedAt: null, lastDisconnectReason: null,
          }]
          return { ok: true, json: async () => ({ numbers: slots }) }
        }
        // Both subsequent background polls fail.
        return { ok: false, json: async () => ({ error: "bridge unreachable" }) }
      }),
    )

    await act(async () => {
      renderer = create(<WhatsAppBridgeTab initial={[]} />)
    })

    const input = findInput(renderer, "27821234567")
    await act(async () => { input.props.onChange({ target: { value: "27821234567" } }) })

    const addButton = findButton(renderer, "Add number")
    await act(async () => { await addButton.props.onClick() })

    expect(JSON.stringify(renderer.toJSON())).toContain("123-456")

    // A CONNECTING slot plus an active pairing panel means the poll runs on
    // the fast (3s) interval. Two consecutive failures cross
    // POLL_FAILURES_BEFORE_UNREACHABLE and flip numbers to null.
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })

    const json = JSON.stringify(renderer.toJSON())
    expect(json).toContain("Could not reach the WhatsApp bridge")
    expect(json).toContain("123-456")
  })

  // Adding a NEW number must stay a UI action — the whole point of the pool is
  // that numbers can be added without an ops task. The bridge refuses an
  // unrecognised number ONCE with NUMBER_NOT_REGISTERED; the operator ticks a
  // confirmation and it goes through. Without this, the cross-environment
  // guard would make every new number an .env edit plus a bridge restart.
  it("shows a confirmation for an unrecognised number, then adds it once confirmed", async () => {
    const posts: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "POST") {
          const sent = JSON.parse(String(init?.body ?? "{}"))
          posts.push(sent)
          if (sent.confirmNew !== true) {
            return {
              ok: false,
              json: async () => ({
                error: "27831234567 is not yet registered to this bridge.",
                code: "NUMBER_NOT_REGISTERED",
              }),
            }
          }
          return {
            ok: true,
            json: async () => ({ slotId: "slot-9", pairingCode: "999-888", expiresAt: "2026-08-04T10:05:00.000Z" }),
          }
        }
        return { ok: true, json: async () => ({ numbers: [] }) }
      }),
    )

    await act(async () => {
      renderer = create(<WhatsAppBridgeTab initial={[]} />)
    })

    await act(async () => {
      findInput(renderer, "27821234567").props.onChange({ target: { value: "27831234567" } })
    })
    await act(async () => {
      findButton(renderer, "Add number").props.onClick()
    })

    // First attempt: refused, and the confirmation appears.
    expect(posts[0]).toMatchObject({ number: "27831234567", confirmNew: false })
    const checkbox = renderer.root.findAllByType("input").find((i) => i.props.type === "checkbox")
    expect(checkbox, "an unrecognised number must offer a confirmation, not a dead end").toBeTruthy()
    expect(findButton(renderer, "Add number").props.disabled).toBe(true)

    // Confirm, then retry.
    await act(async () => checkbox!.props.onChange({ target: { checked: true } }))
    expect(findButton(renderer, "Add number").props.disabled).toBe(false)
    await act(async () => {
      findButton(renderer, "Add number").props.onClick()
    })

    expect(posts[1]).toMatchObject({ number: "27831234567", confirmNew: true })
    expect(JSON.stringify(renderer.toJSON())).toContain("999-888")
  })

  // A revoked session cannot be "reconnected" — the credentials are dead. The
  // manual path was Retire then Add, which leaves the pool empty if the
  // operator stops after the first step, and asks for a new-number
  // confirmation that is meaningless for a number the bridge already owns.
  it("offers Re-link (not Promote) for a logged-out slot and shows the new pairing code", async () => {
    const calls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "POST") {
          calls.push(String(url))
          return {
            ok: true,
            json: async () => ({ slotId: "slot-new", pairingCode: "777-666", expiresAt: "2026-08-05T00:05:00.000Z" }),
          }
        }
        return { ok: true, json: async () => ({ numbers: [] }) }
      }),
    )

    const loggedOut: WaBridgeSlot[] = [{
      slotId: "slot-dead", number: "27820000201", status: "LOGGED_OUT", priority: 1,
      connectedAt: null, disconnectedAt: null, lastDisconnectReason: "LOGGED_OUT",
    }]
    await act(async () => {
      renderer = create(<WhatsAppBridgeTab initial={loggedOut} />)
    })

    // Promote is meaningless for a dead session and must not be the offer.
    expect(findButton(renderer, "Promote"), "a revoked session cannot be promoted").toBeUndefined()

    await act(async () => {
      findButton(renderer, "Re-link").props.onClick()
    })

    expect(calls[0]).toContain("/numbers/slot-dead/relink")
    expect(JSON.stringify(renderer.toJSON())).toContain("777-666")
  })

  // Pause vs Retire is the distinction that matters: Retire logs the number
  // out (recovery needs a pairing code and the phone), Pause keeps the
  // session so Resume is instant. The UI must not blur them.
  it("offers Pause on a live slot and Resume on a parked one, never Retire's confirm", async () => {
    const posts: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "POST") {
          posts.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) })
          return { ok: true, json: async () => ({ ok: true }) }
        }
        return { ok: true, json: async () => ({ numbers: [] }) }
      }),
    )

    const live: WaBridgeSlot[] = [{
      slotId: "slot-live", number: "27820000201", status: "CONNECTED", priority: 0,
      connectedAt: null, disconnectedAt: null, lastDisconnectReason: null,
    }]
    await act(async () => {
      renderer = create(<WhatsAppBridgeTab initial={live} />)
    })
    await act(async () => findButton(renderer, "Pause").props.onClick())
    expect(posts[0].url).toContain("/numbers/slot-live/pause")
    expect(posts[0].body).toEqual({ paused: true })

    // A parked slot offers Resume — and NOT Pause. `initial` only seeds
    // useState, so this needs a fresh render rather than a prop update.
    const parked: WaBridgeSlot[] = [{ ...live[0], status: "PAUSED" }]
    await act(async () => renderer.unmount())
    await act(async () => {
      renderer = create(<WhatsAppBridgeTab initial={parked} />)
    })
    expect(findButton(renderer, "Resume")).toBeTruthy()
    expect(findButton(renderer, "Pause"), "a parked slot cannot be paused again").toBeUndefined()

    await act(async () => findButton(renderer, "Resume").props.onClick())
    expect(posts[1].body).toEqual({ paused: false })
  })
})
