import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

const mocks = vi.hoisted(() => ({ data: vi.fn(), costForm: vi.fn(), valuations: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("./recovery-panel-data", () => ({ loadRecoveryPanelData: mocks.data, loadCostFormData: mocks.costForm, loadSaleValuations: mocks.valuations }))

import { RecoveryPanel } from "./RecoveryPanel"

const view = (over: Record<string, unknown> = {}) => ({
  id: "rec-1", loanId: "l-1", assetId: "a-1", route: "NON_NCA_VOLUNTARY", status: "VALUED", surrenderRequestId: null, legalMatterId: null, meterReadingId: null,
  recoveredOn: "2026-10-01", location: "Yard 4", condition: "Good",
  valuation: { id: "v-1", valuedOn: "2026-10-02", source: "ASSESSOR", valuerName: "TEST Valuers", amountCents: 80_000_000 },
  notices: { valuationIssued: false, finalIssued: false, finalNoticeIssuedOn: null },
  costs: [{ id: "c-1", type: "TOWING", label: "Towing and transport", status: "APPROVED", netCents: 100_000, vatCents: 0, grossCents: 100_000, treatment: "DEDUCT_FROM_PROCEEDS", supplierId: null, supplierInvoiceRef: "INV-1", incurredOn: "2026-10-01", legalStepId: null, note: null, recordedById: "u-2", approvedById: "u-3" }],
  pendingCosts: [], costTotals: { deducted: 100_000, charged: 0 }, sales: [], figures: null, freeze: { from: null, until: null }, refund: null, withdrawnReason: null, closedAt: null, ...over,
})
const html = async (perms: { canManage: boolean; canDecide: boolean; canRecordPayment?: boolean }) =>
  renderToStaticMarkup(await RecoveryPanel({ tenantId: "t-1", loanId: "l-1", userId: "u-1", canRecordPayment: false, ...perms }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.costForm.mockResolvedValue({ lists: { ncaDeductible: [], nonNcaChargeable: ["TOWING"] }, suppliers: [], legalSteps: [] })
  mocks.valuations.mockResolvedValue([])
})

describe("RecoveryPanel", () => {
  it("renders nothing when the loan has no recovery and nothing to record", async () => {
    mocks.data.mockResolvedValue({ kind: "none" })
    expect(await RecoveryPanel({ tenantId: "t-1", loanId: "l-1", userId: "u-1", canManage: true, canDecide: true, canRecordPayment: true })).toBeNull()
  })

  it("offers to record a recovery to a manager only", async () => {
    mocks.data.mockResolvedValue({ kind: "record", regime: "NON_NCA", lease: false, surrenders: [] })
    expect(await html({ canManage: true, canDecide: false })).toContain("Record recovery")
    expect(await RecoveryPanel({ tenantId: "t-1", loanId: "l-1", userId: "u-1", canManage: false, canDecide: false, canRecordPayment: false })).toBeNull()
  })

  it("shows a non-NCA recovery's stepper without notice steps, its next step and the cost ledger", async () => {
    mocks.data.mockResolvedValue({ kind: "recovery", view: view(), regime: "NON_NCA", lease: false, surrender: null })
    const out = await html({ canManage: true, canDecide: false })
    expect(out).not.toContain("Valuation notice issued")
    expect(out).toContain("List for sale")
    expect(out).toContain("Deducted from the proceeds")
    expect(out).toContain("INV-1")
    expect(out).toContain("Withdraw recovery")
  })

  it("shows an NCA recovery's notice steps", async () => {
    mocks.data.mockResolvedValue({ kind: "recovery", view: view({ route: "NCA_S131_ATTACHMENT" }), regime: "NCA", lease: false, surrender: null })
    expect(await html({ canManage: true, canDecide: false })).toContain("Valuation notice issued")
  })

  it("hides every write control from a role that cannot manage, and reads no cost-form data", async () => {
    mocks.data.mockResolvedValue({ kind: "recovery", view: view(), regime: "NON_NCA", lease: false, surrender: null })
    const out = await html({ canManage: false, canDecide: false })
    expect(out).toContain("INV-1")
    for (const control of ["List for sale", "Withdraw recovery", "Record cost", "Propose sale"]) expect(out).not.toContain(control)
    expect(mocks.costForm).not.toHaveBeenCalled()
  })

  it("applies the sale proceeds only for a role with record_payment", async () => {
    mocks.data.mockResolvedValue({ kind: "recovery", view: view({ status: "SOLD" }), regime: "NON_NCA", lease: false, surrender: null })
    expect(await html({ canManage: true, canDecide: false, canRecordPayment: true })).toContain("Apply the sale proceeds")
    expect(await html({ canManage: true, canDecide: false, canRecordPayment: false })).toContain("needs the record_payment permission")
  })

  it("lets a manager record a cost until the proceeds are applied, and never an unprivileged role", async () => {
    mocks.data.mockResolvedValue({ kind: "recovery", view: view(), regime: "NON_NCA", lease: false, surrender: null })
    expect(await html({ canManage: true, canDecide: false })).toContain("Record cost")
    mocks.data.mockResolvedValue({ kind: "recovery", view: view({ status: "PROCEEDS_APPLIED" }), regime: "NON_NCA", lease: false, surrender: null })
    expect(await html({ canManage: true, canDecide: true })).not.toContain("Record cost")
  })

  it("tells staff to decide pending costs before applying the proceeds", async () => {
    const pendingCosts = [{ id: "c-2", type: "STORAGE", label: "Storage", status: "PENDING", netCents: 50_000, vatCents: 0, grossCents: 50_000, treatment: "DEDUCT_FROM_PROCEEDS",
      supplierId: null, supplierInvoiceRef: "INV-2", incurredOn: "2026-10-02", legalStepId: null, note: null, recordedById: "u-2", approvedById: null }]
    mocks.data.mockResolvedValue({ kind: "recovery", view: view({ status: "SOLD", pendingCosts }), regime: "NON_NCA", lease: false, surrender: null })
    expect(await html({ canManage: true, canDecide: false, canRecordPayment: true })).toContain("1 cost is still pending")
  })

  it("lets an approver decide a pending cost only when someone else recorded it", async () => {
    const pendingCosts = [{ id: "c-2", type: "STORAGE", label: "Storage", status: "PENDING", netCents: 50_000, vatCents: 0, grossCents: 50_000, treatment: "DEDUCT_FROM_PROCEEDS",
      supplierId: null, supplierInvoiceRef: "INV-2", incurredOn: "2026-10-02", legalStepId: null, note: null, recordedById: "u-2", approvedById: null }]
    mocks.data.mockResolvedValue({ kind: "recovery", view: view({ pendingCosts }), regime: "NON_NCA", lease: false, surrender: null })
    expect(await html({ canManage: true, canDecide: true })).toContain("Approve cost")
    expect(await html({ canManage: true, canDecide: false })).not.toContain("Approve cost")
    mocks.data.mockResolvedValue({ kind: "recovery", view: view({ pendingCosts: [{ ...pendingCosts[0], recordedById: "u-1" }] }), regime: "NON_NCA", lease: false, surrender: null })
    const own = await html({ canManage: true, canDecide: true })
    expect(own).not.toContain("Approve cost")
    expect(own).toContain("You recorded this cost")
  })

  it("shows the withdrawn reason and no stepper", async () => {
    mocks.data.mockResolvedValue({ kind: "recovery", view: view({ status: "WITHDRAWN", withdrawnReason: "Debtor settled in full" }), regime: "NON_NCA", lease: false, surrender: null })
    const out = await html({ canManage: true, canDecide: true })
    expect(out).toContain("Debtor settled in full")
    expect(out).not.toContain("Recovery progress")
  })
})
