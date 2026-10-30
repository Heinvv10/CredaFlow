import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@tiptap/react", () => ({ useEditor: () => null, EditorContent: () => null }))
vi.mock("@tiptap/starter-kit", () => ({ default: {} }))
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), networkError: vi.fn() } }))

import { DocumentTemplateEditor, type TemplateVersionRow } from "./DocumentTemplateEditor"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let renderer: ReactTestRenderer
const draft = (over: Partial<TemplateVersionRow> = {}): TemplateVersionRow => ({
  id: "v1", version: 1, status: "DRAFT", createdAt: "2026-10-30T10:00:00Z", notes: null, createdById: "author", approvedById: null, approvedAt: null, ...over,
})
const render = (versions: TemplateVersionRow[], currentUserId: string, requiresApproval = true) => {
  act(() => { renderer = create(<DocumentTemplateEditor templateId="t1" initialBodyHtml="" versions={versions} tokens={[]} currentUserId={currentUserId} requiresApproval={requiresApproval} />) })
}
const labels = () => renderer.root.findAllByType("button").map((b) => (b.children as unknown[]).join("")).filter(Boolean)

beforeEach(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(async () => { await act(async () => renderer?.unmount()); delete actEnvironment.IS_REACT_ACT_ENVIRONMENT })

describe("template version approval in the editor", () => {
  it("the author sees that a second admin must approve, and cannot approve or publish", () => {
    render([draft()], "author")
    expect(JSON.stringify(renderer.toJSON())).toContain("Awaiting approval by a second admin")
    expect(labels()).not.toContain("Approve")
    expect(labels()).not.toContain("Publish")
  })

  it("another admin can approve it, but not yet publish", () => {
    render([draft()], "other")
    expect(labels()).toContain("Approve")
    expect(labels()).not.toContain("Publish")
  })

  it("approving calls the approve route, after which anyone but the approver can publish", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ approvedById: "other", approvedAt: "2026-10-30T11:00:00Z" }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    render([draft()], "other")
    const approve = renderer.root.findAllByType("button").find((b) => (b.children as unknown[]).join("") === "Approve")!
    await act(async () => { await approve.props.onClick() })
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("/api/documents/templates/t1/versions/v1/approve")
    expect(labels()).not.toContain("Approve")
    expect(JSON.stringify(renderer.toJSON())).toContain("Approved by you; someone else publishes")
    vi.unstubAllGlobals()
  })

  it("an approved draft is published by someone other than its approver; a template without the requirement publishes at once", () => {
    render([draft({ approvedById: "other", approvedAt: "2026-10-30T11:00:00Z" })], "author")
    expect(labels()).toContain("Publish")
    render([draft()], "author", false)
    expect(labels()).toContain("Publish")
  })
})
