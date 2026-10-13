import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock("@/app/actions/crm", () => ({
  addLeadActivity: vi.fn(),
  updateLeadStatus: vi.fn(),
  resetStrandedConvertedLead: vi.fn(),
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/audit", () => ({ logAuditStrict: vi.fn(), AuditAction: {} }))
vi.mock("@/app/actions/lead-activities", () => ({ toggleLeadActivityPinned: vi.fn() }))
vi.mock("@/components/crm/SendWhatsAppModal", () => ({ SendWhatsAppModal: () => null }))
vi.mock("@/components/crm/CallbackModal", () => ({ CallbackModal: () => null }))
vi.mock("@/components/crm/LostReasonModal", () => ({ LostReasonModal: () => null }))
vi.mock("@/components/crm/LeadTimelineRow", () => ({
  ActivityRow: () => <span data-testid="activity-row" />,
  MessageRow: () => null,
  timeAgo: () => "now",
  SAST_TIME_ZONE: "Africa/Johannesburg",
}))
vi.mock("@/components/crm/LeadOwnerSelect", () => ({ LeadOwnerSelect: () => null }))
vi.mock("@/components/crm/LeadOutreachButtons", () => ({ LeadOutreachButtons: () => null }))
vi.mock("@/components/crm/LeadTasksPanel", () => ({ LeadTasksPanel: () => null }))
vi.mock("@/components/crm/LeadDuplicateFlag", () => ({ LeadDuplicateFlag: () => null }))
vi.mock("@/components/messaging/MessageClientButton", () => ({ MessageClientButton: () => null }))

import { LeadDetailClient } from "@/components/crm/LeadDetailClient"
import { LeadNotesTab } from "@/components/crm/LeadNotesTab"
import { LeadActivityTab } from "@/components/crm/LeadActivityTab"
import { LeadAppointmentTab } from "@/components/crm/LeadAppointmentTab"
import { canWriteLeadActivity } from "@/lib/crm/lead-write-access"

const lead = {
  id: "lead-1",
  firstName: "Synthetic",
  lastName: "Lead",
  email: "synthetic@test.invalid",
  phone: "+27820000001",
  source: "WEBSITE",
  status: "NEW",
  notes: null,
  assignedToId: null,
  requestedAmount: 100_000,
  leadScore: 50,
  callbackDate: null,
  callbackNotes: null,
  lostReason: null,
  convertedToClientId: null,
  convertedToApplicationId: null,
  conversionRecoveryRequired: false,
  createdAt: new Date("2026-07-22T00:00:00.000Z"),
  activities: [],
}

// READONLY → both flags false; CREDIT_OFFICER → both true (the page derives
// each from its own CREDIT_OFFICER bar).
function detail(canWriteActivity: boolean, leadOverrides: Partial<typeof lead> = {}) {
  return renderToStaticMarkup(
    <LeadDetailClient
      lead={{ ...lead, ...leadOverrides }}
      hasContact={false}
      cannedReplies={[]}
      commsMessages={[]}
      staff={[]}
      canReassign={false}
      agentName="Synthetic Agent"
      tasks={[]}
      canCreateTasks={false}
      canManageTasks={false}
      canWriteActivity={canWriteActivity}
      canConvert={canWriteActivity}
      currentUserId="user-1"
      duplicateCount={0}
      duplicatesTruncated={false}
    />,
  )
}

const note = { id: "n1", type: "NOTE", subject: "s", notes: null, createdAt: "2026-07-22T00:00:00.000Z" }
const activity = { id: "a1", type: "CALL", subject: "s", notes: null, pinned: false, createdAt: "2026-07-22T00:00:00.000Z" }

describe("canWriteLeadActivity", () => {
  it.each([
    ["READONLY", false],
    ["COLLECTIONS_AGENT", false],
    ["INSURANCE_OFFICER", false],
    ["CREDIT_OFFICER", true],
    ["LOAN_ADMIN", true],
    ["SUPER_ADMIN", true],
    ["CLIENT", false],
    [undefined, false],
  ] as const)("%s -> %s", (role, expected) => {
    expect(canWriteLeadActivity(role)).toBe(expected)
  })
})

describe("lead detail — write controls follow the role", () => {
  it("READONLY sees the lead without stage buttons or Add Activity", () => {
    const html = detail(false)
    expect(html).toContain("Synthetic")
    expect(html).not.toContain("Move Stage")
    expect(html).not.toContain("+ Add Activity")
  })

  it("CREDIT_OFFICER sees stage buttons and Add Activity", () => {
    const html = detail(true)
    expect(html).toContain("Move Stage")
    expect(html).toContain("+ Add Activity")
  })

  // The callback and lost routes both require CREDIT_OFFICER.
  it("READONLY is not offered Schedule Callback or Mark as Lost", () => {
    const html = detail(false)
    expect(html).toContain("Actions")
    expect(html).not.toContain("Schedule Callback")
    expect(html).not.toContain("Mark as Lost")
  })

  it("CREDIT_OFFICER is offered Schedule Callback and Mark as Lost", () => {
    const html = detail(true)
    expect(html).toContain("Schedule Callback")
    expect(html).toContain("Mark as Lost")
  })

  // The convert route and resetStrandedConvertedLead both require CREDIT_OFFICER.
  it("READONLY is not offered Convert to Client", () => {
    expect(detail(false)).not.toContain("Convert to Client")
  })

  it("CREDIT_OFFICER is offered Convert to Client", () => {
    expect(detail(true)).toContain("Convert to Client")
  })

  it("READONLY is not offered Reset & Retry Conversion on a stranded lead", () => {
    const html = detail(false, { status: "CONVERTED" })
    expect(html).not.toContain("Reset &amp; Retry Conversion")
  })

  it("CREDIT_OFFICER is offered Reset & Retry Conversion on a stranded lead", () => {
    const html = detail(true, { status: "CONVERTED" })
    expect(html).toContain("Reset &amp; Retry Conversion")
  })
})

describe("slide-over appointment tab", () => {
  const tab = (canSchedule: boolean) => renderToStaticMarkup(
    <LeadAppointmentTab
      leadId="lead-1"
      status="CONTACTED"
      callbackDate="2099-01-01T08:00:00.000Z"
      callbackNotes="Synthetic callback note"
      canSchedule={canSchedule}
      onChanged={() => {}}
    />,
  )

  it("READONLY sees the scheduled callback but no schedule/reschedule form", () => {
    const html = tab(false)
    expect(html).toContain("Synthetic callback note")
    expect(html).not.toContain("<form")
    expect(html).not.toContain("Reschedule")
  })

  it("CREDIT_OFFICER gets the reschedule form", () => {
    const html = tab(true)
    expect(html).toContain("<form")
    expect(html).toContain("Reschedule")
  })
})

describe("notes tab composer", () => {
  it("READONLY: notes listed, no composer", () => {
    const html = renderToStaticMarkup(<LeadNotesTab leadId="lead-1" activities={[note]} canWrite={false} onChanged={() => {}} />)
    expect(html).toContain("activity-row")
    expect(html).not.toContain("Add a note")
    expect(html).not.toContain("Add note")
  })

  it("CREDIT_OFFICER: composer shown", () => {
    const html = renderToStaticMarkup(<LeadNotesTab leadId="lead-1" activities={[note]} canWrite onChanged={() => {}} />)
    expect(html).toContain("Add a note")
  })
})

describe("activity tab pin", () => {
  it("READONLY: timeline shown, no pin control", () => {
    const html = renderToStaticMarkup(<LeadActivityTab activities={[activity]} commsMessages={[]} canPin={false} onChanged={() => {}} />)
    expect(html).toContain("activity-row")
    expect(html).not.toContain("Pin to top")
  })

  it("CREDIT_OFFICER: pin control shown", () => {
    const html = renderToStaticMarkup(<LeadActivityTab activities={[activity]} commsMessages={[]} canPin onChanged={() => {}} />)
    expect(html).toContain("Pin to top")
  })
})
