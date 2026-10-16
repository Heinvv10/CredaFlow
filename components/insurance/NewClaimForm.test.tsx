import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NewClaimForm } from "./NewClaimForm"

const push = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const POLICIES = [
  { id: "pol-1", policyNumber: "FUN-0001", type: "FUNERAL_COVER", sumAssured: 20_000, clientName: "Lerato Mahlangu", clientEmail: "lerato.m@client.invalid" },
  { id: "pol-2", policyNumber: "FUN-0002", type: "FUNERAL_COVER", sumAssured: 10_000, clientName: "Lerato Dube", clientEmail: "ldube@client.invalid" },
]

let renderer: ReactTestRenderer
const fetchMock = vi.fn()

function change(id: string, value: string) {
  act(() => renderer.root.findByProps({ id }).props.onChange({ target: { value } }))
}

function resultNames(): string[] {
  return renderer.root.findAllByType("button")
    .filter((b) => b.props.type === "button" && b.findAllByType("p").length === 2)
    .map((b) => b.findAllByType("p")[0].children.join(""))
}

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  fetchMock.mockReset()
  push.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  act(() => { renderer = create(<NewClaimForm policies={POLICIES} />) })
})
afterEach(() => {
  act(() => renderer.unmount())
  vi.unstubAllGlobals()
})

// Fair Score audit (2026-10-16): "New Claim" led back to /insurance, and the
// claim client search found nothing for "Lerato Mah".
describe("NewClaimForm", () => {
  it("finds the policy by a client's first name and the start of the surname", () => {
    change("policy-search", "Lerato Mah")
    expect(resultNames()).toEqual(["Lerato Mahlangu"])
  })

  it("lodges the claim on the chosen policy and returns to the claims list", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "claim-1" }) })
    change("policy-search", "FUN-0002")
    act(() => renderer.root.findAllByType("button").find((b) => b.props.type === "button")!.props.onClick())
    change("claim-amount", "10000")
    change("claim-type", "DEATH")
    await act(async () => { await renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }) })
    expect(fetchMock).toHaveBeenCalledWith("/api/insurance/claims", expect.objectContaining({ method: "POST" }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ policyId: "pol-2", claimAmount: 10_000, claimType: "DEATH" })
    expect(push).toHaveBeenCalledWith("/insurance/claims")
  })

  it("shows the API's refusal", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "claimAmount must be a finite number" }) })
    change("policy-search", "FUN-0001")
    act(() => renderer.root.findAllByType("button").find((b) => b.props.type === "button")!.props.onClick())
    change("claim-amount", "5")
    await act(async () => { await renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }) })
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("claimAmount must be a finite number")
    expect(push).not.toHaveBeenCalled()
  })
})
