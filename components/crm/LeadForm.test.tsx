// @vitest-environment jsdom
// The duplicate warning is derived from what is typed: it is fetched once all
// three of first name, last name and phone are filled (debounced), and it must
// vanish the moment any of them is emptied rather than describe a person who is
// no longer in the form.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LeadForm } from "./LeadForm"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const DUPLICATE = { id: "lead-1", name: "Test Person", status: "NEW" }

let renderer: ReactTestRenderer
let fetchMock: ReturnType<typeof vi.fn>

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}

function input(placeholder: string) {
  return renderer.root.findByProps({ placeholder })
}

function type(placeholder: string, value: string) {
  act(() => { input(placeholder).props.onChange({ target: { value } }) })
}

function warningShown(): boolean {
  return JSON.stringify(renderer.toJSON()).includes("already be a lead you are working")
}

async function settleDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400)
    // The response is handled through a chain of promise callbacks.
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

function fillAll() {
  type("John", "Test")
  type("Doe", "Person")
  type("0821234567", "0820000000")
}

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  fetchMock = vi.fn().mockResolvedValue(jsonResponse({ duplicates: [DUPLICATE] }))
  vi.stubGlobal("fetch", fetchMock)
  act(() => { renderer = create(<LeadForm staff={[]} />) })
})

afterEach(() => {
  act(() => renderer.unmount())
  vi.useRealTimers()
  vi.unstubAllGlobals()
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
})

describe("LeadForm duplicate check", () => {
  it("does not look anything up until first name, last name and phone are all filled", async () => {
    type("John", "Test")
    type("Doe", "Person")
    await settleDebounce()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(warningShown()).toBe(false)
  })

  it("posts the three fields after the debounce and shows the match", async () => {
    fillAll()
    expect(fetchMock).not.toHaveBeenCalled()
    await settleDebounce()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    expect(url).toBe("/api/crm/leads/check-duplicates")
    expect(JSON.parse(init.body)).toEqual({ firstName: "Test", lastName: "Person", phone: "0820000000" })
    expect(warningShown()).toBe(true)
  })

  it("clears the warning as soon as a required field is emptied, without another lookup", async () => {
    fillAll()
    await settleDebounce()
    expect(warningShown()).toBe(true)

    type("0821234567", "")
    expect(warningShown()).toBe(false)
    await settleDebounce()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("looks up again, and shows the new result, when the name changes", async () => {
    fillAll()
    await settleDebounce()
    fetchMock.mockResolvedValueOnce(jsonResponse({ duplicates: [] }))
    type("John", "Other")
    await settleDebounce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(warningShown()).toBe(false)
  })
})
