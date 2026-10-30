import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const push = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }))
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), success: vi.fn(), networkError: vi.fn() } }))

import { LoanDocumentTemplates, type LoanDocumentTemplateRow } from "./LoanDocumentTemplates"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let renderer: ReactTestRenderer
const text = () => JSON.stringify(renderer.toJSON())
const row = (over: Partial<LoanDocumentTemplateRow>): LoanDocumentTemplateRow => ({ key: "non_nca_key_facts", name: "Key facts statement", templateId: null, published: null, drafts: 0, awaitingApproval: 0, ...over })

beforeEach(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true; push.mockReset() })
afterEach(async () => { await act(async () => renderer?.unmount()); delete actEnvironment.IS_REACT_ACT_ENVIRONMENT })

describe("LoanDocumentTemplates (setting up a non-NCA lender's two documents from the UI)", () => {
  it("offers to create a template that does not exist, and says why nothing can be issued", () => {
    act(() => { renderer = create(<LoanDocumentTemplates rows={[row({})]} />) })
    expect(text()).toContain("Not created yet")
    expect(text()).toContain("Create template")
  })

  it("creates it with its fixed key, then opens the editor", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "tpl-9" }), { status: 201 }))
    vi.stubGlobal("fetch", fetchMock)
    act(() => { renderer = create(<LoanDocumentTemplates rows={[row({})]} />) })
    const button = renderer.root.findByType("button")
    await act(async () => { await button.props.onClick() })
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toMatchObject({ key: "non_nca_key_facts", name: "Key facts statement" })
    expect(push).toHaveBeenCalledWith("/settings/documents/tpl-9/edit")
    vi.unstubAllGlobals()
  })

  it("shows where a template is in the approve-then-publish path", () => {
    act(() => {
      renderer = create(<LoanDocumentTemplates rows={[
        row({ templateId: "a", drafts: 1, awaitingApproval: 1 }),
        row({ key: "non_nca_loan_agreement", name: "Loan agreement", templateId: "b", published: 3 }),
      ]} />)
    })
    expect(text()).toContain("1 draft awaiting approval by a second admin")
    expect(text()).toContain("Version 3 published")
    expect(text()).toContain("/settings/documents/a/edit")
  })
})
