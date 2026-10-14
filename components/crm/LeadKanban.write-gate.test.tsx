// @vitest-environment jsdom
// A real DOM (react-dom createRoot) so a drop's state change re-renders the
// board: where the card sits, which modal mounts and which request goes out is
// what a READONLY user would see. Every board write (the PATCH, lost, callback
// and convert routes) requires CREDIT_OFFICER.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { drops, push } = vi.hoisted(() => ({
  drops: new Map<string, (leadId: string, status: string) => void>(),
  push: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock("@/components/crm/LostReasonModal", () => ({
  LostReasonModal: ({ leadId }: { leadId: string }) => <div data-testid="lost-modal">{leadId}</div>,
}))
vi.mock("@/components/crm/CallbackModal", () => ({ CallbackModal: () => null }))
vi.mock("@/components/crm/LeadSlideOver", () => ({ LeadSlideOver: () => null }))
// The column's own drop event needs a DataTransfer, which jsdom lacks. The mock
// keeps the board's wiring: it hands the test the board's drop handler for its
// stage, and renders the REAL LeadCard with the props the board passed.
vi.mock("@/components/crm/KanbanColumn", async (importOriginal) => {
  const { LeadCard } = await import("@/components/crm/LeadCard")
  return {
    ...(await importOriginal<typeof import("@/components/crm/KanbanColumn")>()),
    KanbanColumn: ({ col, leads, onDrop, onOpen, onCallback }: {
      col: { status: string }
      leads: KanbanLead[]
      onDrop: (leadId: string, status: string) => void
      onOpen: (leadId: string, tab: string) => void
      onCallback?: (leadId: string) => void
    }) => {
      drops.set(col.status, onDrop)
      return (
        <section data-col={col.status}>
          {leads.map((lead) => <LeadCard key={lead.id} lead={lead} onOpen={onOpen} onCallback={onCallback} />)}
        </section>
      )
    },
  }
})

import { LeadKanban } from "./LeadKanban"
import type { KanbanLead } from "@/components/crm/LeadCard"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const lead: KanbanLead = {
  id: "lead-1",
  firstName: "Synthetic",
  lastName: "Lead",
  phone: "+27820000001",
  source: "WEBSITE",
  status: "NEW",
  convertedToClientId: null,
  convertedToApplicationId: null,
  conversionRecoveryRequired: false,
  assignedToId: null,
  createdAt: new Date("2026-07-22T00:00:00.000Z"),
  updatedAt: new Date("2026-07-22T00:00:00.000Z"),
  statusChangedAt: new Date("2026-07-22T00:00:00.000Z"),
  callbackDate: null,
  leadScore: 50,
  requestedAmount: null,
  duplicateCount: 0,
  _count: { activities: 0 },
}

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  drops.clear()
  push.mockReset()
  fetchMock = vi.fn(async () => Response.json({ ok: true }))
  vi.stubGlobal("fetch", fetchMock)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

async function board(canWriteActivity: boolean) {
  await act(async () => root.render(<LeadKanban initialLeads={[lead]} canWriteActivity={canWriteActivity} />))
}

async function drop(status: string) {
  const onDrop = drops.get(status)
  expect(onDrop).toBeDefined()
  await act(async () => onDrop!("lead-1", status))
}

const columnOfCard = () => container.querySelector("section:has([draggable])")?.getAttribute("data-col")
const callbackButton = () => container.querySelector('button[aria-label="Schedule callback"]')
const lostModal = () => container.querySelector('[data-testid="lost-modal"]')

describe("leads board — READONLY", () => {
  it.each(["CONTACTED", "QUALIFIED", "PROPOSAL_SENT", "CONVERTED", "LOST"])(
    "a drop into %s does nothing: no move, no request, no navigation, no modal",
    async (status) => {
      await board(false)
      await drop(status)
      expect(columnOfCard()).toBe("NEW")
      expect(fetchMock).not.toHaveBeenCalled()
      expect(push).not.toHaveBeenCalled()
      expect(lostModal()).toBeNull()
    },
  )

  it("the card offers no Schedule callback quick action", async () => {
    await board(false)
    expect(container.querySelector('button[aria-label="Open details"]')).not.toBeNull()
    expect(callbackButton()).toBeNull()
  })
})

describe("leads board — CREDIT_OFFICER", () => {
  it("a drop into a stage moves the card and PATCHes the lead", async () => {
    await board(true)
    await drop("CONTACTED")
    expect(columnOfCard()).toBe("CONTACTED")
    expect(fetchMock).toHaveBeenCalledWith("/api/crm/leads/lead-1", expect.objectContaining({ method: "PATCH" }))
  })

  it("a drop into Converted opens the convert page", async () => {
    await board(true)
    await drop("CONVERTED")
    expect(push).toHaveBeenCalledWith("/crm/leads/lead-1/convert")
  })

  it("a drop into Lost opens the Lost modal for the dropped lead", async () => {
    await board(true)
    await drop("LOST")
    expect(lostModal()?.textContent).toBe("lead-1")
  })

  it("the card offers the Schedule callback quick action", async () => {
    await board(true)
    expect(callbackButton()).not.toBeNull()
  })
})
