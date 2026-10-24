// @vitest-environment jsdom
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DsarDecisionRecordsButton } from "./DsarDecisionRecordsButton"

// react-test-renderer, as the repo's other component tests (@testing-library is not a dependency).
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

describe("DsarDecisionRecordsButton", () => {
  let renderer: ReactTestRenderer | undefined
  const originalFetch = globalThis.fetch
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL
  const clicked: { href: string; download: string }[] = []

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    clicked.length = 0
    URL.createObjectURL = vi.fn(() => "blob:records-1")
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download })
    })
  })

  afterEach(() => {
    if (renderer) act(() => renderer!.unmount())
    renderer = undefined
    vi.restoreAllMocks()
    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  const mount = () => {
    act(() => { renderer = create(<DsarDecisionRecordsButton dsarId="dsar-1" reference="DSAR-0001" />) })
    return renderer!
  }
  const press = async (r: ReactTestRenderer) => {
    await act(async () => { await r.root.findByType("button").props.onClick() })
  }

  it("fetches the request's export and saves it under the reference's file name", async () => {
    const fetchMock = vi.fn(async () => new Response('{"records":[]}', { status: 200 }))
    globalThis.fetch = fetchMock as typeof fetch
    const r = mount()
    await press(r)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith("/api/dsar/dsar-1/decision-records")
    expect(clicked).toEqual([{ href: "blob:records-1", download: "decision-records-DSAR-0001.json" }])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:records-1")
    expect(r.root.findAllByProps({ role: "alert" })).toHaveLength(0)
  })

  it("shows an alert, and saves nothing, when the export is refused", async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"error":"Forbidden"}', { status: 403 })) as typeof fetch
    const r = mount()
    await press(r)
    expect(clicked).toEqual([])
    expect(r.root.findByProps({ role: "alert" }).children).toEqual(["Could not export the decision records"])
  })
})
