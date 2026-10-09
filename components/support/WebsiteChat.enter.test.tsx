import { WebsiteIdentityProvider } from "@/components/website/WebsiteIdentity"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/components/turnstile-widget", () => ({
  TurnstileWidget: ({ onToken }: { onToken: (t: string) => void }) => {
    useEffect(() => {
      onToken("tok")
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return null
  },
}))

import { WebsiteChat } from "./WebsiteChat"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
type Route = "start" | "message" | "poll"
type Reply = { status: number; body: unknown }
const jsonResponse = ({ status, body }: Reply) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body })

describe("WebsiteChat: Enter sends", () => {
  let renderer!: ReactTestRenderer
  let fetchMock: ReturnType<typeof vi.fn>
  let message: () => Promise<ReturnType<typeof jsonResponse>>

  beforeEach(async () => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    message = async () => jsonResponse({ status: 200, body: { reply: "We are NCR registered.", handedOff: false, mode: "bot" } })
    const answers: Record<Exclude<Route, "message">, Reply> = {
      start: { status: 200, body: { token: "sess", greeting: "Hi Thabo, welcome.", ref: "WC-ABC234" } },
      poll: { status: 200, body: { mode: "bot", staffName: null, ref: "WC-ABC234", lines: [{ id: "m1", from: "assistant", text: "Hi Thabo, welcome." }] } },
    }
    fetchMock = vi.fn(async (url: string) => {
      const route = url.replace("/api/website/chat/", "") as Route
      if (route === "message") return message()
      if (!answers[route]) throw new Error(`unexpected fetch ${url}`)
      return jsonResponse(answers[route])
    })
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("document", { hidden: false, addEventListener: () => {}, removeEventListener: () => {} })
    await act(async () => {
      renderer = create(<WebsiteIdentityProvider identity={ACME_LENDER}><WebsiteChat whatsappE164="+27110000000" onClose={vi.fn()} /></WebsiteIdentityProvider>)
    })
    await act(async () => {
      for (const [name, value] of [["name", "Thabo Mokoena"], ["phone", "0821234567"], ["email", "thabo@example.com"]]) {
        renderer.root.findByProps({ name }).props.onChange({ target: { value } })
      }
      renderer.root.findByProps({ name: "consent" }).props.onChange({ target: { checked: true } })
    })
    await act(async () => {
      await renderer.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() })
    })
  })

  afterEach(async () => {
    await act(async () => renderer.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  const box = () => renderer.root.findByType("textarea")
  const sent = () => fetchMock.mock.calls.filter(([url]) => url === "/api/website/chat/message").map(([, init]) => JSON.parse((init as { body: string }).body).text)
  async function type(value: string) {
    await act(async () => box().props.onChange({ target: { value } }))
  }
  async function press(key: { shiftKey?: boolean; isComposing?: boolean; keyCode?: number } = {}) {
    const preventDefault = vi.fn()
    await act(async () => {
      await box().props.onKeyDown({ key: "Enter", shiftKey: key.shiftKey ?? false, keyCode: key.keyCode ?? 13, nativeEvent: { isComposing: key.isComposing ?? false }, preventDefault })
    })
    return preventDefault
  }

  it("Enter sends the message and clears the box, like Send", async () => {
    await type("Are you registered?")
    expect((await press())).toHaveBeenCalled()
    expect(sent()).toEqual(["Are you registered?"])
    expect(box().props.value).toBe("")
  })
  it("Shift+Enter does not send, and leaves the newline to the textarea", async () => {
    await type("line one")
    expect(await press({ shiftKey: true })).not.toHaveBeenCalled()
    expect(sent()).toEqual([])
    expect(box().props.value).toBe("line one")
  })
  it.each([["an empty", ""], ["a whitespace-only", "  \n "]])("Enter with %s draft does not send", async (_n, value) => {
    await type(value)
    await press()
    expect(sent()).toEqual([])
    expect(box().props.value).toBe(value)
  })
  it.each([["isComposing", { isComposing: true }], ["keyCode 229", { keyCode: 229 }]])("Enter during an IME composition (%s) does nothing special", async (_n, key) => {
    await type("こんにちは")
    expect(await press(key)).not.toHaveBeenCalled()
    expect(sent()).toEqual([])
    expect(box().props.value).toBe("こんにちは")
  })
  it("Enter while a message is still sending does not send again", async () => {
    let finish!: () => void
    message = () => new Promise((done) => { finish = () => done(jsonResponse({ status: 200, body: { reply: "ok", handedOff: false, mode: "bot" } })) })
    await type("first")
    await act(async () => { void box().props.onKeyDown({ key: "Enter", shiftKey: false, keyCode: 13, nativeEvent: { isComposing: false }, preventDefault: vi.fn() }) })
    await type("second")
    await press()
    expect(sent()).toEqual(["first"])
    // Not sent and not lost: the box keeps what the visitor typed.
    expect(box().props.value).toBe("second")
    await act(async () => finish())
  })
})
