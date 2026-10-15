import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

const mocks = vi.hoisted(() => ({ view: vi.fn(), suppliers: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("@/lib/asset-finance/legal-matter-view", () => ({ getLegalMatterView: mocks.view }))
vi.mock("@/lib/prisma", () => ({ prisma: { supplier: { findMany: mocks.suppliers } } }))

import { LegalMatterPanel } from "./LegalMatterPanel"

const step = (over: Record<string, unknown>) => ({
  id: "s-1", kind: "S129_SENT", stepDate: "2026-09-01", note: "Sent by post", section129RecordId: "r-1", correctsStepId: null, hasEvidence: true,
  recordedById: "u-1", createdAt: "2026-09-01T08:00:00.000Z", ...over,
})
const matter = (over: Record<string, unknown> = {}) => ({
  id: "m-1", loanId: "l-1", loanReference: "LN-1", regime: "NCA", status: "OPEN", caseNumber: null, court: null, attorney: null, createdById: "u-1", closedAt: null,
  steps: [step({}), step({ id: "s-2", correctsStepId: "s-1", hasEvidence: false, note: null })], recoveryIds: [],
  nextStep: { code: "SUMMONS_FROM", text: "summons may issue from 2026-09-15", date: "2026-09-15" },
  eligibleSection129Records: [{ id: "r-1", completedOn: "2026-08-20", usedByStepId: "s-1" }], ...over,
})
const html = async (canManage: boolean) => renderToStaticMarkup(await LegalMatterPanel({ tenantId: "t-1", loanId: "l-1", canManage }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.suppliers.mockResolvedValue([{ id: "sup-1", name: "TEST Attorneys" }])
})

describe("LegalMatterPanel", () => {
  it("offers to open a matter only to a role that manages asset finance", async () => {
    mocks.view.mockResolvedValue({ kind: "done", view: null })
    expect(await html(true)).toContain("Open legal matter")
    expect(await html(false)).not.toContain("Open legal matter")
    expect(await html(false)).toContain("No legal matter has been opened")
  })

  it("renders nothing for a loan that is not an asset-finance loan", async () => {
    mocks.view.mockResolvedValue({ kind: "not_found" })
    expect(await LegalMatterPanel({ tenantId: "t-1", loanId: "l-1", canManage: true })).toBeNull()
  })

  it("shows the timeline, the evidence link and the corrected marker, and the write forms to a manager", async () => {
    mocks.view.mockResolvedValue({ kind: "done", view: matter() })
    const out = await html(true)
    expect(out).toContain("/api/asset-finance/legal-matters/m-1/steps/s-1/document")
    expect(out).toContain("Corrected")
    expect(out).toContain("Record step")
    expect(out).toContain("Appoint attorney")
    expect(mocks.suppliers).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t-1", active: true } }))
  })

  it("hides every write control from a role without manage_asset_finance, and reads no suppliers", async () => {
    mocks.view.mockResolvedValue({ kind: "done", view: matter() })
    const out = await html(false)
    expect(out).toContain("Section 129 notice sent")
    expect(out).not.toContain("Record step")
    expect(out).not.toContain("Appoint attorney")
    expect(mocks.suppliers).not.toHaveBeenCalled()
  })

  it("shows a closed matter without write controls even to a manager", async () => {
    mocks.view.mockResolvedValue({ kind: "done", view: matter({ status: "CLOSED", closedAt: "2026-10-01T10:00:00.000Z", nextStep: null }) })
    const out = await html(true)
    expect(out).toContain("This matter is closed")
    expect(out).not.toContain("Record step")
  })
})
