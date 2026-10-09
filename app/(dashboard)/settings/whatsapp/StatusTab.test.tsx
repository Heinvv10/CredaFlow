import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StatusTab, type ChannelSettings } from "./StatusTab"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const SERVER_ON_SETTINGS_OFF =
  "WhatsApp is enabled on the server but switched off in settings — inbound capture and agent replies are blocked."
const SETTINGS_ON_SERVER_OFF = "WhatsApp is switched on in settings but not enabled on the server — sends are blocked."

let renderer: ReactTestRenderer
let fetchMock: ReturnType<typeof vi.fn>

function channel(overrides: Partial<ChannelSettings> = {}): ChannelSettings {
  return { whatsappEnabled: true, botsEnabled: true, waProvider: "WA_BRIDGE", chatAlertEmail: null, ...overrides }
}

function render(waEnabled: boolean, initial: ChannelSettings) {
  act(() => {
    renderer = create(
      <StatusTab waEnabled={waEnabled} waSenderUrl="https://wa.example" providers={["WA_BRIDGE", "WA_CLOUD"]} initial={initial} />,
    )
  })
  return renderer
}

/** Radix renders several nested nodes; the switches are the ones wired to a handler. */
function switches() {
  return renderer.root.findAll(
    (n) => typeof (n.props as { onCheckedChange?: unknown }).onCheckedChange === "function",
    { deep: true },
  )
}

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  fetchMock = vi.fn().mockResolvedValue({ ok: true })
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  act(() => renderer?.unmount())
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

// WA_ENABLED (server env) and commsSettings.whatsappEnabled (database) are
// two independent kill-switches. Either one being off blocks every send, and
// until now no screen said so — an operator flipped the switch they could see
// and reasonably believed WhatsApp was live.
describe("the two kill-switches disagreeing", () => {
  it("says sends are blocked when the server is on and settings are off", () => {
    const json = JSON.stringify(render(true, channel({ whatsappEnabled: false })).toJSON())
    expect(json).toContain(SERVER_ON_SETTINGS_OFF)
    expect(json).not.toContain(SETTINGS_ON_SERVER_OFF)
  })

  it("says sends are blocked when settings are on and the server is off", () => {
    const json = JSON.stringify(render(false, channel({ whatsappEnabled: true })).toJSON())
    expect(json).toContain(SETTINGS_ON_SERVER_OFF)
    expect(json).not.toContain(SERVER_ON_SETTINGS_OFF)
  })

  it("stays silent when both are on", () => {
    const json = JSON.stringify(render(true, channel({ whatsappEnabled: true })).toJSON())
    expect(json).not.toContain("sends are blocked")
  })

  it("stays silent when both are off", () => {
    const json = JSON.stringify(render(false, channel({ whatsappEnabled: false })).toJSON())
    expect(json).not.toContain("sends are blocked")
  })

  it("re-reads the disagreement from the switch the operator just moved", async () => {
    render(true, channel({ whatsappEnabled: false }))
    await act(async () => { await switches()[0].props.onCheckedChange(true) })
    expect(JSON.stringify(renderer.toJSON())).not.toContain("sends are blocked")
  })
})

describe("writing channel settings", () => {
  // A full-object PUT would silently rewrite fields another admin changed
  // between page load and this click. The writer is a partial patch and must
  // stay one.
  it("PUTs only the key that changed", async () => {
    render(true, channel({ whatsappEnabled: true }))
    await act(async () => { await switches()[0].props.onCheckedChange(false) })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/inbox/settings")
    expect(init.method).toBe("PUT")
    expect(JSON.parse(init.body)).toEqual({ whatsappEnabled: false })
  })

  it("reports a rejected save instead of leaving the operator to assume it stuck, and restores the switch and disagreement line to the original state", async () => {
    fetchMock.mockResolvedValue({ ok: false })
    render(true, channel({ whatsappEnabled: true }))
    await act(async () => { await switches()[0].props.onCheckedChange(false) })

    const json = JSON.stringify(renderer.toJSON())
    expect(json).toContain("Save failed")
    expect((switches()[0].props as { checked: boolean }).checked).toBe(true)
    // Original state was whatsappEnabled=true with waEnabled=true — no disagreement.
    expect(json).not.toContain("sends are blocked")
    expect(json).not.toContain("blocked")
  })
})

