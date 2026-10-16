import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ app: vi.fn(), loan: vi.fn(), check: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { email: "t@example.test" } })) }))
vi.mock("@/lib/session-tenant", () => ({ getPortalTenantId: vi.fn(async () => "t1") }))
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }))
vi.mock("@/lib/config/identity", () => ({
  getLenderIdentity: vi.fn(async () => ({ publicPhone: "+27 11 555 0100", publicEmail: "help@lender.example" })),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: { findFirst: vi.fn(async () => ({ id: "c1" })) },
    loanApplication: { findFirst: h.app },
    loan: { findFirst: h.loan },
    creditBureauCheck: { findFirst: h.check },
  },
}))
vi.mock("@/components/portal/ExecutedAgreementCard", () => ({ ExecutedAgreementCard: () => null }))
vi.mock("@/components/portal/PasqAcknowledgementCard", () => ({ PasqAcknowledgementCard: () => null }))

import ApplicationDetailPage from "./page"

const app = {
  id: "a1", tenantId: "t1", clientId: "c1", reference: "APP-MNSKSZ0Y-GCRU", status: "DISBURSED",
  product: { id: "p1", name: "Personal Loan" }, appliedAmount: 3_000_000, appliedTermDays: 540, approvedAmount: null, purpose: null,
  createdAt: new Date("2026-04-10T08:00:00Z"), updatedAt: new Date("2026-04-20T08:00:00Z"), submittedAt: new Date("2026-04-10T08:00:00Z"),
  incomeVerifiedAt: null, pasqGeneratedAt: null, pasqAcknowledgedAt: null, pasqAcknowledgedSha256: null, pasqDocumentSha256: null,
  pasqDocumentId: null, approvedAt: new Date("2026-04-12T08:00:00Z"), declineCategory: null, decisionReason: null,
  agreementGeneratedAt: null, agreementSignedAt: null, agreementExecutedDocumentId: null, debitMandatePreparedAt: null,
  debitMandateSignedAt: null, disbursedAt: new Date("2026-04-17T08:00:00Z"), repaymentMethod: "DEBIT_ORDER",
}

const render = async () =>
  renderToStaticMarkup(await ApplicationDetailPage({ params: Promise.resolve({ id: "a1" }) })).replace(/<!-- -->/g, "")

beforeEach(() => vi.clearAllMocks())

describe("portal application detail", () => {
  it("shows a disbursed application whose loan is paid up as Settled", async () => {
    h.app.mockResolvedValue(app)
    h.loan.mockResolvedValue({ id: "l1", reference: "LN-MNSKSZ0Y-ABCD", status: "COMPLETED" })
    const html = await render()
    expect(html).toContain(">Settled<")
    expect(html).toContain("Loan settled")
    expect(html).not.toContain(">Disbursed<")
  })

  it("shows a bureau decline's reason, the bureau and next steps, never the internal note", async () => {
    h.app.mockResolvedValue({
      ...app, status: "DECLINED", disbursedAt: null, declineCategory: "BUREAU_SCORE",
      decisionReason: "Your credit record at the credit bureau does not meet our lending criteria.",
      declineInternalNote: "Score 512, two recent defaults.",
    })
    h.loan.mockResolvedValue(null)
    h.check.mockResolvedValue({ provider: "experian" })
    const html = await render()
    expect(html).toContain("does not meet our lending criteria")
    expect(html).toContain("Experian")
    expect(html).toContain("0861 105 665")
    expect(html).toContain("What you can do next")
    expect(html).not.toContain("Score 512")
  })
})
