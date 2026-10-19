import { renderToStaticMarkup } from "react-dom/server"
import { default as CollectionDetailPage } from "./page"
import { describe, it, expect, vi } from "vitest"
import { evaluateCollectionsEligibility } from "@/lib/collections/section129-eligibility"
import { formatZAR } from "@/lib/utils"

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
vi.mock("@/components/collections/ManualReminderButton", () => ({ ManualReminderButton: () => null }))
vi.mock("@/components/collections/CollectionDetailTabs", () => ({ CollectionDetailTabs: () => null }))
vi.mock("@/components/clients/ClientWhatsAppButton", () => ({ ClientWhatsAppButton: () => null }))
const stagePanelProps = vi.hoisted(() => ({ last: undefined as { section129Unavailable?: { reason: string; temporary: boolean } } | undefined }))
vi.mock("@/components/collections/CollectionsStagePanel", () => ({
  CollectionsStagePanel: (props: { section129Unavailable?: { reason: string; temporary: boolean } }) => {
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
