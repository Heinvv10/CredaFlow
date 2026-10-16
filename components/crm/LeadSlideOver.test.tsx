// @vitest-environment jsdom
// What the two "on purpose" pieces of LeadSlideOver guarantee:
//   - a different lead loads that lead's bundle, and a response for a lead that
//     is no longer the one asked for is dropped;
//   - the parent echoes tab switches back through initialTab, and that must
//     neither reload nor discard an unsaved Details edit.
import type { ReactNode } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LeadSlideOver } from "./LeadSlideOver"
import type { LeadFormState } from "@/lib/crm/lead-edit-form"

// A component that renders its own name, so a tab is detectable as text.
const marker = vi.hoisted(() => (name: string) => () => `[${name}]`)
vi.mock("@/components/crm/LeadTasksPanel", () => ({ LeadTasksPanel: marker("tasks") }))
vi.mock("@/components/crm/LeadDuplicateFlag", () => ({ LeadDuplicateFlag: () => null }))
vi.mock("@/components/crm/LeadOutreachTab", () => ({ LeadOutreachTab: marker("outreach") }))
vi.mock("@/components/crm/LeadNotesTab", () => ({ LeadNotesTab: marker("notes") }))
vi.mock("@/components/crm/LeadActivityTab", () => ({ LeadActivityTab: marker("activity") }))
vi.mock("@/components/crm/LeadAppointmentTab", () => ({ LeadAppointmentTab: marker("appointment") }))
vi.mock("@/components/crm/LeadModalFooter", () => ({ LeadModalFooter: () => null }))
vi.mock("@/components/crm/LeadModalHighlights", () => ({ LeadModalHighlights: () => null }))
vi.mock("@/components/crm/LeadEditForm", () => ({
  LeadEditForm: ({ form, onChange }: { form: LeadFormState; onChange: (k: "firstName", v: string) => void }): ReactNode => (
    <input data-edit value={form.firstName} onChange={(e) => onChange("firstName", e.target.value)} />
  ),
}))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

let renderer: ReactTestRenderer
let fetchMock: ReturnType<typeof vi.fn>
const noop = () => undefined

function bundle(id: string, firstName: string) {
  return {
    lead: {
      id, firstName, lastName: "Synthetic", email: null, phone: "0820000000", source: "MANUAL",
      status: "NEW", notes: null, assignedToId: null, requestedAmount: null, leadScore: 0,
      callbackDate: null, callbackNotes: null, lostReason: null, convertedToClientId: null,
      convertedToApplicationId: null, conversionRecoveryRequired: false, createdAt: "2026-01-01T00:00:00.000Z",
    },
    activities: [], tasks: [], staff: [], cannedReplies: [], hasContact: true, agentName: "Agent",
    duplicateCount: 0, duplicatesTruncated: false, currentUserId: "u1",
    permissions: { canReassign: true, canCreateTasks: true, canManageTasks: true, canWriteActivity: true },
  }
}

function respond(id: string, firstName: string) {
  return { ok: true, status: 200, json: async () => bundle(id, firstName) }
}

type Props = Parameters<typeof LeadSlideOver>[0]

async function mount(props: Partial<Props>) {
  await act(async () => { renderer = create(<LeadSlideOver leadId="a" onClose={noop} {...props} />) })
}

async function rerender(props: Partial<Props>) {
  await act(async () => { renderer.update(<LeadSlideOver leadId="a" onClose={noop} {...props} />) })
}

function editValue(): string | null {
  const input = renderer.root.findAll((n) => n.props["data-edit"] === true)[0]
  return input ? (input.props.value as string) : null
}

function markers(): string[] {
  return (JSON.stringify(renderer.toJSON()).match(/\[(tasks|notes|activity|outreach|appointment)\]/g) ?? [])
}

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  act(() => renderer.unmount())
  vi.unstubAllGlobals()
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
})

describe("LeadSlideOver", () => {
  it("loads the lead it is opened on", async () => {
    fetchMock.mockResolvedValue(respond("a", "Alpha"))
    await mount({})
    expect(fetchMock).toHaveBeenCalledWith("/api/crm/leads/a/detail")
    expect(editValue()).toBe("Alpha")
  })

  it("says so when the lead no longer exists", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) })
    await mount({})
    expect(JSON.stringify(renderer.toJSON())).toContain("This lead no longer exists.")
  })

  it("loads the new lead when leadId changes", async () => {
    fetchMock.mockResolvedValueOnce(respond("a", "Alpha")).mockResolvedValueOnce(respond("b", "Bravo"))
    await mount({})
    await rerender({ leadId: "b" })
    expect(editValue()).toBe("Bravo")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("ignores a slow response for a lead that is no longer the one asked for", async () => {
    let resolveA!: (r: unknown) => void
    fetchMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveA = resolve }))
      .mockResolvedValueOnce(respond("b", "Bravo"))
    await mount({})
    await rerender({ leadId: "b" })
    await act(async () => { resolveA(respond("a", "Alpha")) })
    expect(editValue()).toBe("Bravo")
  })

  it("switches tab from initialTab without reloading or discarding an unsaved edit", async () => {
    fetchMock.mockResolvedValue(respond("a", "Alpha"))
    await mount({ initialTab: "details" })
    const input = renderer.root.findAll((n) => n.props["data-edit"] === true)[0]
    await act(async () => { input.props.onChange({ target: { value: "Edited" } }) })
    expect(editValue()).toBe("Edited")

    await rerender({ initialTab: "notes" })
    expect(markers()).toContain("[notes]")
    await rerender({ initialTab: "details" })

    expect(editValue()).toBe("Edited")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("lands on the requested tab when opened with one", async () => {
    fetchMock.mockResolvedValue(respond("a", "Alpha"))
    await mount({ initialTab: "tasks" })
    expect(markers()).toEqual(["[tasks]"])
  })

  it("renders nothing while closed and starts clean when reopened on another lead", async () => {
    fetchMock.mockResolvedValueOnce(respond("a", "Alpha")).mockResolvedValueOnce(respond("b", "Bravo"))
    await mount({})
    await rerender({ leadId: null })
    expect(renderer.toJSON()).toBeNull()
    await rerender({ leadId: "b" })
    expect(editValue()).toBe("Bravo")
  })
})
