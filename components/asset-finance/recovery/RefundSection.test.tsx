import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { RefundSection } from "./RefundSection"
import type { StaffRecovery } from "./recovery-panel-data"

const bank = { accountHolder: "TEST Debtor Trust", bankName: "TEST Bank", branchCode: "123456", accountNumberLast4: "7890", bankVerifiedById: "u-1", verificationDocumentUrl: "/api/asset-finance/recoveries/rec-1/refund/document" }
const view = (refund: Partial<NonNullable<StaffRecovery["refund"]>> | null): StaffRecovery => ({
  id: "rec-1", status: "SURPLUS_HELD", figures: { surplusCents: 5_000_000 },
  refund: refund && { id: "r-1", status: "PENDING_APPROVAL", amountCents: 5_000_000, createdById: "u-1", approvedById: null, releasedAt: null, bank, ...refund },
}) as unknown as StaffRecovery
const html = (v: StaffRecovery, userId: string, perms = { canManage: true, canDecide: true }) =>
  renderToStaticMarkup(<RefundSection view={v} userId={userId} {...perms} />).replace(/<!-- -->/g, "")

describe("RefundSection", () => {
  it("shows the approver the account (last 4 only) and the verification document link", () => {
    const out = html(view({}), "u-2")
    expect(out).toContain("TEST Debtor Trust")
    expect(out).toContain("TEST Bank")
    expect(out).toContain("123456")
    expect(out).toContain("ending ····7890")
    expect(out).toContain('href="/api/asset-finance/recoveries/rec-1/refund/document"')
    expect(out).toContain("Open bank verification document")
    expect(out).toContain("refund/document?download=1")
    expect(out).toContain("Approve refund")
  })

  it("shows the releaser the same account once the refund is approved", () => {
    const out = html(view({ status: "APPROVED", approvedById: "u-2" }), "u-3")
    expect(out).toContain("ending ····7890")
    expect(out).toContain("Release refund")
  })

  it("shows no account and no document link when the view carries none (a reader)", () => {
    const out = html(view({ bank: null }), "u-2", { canManage: false, canDecide: false })
    expect(out).not.toContain("TEST Debtor Trust")
    expect(out).not.toContain("ending")
    expect(out).not.toContain("Open bank verification document")
  })

  it("shows no account block before a refund exists", () => {
    const out = html(view(null), "u-1")
    expect(out).not.toContain("Open bank verification document")
    expect(out).toContain("Create refund")
  })
})
