import { renderToStaticMarkup } from "react-dom/server"
import { default as CollectionDetailPage } from "./page"
import { describe, it, expect, vi } from "vitest"
import { evaluateCollectionsEligibility } from "@/lib/collections/section129-eligibility"
import { formatZAR } from "@/lib/utils"

const holds = vi.hoisted(() => ({
  hold: null as null | { deceased: boolean; debtReview: { loanId: string; loanReference: string; noticeAt: Date; noticeRef: string | null } | null },
}))
// The pure derivations stay real; only the one query is stubbed.
vi.mock("@/lib/collections/client-holds", async (orig) => ({
  ...(await orig<typeof import("@/lib/collections/client-holds")>()),
  loadClientHold: vi.fn(async () => holds.hold),
}))
const reminderButton = vi.hoisted(() => ({ rendered: 0 }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: vi.fn(async () => "t1") }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("next/navigation", () => ({ notFound: vi.fn() }))
vi.mock("@/lib/loan/charges-replay", () => ({ chargesLiveForTenant: vi.fn(async () => true) }))
vi.mock("@/lib/collections/section129-artifact", () => ({
  getSection129IssuanceAvailability: vi.fn(async () => ({ available: false })),
}))
// Client components render nothing here; the figures under test are server-rendered.
vi.mock("@/components/nav/Breadcrumbs", () => ({ Breadcrumbs: () => null }))
vi.mock("@/components/collections/Section129Button", () => ({ Section129Button: () => null }))
vi.mock("@/components/collections/LogContactButton", () => ({ LogContactButton: () => null }))
vi.mock("@/components/collections/PaymentPlanButton", () => ({ PaymentPlanButton: () => null }))
vi.mock("@/components/collections/ManualReminderButton", () => ({
  ManualReminderButton: () => { reminderButton.rendered++; return null },
}))
vi.mock("@/components/collections/CollectionDetailTabs", () => ({ CollectionDetailTabs: () => null }))
vi.mock("@/components/clients/ClientWhatsAppButton", () => ({ ClientWhatsAppButton: () => null }))
const stagePanelProps = vi.hoisted(() => ({ last: undefined as { section129Unavailable?: { reason: string; temporary: boolean }; readOnlyReason?: string; reminderHoldReason?: string } | undefined }))
vi.mock("@/components/collections/CollectionsStagePanel", () => ({
  CollectionsStagePanel: (props: { section129Unavailable?: { reason: string; temporary: boolean }; readOnlyReason?: string; reminderHoldReason?: string }) => {
    stagePanelProps.last = props
    return null
  },
}))
vi.mock("@/lib/collections/section129-eligibility", async (orig) => ({
  ...(await orig<typeof import("@/lib/collections/section129-eligibility")>()),
  evaluateCollectionsEligibility: vi.fn((await orig<typeof import("@/lib/collections/section129-eligibility")>()).evaluateCollectionsEligibility),
}))
vi.mock("@/components/collections/ArrangementTracker", () => ({ ArrangementTracker: () => null }))
vi.mock("@/components/collections/AttorneyReferralCard", () => ({ AttorneyReferralCard: () => null }))
vi.mock("@/components/collections/WriteOffCard", () => ({ WriteOffCard: () => null }))
vi.mock("@/components/collections/WriteOffApprovalCard", () => ({ WriteOffApprovalCard: () => null }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loan: {
      findUnique: vi.fn(async () => ({
        id: "l1", reference: "LN-1", status: "DEFAULTED", principal: 200_000, outstandingPrincipal: 166_900,
        totalPaid: 42_000, arrearsAmount: 174_900, chargesOutstanding: 8_000, daysInArrears: 25,
        nextPaymentDate: null, collectionsStage: "SECTION_129", writeOffRequestedById: null,
        client: { id: "c1", firstName: "Thandi", lastName: "Mocktest", phone: "0820000000", whatsapp: null, email: "t@x.test", idNumber: "9401020000082" },
        product: { name: "Micro", productType: "MICRO" }, notes: [], repaymentSchedule: [], paymentPlan: null,
        // R500 cash, R80 of it paid default charges; the waiver is not cash.
        payments: [
          { amount: 50_000, paymentMethod: "EFT", reversed: false, allocationStatus: "ALLOCATED" },
          { amount: 90, paymentMethod: "WAIVER", reversed: false, allocationStatus: "ALLOCATED" },
        ],
      })),
    },
    paymentArrangement: { findFirst: vi.fn(async () => null) },
    attorneyReferral: { findUnique: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => null) },
    // No Section 129 attempt on file (lib/collections/section129-failures.ts).
    $queryRaw: vi.fn(async () => []),
  },
}))