describe("the deployment card", () => {
  it("marks the server-side values as not editable here", () => {
    const json = JSON.stringify(render(true, channel()).toJSON())
    expect(json).toContain("https://wa.example")
    expect(json).toContain("set on the server; not editable here")
  })

  it("hints how to enable sending when WA_ENABLED is off", () => {
    const json = JSON.stringify(render(false, channel()).toJSON())
    expect(json).toContain("Set WA_ENABLED=true in the server environment to enable sending.")
  })

  it("stays silent about WA_ENABLED when it is already on", () => {
    const json = JSON.stringify(render(true, channel()).toJSON())
    expect(json).not.toContain("Set WA_ENABLED=true")
  })
})

describe("the alert email for unanswered chats", () => {
  const input = () => renderer.root.findByProps({ "aria-label": "Alert email for unanswered chats" })
  const saveButton = () => renderer.root.findByProps({ "data-testid": "chat-alert-email-save" })

  it("shows its label, helper text and the current value", () => {
    const json = JSON.stringify(render(true, channel({ chatAlertEmail: "comms@acme-lending.example" })).toJSON())
    expect(json).toContain("Alert email for unanswered chats")
    expect(json).toContain("Sent when nobody joins a handed-off website chat within 2 minutes, or after hours. Leave empty to send no email.")
    expect(input().props.value).toBe("comms@acme-lending.example")
    expect(input().props.type).toBe("email")
  })

  it("PUTs only chatAlertEmail when Save is pressed", async () => {
    render(true, channel())
    act(() => input().props.onChange({ target: { value: "comms@acme-lending.example" } }))
    await act(async () => { await saveButton().props.onClick() })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/inbox/settings")
    expect(init.method).toBe("PUT")
    expect(JSON.parse(init.body)).toEqual({ chatAlertEmail: "comms@acme-lending.example" })
  })

  it("sends an emptied field as an empty string", async () => {
    render(true, channel({ chatAlertEmail: "comms@acme-lending.example" }))
    act(() => input().props.onChange({ target: { value: "" } }))
    await act(async () => { await saveButton().props.onClick() })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ chatAlertEmail: "" })
  })

  it("reports a rejected save and keeps what was typed", async () => {
    fetchMock.mockResolvedValue({ ok: false })
    render(true, channel())
    act(() => input().props.onChange({ target: { value: "bad" } }))
    await act(async () => { await saveButton().props.onClick() })
    expect(JSON.stringify(renderer.toJSON())).toContain("Save failed")
    expect(input().props.value).toBe("bad")
  })

  it("shows the server's message for an invalid address next to the field, not the role hint, and clears it on the next save", async () => {
    const invalid = { ok: false, status: 400, json: async () => ({ error: "invalid chatAlertEmail", errors: { chatAlertEmail: "Enter a valid email address." } }) }
    fetchMock.mockResolvedValue(invalid)
    render(true, channel())
    act(() => input().props.onChange({ target: { value: "bad" } }))
    await act(async () => { await saveButton().props.onClick() })

    const error = renderer.root.findByProps({ id: "chat-alert-email-error" })
    expect(error.props.children).toBe("Enter a valid email address.")
    expect(error.props.role).toBe("alert")
    expect(input().props["aria-describedby"]).toBe("chat-alert-email-error")
    const json = JSON.stringify(renderer.toJSON())
    expect(json).not.toContain("check your role")
    expect(json).not.toContain("Saved.")
    expect(input().props.value).toBe("bad")

    fetchMock.mockResolvedValue({ ok: true })
    await act(async () => { await saveButton().props.onClick() })
    expect(renderer.root.findAllByProps({ id: "chat-alert-email-error" })).toEqual([])
    expect(input().props["aria-describedby"]).toBeUndefined()
    expect(JSON.stringify(renderer.toJSON())).toContain("Saved.")
  })
})
