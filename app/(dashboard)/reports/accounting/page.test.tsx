import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { risks } = vi.hoisted(() => ({ risks: vi.fn() }))
vi.mock("@/lib/auth-guards", () => ({ requireMinRole: vi.fn(async () => ({ id: "u-1", role: "LOAN_ADMIN" })), hasMinRole: () => false }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: vi.fn(async () => "t-1") }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    accountingExportBatch: { findFirst: vi.fn(async () => null) },
    xeroConnection: { findUnique: vi.fn(async () => null) },
    accountingSettings: { findUnique: vi.fn(async () => null) },
  },
}))
vi.mock("@/lib/payouts/double-payout", () => ({ loadDoublePayoutRisks: (...a: unknown[]) => risks(...a) }))
vi.mock("@/components/accounting/AccountingExportPanel", () => ({ AccountingExportPanel: () => null }))
vi.mock("@/components/accounting/AccountMappingEditor", () => ({ AccountMappingEditor: () => null }))
vi.mock("@/components/accounting/AccountingSettingsPanel", () => ({ AccountingSettingsPanel: () => null }))
vi.mock("@/components/nav/Breadcrumbs", () => ({ Breadcrumbs: () => null }))

import AccountingExportPage from "./page"

const risk = (liveStatus: string) => ({ payoutId: "po-1", loanId: "loan-1", reference: "LN-0001", attempt: 1, reported: "PAID", liveAttempt: 2, liveStatus })

describe("accounting export page", () => {
  beforeEach(() => risks.mockReset())

  it("alerts when a later attempt is PAID while the provider reports an earlier one paid", async () => {
    risks.mockResolvedValue([risk("PAID")])
    const html = renderToStaticMarkup(await AccountingExportPage())
    expect(html).toContain("Possible double payouts")
    expect(html).toContain("/loans/loan-1")
    expect(risks).toHaveBeenCalledWith(expect.anything(), "t-1")
  })

  it("stays quiet while the later attempt is not paid", async () => {
    risks.mockResolvedValue([risk("SUBMITTED")])
    expect(renderToStaticMarkup(await AccountingExportPage())).not.toContain("Possible double payouts")
  })
})