describe("collections loan page", () => {
  const underReview = { deceased: false, debtReview: { loanId: "l2", loanReference: "LN-2", noticeAt: new Date("2026-10-15T00:00:00+02:00"), noticeRef: "DC-1" } }

  it("debt review: banner in design tokens linking to the loan that carries the notice, no reminder button, stage panel read-only, S.129 blocked", async () => {
    holds.hold = underReview
    reminderButton.rendered = 0
    try {
      const html = renderToStaticMarkup(await CollectionDetailPage({ params: Promise.resolve({ loanId: "l1" }) }))
      expect(html).toContain("Automated reminders and staff messages are paused: the client is under debt review")
      expect(html).toContain('href="/loans/l2"')
      expect(html).toContain("Open loan LN-2")
      const at = html.indexOf("are paused")
      expect(html.slice(at - 250, at + 350)).toContain("var(--cf-warning)")
      expect(html.slice(at - 250, at + 350)).not.toContain("amber")
      expect(reminderButton.rendered).toBe(0)
      // Only the reminder moves are held; the panel as a whole stays writable (arrangement, attorney).
      expect(stagePanelProps.last).toMatchObject({ reminderHoldReason: expect.stringContaining("the client is under debt review") })
      expect(stagePanelProps.last?.readOnlyReason).toBeUndefined()
      expect(stagePanelProps.last?.section129Unavailable).toMatchObject({ temporary: false, reason: expect.stringContaining("Cannot issue a Section 129 notice") })
    } finally {
      holds.hold = null
    }
  })

  it("deceased: says so (not debt review), with no link, and offers no reminder", async () => {
    holds.hold = { deceased: true, debtReview: null }
    reminderButton.rendered = 0
    try {
      const html = renderToStaticMarkup(await CollectionDetailPage({ params: Promise.resolve({ loanId: "l1" }) }))
      expect(html).toContain("paused: a death is recorded for this client.")
      expect(html).not.toContain("debt review")
      expect(html).not.toContain("Open loan")
      expect(reminderButton.rendered).toBe(0)
    } finally {
      holds.hold = null
    }
  })

  it("with no hold, offers the reminder button and a writable stage panel", async () => {
    reminderButton.rendered = 0
    renderToStaticMarkup(await CollectionDetailPage({ params: Promise.resolve({ loanId: "l1" }) }))
    expect(reminderButton.rendered).toBe(1)
    expect(stagePanelProps.last?.readOnlyReason).toBeUndefined()
    expect(stagePanelProps.last?.reminderHoldReason).toBeUndefined()
  })

  it("states Total Paid as cash received, not the share applied to the instalments", async () => {
    const html = renderToStaticMarkup(await CollectionDetailPage({ params: Promise.resolve({ loanId: "l1" }) }))
    const card = html.slice(html.indexOf("Total Paid"))
    expect(card.slice(0, 200)).toContain(formatZAR(50_000))
  })

  it("takes 'temporary' from the eligibility result, not from the reason wording", async () => {
    const real = vi.mocked(evaluateCollectionsEligibility).getMockImplementation()!
    const render = async (temporary: boolean) => {
      vi.mocked(evaluateCollectionsEligibility).mockImplementation((loan, op) =>
        op === "SECTION_129"
          ? { eligible: false, temporary, minimumDaysInArrears: 90, reason: "reworded: not yet" }
          : real(loan, op))
      renderToStaticMarkup(await CollectionDetailPage({ params: Promise.resolve({ loanId: "l1" }) }))
      return stagePanelProps.last?.section129Unavailable
    }
    try {
      expect(await render(true)).toEqual({ reason: "reworded: not yet", temporary: true })
      expect(await render(false)).toEqual({ reason: "reworded: not yet", temporary: false })
    } finally {
      vi.mocked(evaluateCollectionsEligibility).mockImplementation(real)
    }
  })
})
