import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock("@/app/actions/crm", () => ({
  addLeadActivity: vi.fn(),
  updateLeadStatus: vi.fn(),
  resetStrandedConvertedLead: vi.fn(),
}))
vi.mock("@/components/crm/SendWhatsAppModal", () => ({
  SendWhatsAppModal: ({ clientId, isOpen }: { clientId: string; isOpen: boolean }) => (
    <span data-testid="wa-modal-mount" data-client-id={clientId} data-open={String(isOpen)} />
  ),
}))
vi.mock("@/components/crm/CallbackModal", () => ({ CallbackModal: () => null }))
vi.mock("@/components/crm/LostReasonModal", () => ({ LostReasonModal: () => null }))
vi.mock("@/components/crm/LeadTimelineRow", () => ({
  ActivityRow: () => null,
  MessageRow: () => null,
  timeAgo: () => "now",
  SAST_TIME_ZONE: "Africa/Johannesburg",
}))
vi.mock("@/components/crm/LeadOwnerSelect", () => ({ LeadOwnerSelect: () => null }))
vi.mock("@/components/crm/LeadOutreachButtons", () => ({ LeadOutreachButtons: () => null }))
vi.mock("@/components/crm/LeadTasksPanel", () => ({ LeadTasksPanel: () => null }))
vi.mock("@/components/crm/LeadDuplicateFlag", () => ({ LeadDuplicateFlag: () => null }))
vi.mock("@/components/messaging/MessageClientButton", () => ({ MessageClientButton: () => null }))

import { CollectionsWaButton } from "@/components/collections/CollectionsWaButton"
import { LeadDetailClient } from "@/components/crm/LeadDetailClient"

describe("WhatsApp operation-key component lifetime", () => {
  it("keeps the collections modal mounted while its dialog is closed", () => {
    const html = renderToStaticMarkup(
      <CollectionsWaButton
        clientId="client-collections"
        clientName="Synthetic Client"
        phone="+27820000000"
        daysInArrears={7}
      />,
    )

    expect(html).toContain("data-testid=\"wa-modal-mount\"")
    expect(html).toContain("data-client-id=\"client-collections\"")
    expect(html).toContain("data-open=\"false\"")
  })

  it("keeps the converted-lead modal mounted while its dialog is closed", () => {
    const html = renderToStaticMarkup(
      <LeadDetailClient
        lead={{
          id: "lead-1",
          firstName: "Synthetic",
          lastName: "Lead",
          email: "synthetic@test.invalid",
          phone: "+27820000001",
          source: "WEBSITE",
          status: "CONVERTED",
          notes: null,
          assignedToId: null,
          requestedAmount: 100_000,
          leadScore: 50,
          callbackDate: null,
          callbackNotes: null,
          lostReason: null,
          convertedToClientId: "client-from-lead",
          convertedToApplicationId: "application-from-lead",
          conversionRecoveryRequired: false,
          createdAt: new Date("2026-07-22T00:00:00.000Z"),
          activities: [],
        }}
        hasContact
        cannedReplies={[]}
        commsMessages={[]}
        staff={[]}
        canReassign={false}
        agentName="Synthetic Agent"
        tasks={[]}
        canCreateTasks={false}
        canManageTasks={false}
        currentUserId="user-1"
        duplicateCount={0}
        duplicatesTruncated={false}
      />,
    )

    expect(html).toContain("data-testid=\"wa-modal-mount\"")
    expect(html).toContain("data-client-id=\"client-from-lead\"")
    expect(html).toContain("data-open=\"false\"")
  })
})
