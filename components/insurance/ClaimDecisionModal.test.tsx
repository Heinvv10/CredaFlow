import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ClaimDecisionModal } from "./ClaimDecisionModal"
import { InsuranceClaimsClient } from "./InsuranceClaimsClient"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

// Fair Score audit (2026-10-16): the approve field was pre-filled with 10000
// and the officer's typed digits were appended (R1,000,010,000.00 approved on a
// R10,000 claim); the lender, an intermediary, "Approved/Rejected" a claim the
// insurer decides; and "New Claim" linked back to /insurance.
const CLAIM = {
  id: "claim-1", claimNumber: "CLM-1", status: "SUBMITTED", claimAmount: 10_000, approvedAmount: null,
  submittedAt: "2026-10-01", resolvedAt: null, notes: null, claimType: null, incidentDate: null, fnolDate: null,
  insurerRef: null, rejectionReason: null, assessor: null,
  policy: { type: "FUNERAL_COVER", policyNumber: "FUN-0001", sumAssured: 20_000, client: { firstName: "Lerato", lastName: "Mahlangu", phone: "0820000000" } },
}

let renderer: ReactTestRenderer
const fetchMock = vi.fn()

function text(): string {
  const parts: string[] = []
  const walk = (node: unknown) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node === "string") return void parts.push(node)
    walk((node as { children?: unknown }).children)
  }
  walk(renderer.toJSON())
  return parts.join("")
}

function openModal(onRecorded = vi.fn()) {
  act(() => {
    renderer = create(<ClaimDecisionModal claim={CLAIM} advisors={[]} onClose={vi.fn()} onRecorded={onRecorded} />)
  })
  return onRecorded
}

function choose(value: "approve" | "reject") {
  act(() => renderer.root.findByProps({ name: "outcome", value }).props.onChange())
}

function typeAmount(value: string) {
  act(() => renderer.root.findByProps({ id: "approved-amount" }).props.onChange({ target: { value } }))
}

async function submit() {
  await act(async () => {
    await renderer.root.findByType("form").props.onSubmit({ preventDefault() {} })
  })
}

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  act(() => renderer.unmount())
  vi.unstubAllGlobals()
})

describe("Recording the insurer's claim decision", () => {
  it("the claims list offers 'Record insurer decision', not Approve/Reject, and New Claim opens the claim form", () => {
    act(() => { renderer = create(<InsuranceClaimsClient claims={[CLAIM]} />) })
    expect(text()).toContain("Record insurer decision")
    expect(text()).not.toMatch(/\bApprove\b|\bReject\b/)
    const newClaim = renderer.root.findAllByType("a").find((a) => a.findAll((n) => n.children.some((c) => typeof c === "string" && c.includes("New Claim"))).length > 0)
    expect(newClaim?.props.href).toBe("/insurance/claims/new")
  })

  it("records the insurer's payment of an APPROVED claim through mark_paid", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) })
    act(() => { renderer = create(<InsuranceClaimsClient claims={[{ ...CLAIM, status: "APPROVED", approvedAmount: 8000 }]} />) })
    expect(text()).not.toContain("Record insurer decision")
    const button = renderer.root.findAllByType("button").find((b) => b.findAll((n) => n.children.some((c) => typeof c === "string" && c.includes("Record insurer payment"))).length > 0)!
    await act(async () => { await button.props.onClick() })
    expect(fetchMock).toHaveBeenCalledWith("/api/insurance/claims/claim-1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ action: "mark_paid" }) }))
  })

  it("starts the approved amount empty, with the claimed amount as a hint, so typing cannot append to it", () => {
    openModal()
    choose("approve")
    const input = renderer.root.findByProps({ id: "approved-amount" })
    expect(input.props.value).toBe("")
    expect(input.props.placeholder).toBe("10000.00")
    typeAmount("5000")
    expect(renderer.root.findByProps({ id: "approved-amount" }).props.value).toBe("5000")
  })

  it("refuses more than the amount claimed before calling the API", async () => {
    openModal()
    choose("approve")
    typeAmount("100000")
    await submit()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toMatch(/cannot exceed the amount claimed \(R 10,000\.00\)/)
  })

  it("shows the API's own refusal rather than a generic failure", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "The approved amount cannot exceed the policy's sum assured (R 20 000.00)." }) })
    openModal()
    choose("approve")
    typeAmount("9000")
    await submit()
    expect(fetchMock).toHaveBeenCalledWith("/api/insurance/claims/claim-1", expect.objectContaining({ method: "PATCH" }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ action: "approve", approvedAmount: 9000 })
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toMatch(/sum assured/)
  })

  it("records a decline with the insurer's reason", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) })
    const onRecorded = openModal()
    choose("reject")
    act(() => renderer.root.findByProps({ id: "decline-reason" }).props.onChange({ target: { value: "Waiting period" } }))
    await submit()
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ action: "reject", rejectionReason: "Waiting period" })
    expect(onRecorded).toHaveBeenCalled()
  })
})
