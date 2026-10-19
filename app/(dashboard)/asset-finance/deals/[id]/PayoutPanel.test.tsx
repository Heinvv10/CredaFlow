import { act, create, type ReactTestInstance } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { DocumentUploadForm } from "@/components/asset-finance/DocumentUploadForm"
import { PayoutPanel } from "./PayoutPanel"
import { DEAL_EVIDENCE_DOC_TYPES } from "@/lib/asset-finance/payout-checklist"
import type { PayoutPanel as PayoutPanelData } from "@/lib/asset-finance/payout-view"

const panel = (entityId: string | null): PayoutPanelData => ({
  sureties: [], dealStatus: "CONTRACTED", entityId,
  checklist: [{
    item: "SUPPLIER_INVOICE_MATCHES_ASSET", label: "Invoice matches asset", required: true, evidenceTypes: [],
    confirmedAt: "2026-01-02T00:00:00.000Z", confirmedBy: "Officer", evidence: { id: "doc-9", fileName: "invoice.pdf" }, note: null,
  }],
  documents: [], payoutAmountCents: 100, dualApprovalThresholdCents: null, segregationOfDuties: false,
  approvedAccount: null, payout: null, loan: null, taxInvoice: null,
})

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

async function render(entityId: string | null): Promise<ReactTestInstance> {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let renderer!: ReturnType<typeof create>
  await act(async () => {
    renderer = create(<PayoutPanel dealId="deal-1" panel={panel(entityId)} canManage canDecide={false} userId="u1" />)
  })
  return renderer.root
}

const hrefs = (root: ReactTestInstance) => root.findAllByType("a").map((a) => a.props.href as string)

describe("PayoutPanel for an individual lessee", () => {
  it("links evidence through the deal-scoped route", async () => {
    expect(hrefs(await render(null))).toContain("/api/asset-finance/deals/deal-1/documents/doc-9")
  })

  it("offers the evidence upload, posting to the deal-scoped route without a dealId field", async () => {
    const form = (await render(null)).findByType(DocumentUploadForm)
    expect(form.props.apiBase).toBe("/api/asset-finance/deals/deal-1/documents")
    expect(form.props.dealId).toBeUndefined()
  })

  it("offers exactly the types the deal route validates, so the dropdown cannot drift from it", async () => {
    const form = (await render(null)).findByType(DocumentUploadForm)
    expect(form.props.docTypes).toEqual([...DEAL_EVIDENCE_DOC_TYPES])
  })
})

describe("PayoutPanel for an entity lessee", () => {
  it("links evidence through the entity route and uploads through the same deal route and list", async () => {
    const root = await render("ent-1")
    expect(hrefs(root)).toContain("/api/asset-finance/entities/ent-1/documents/doc-9")
    const form = root.findByType(DocumentUploadForm)
    expect(form.props.apiBase).toBe("/api/asset-finance/deals/deal-1/documents")
    expect(form.props.dealId).toBeUndefined()
    expect(form.props.docTypes).toEqual([...DEAL_EVIDENCE_DOC_TYPES])
  })
})
