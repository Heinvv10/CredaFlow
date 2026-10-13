// @vitest-environment jsdom
// A real DOM (react-dom createRoot) so a drop's state change re-renders the
// board: whether the Lost modal mounts is what a READONLY user would see.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { drops } = vi.hoisted(() => ({
  drops: new Map<string, (leadId: string, status: string) => void>(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
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
// Each column hands the board its drop handler, keyed by stage, so the test
// can drop a card where a drag would.
vi.mock("@/components/crm/KanbanColumn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/crm/KanbanColumn")>()),
  KanbanColumn: ({ col, onDrop }: { col: { status: string }; onDrop: (leadId: string, status: string) => void }) => {
    drops.set(col.status, onDrop)
    return null
  },
}))

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

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  drops.clear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

async function dropIntoLost(canWriteActivity: boolean) {
  await act(async () => root.render(<LeadKanban initialLeads={[lead]} canWriteActivity={canWriteActivity} />))
  const onDrop = drops.get("LOST")
  expect(onDrop).toBeDefined()
  await act(async () => onDrop!("lead-1", "LOST"))
}

describe("leads board — dropping a card into Lost", () => {
  // The lost route requires CREDIT_OFFICER.
  it("READONLY: no Lost modal opens", async () => {
    await dropIntoLost(false)
    expect(container.querySelector('[data-testid="lost-modal"]')).toBeNull()
  })

  it("CREDIT_OFFICER: the Lost modal opens for the dropped lead", async () => {
    await dropIntoLost(true)
    expect(container.querySelector('[data-testid="lost-modal"]')?.textContent).toBe("lead-1")
  })
})
