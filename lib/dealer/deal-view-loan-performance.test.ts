import { describe, expect, it, vi } from "vitest"
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
import { projectDealerDeal } from "./deal-view"
type Row = Parameters<typeof projectDealerDeal>[0]
const row = {
  id: "deal-1", createdAt: new Date("2026-01-01T08:00:00Z"), status: "BOOKED", dealerSubmittedAt: new Date("2026-01-01T09:00:00Z"),
  contractType: "INSTALMENT_SALE", baseInstalmentCents: 100_000, clientId: "c1",
  application: { reference: "AF-0001", appliedAmount: 10_000_000 },
  entity: null,
  client: { id: "c1", firstName: "TEST", lastName: "Borrower", createdByDealerId: "dealer-1" },
  asset: { make: "TEST", model: "M", year: 2025, serialNumber: "S1" },
  loan: { reference: "LN-0001", startDate: new Date("2026-01-05T00:00:00Z") },
  signers: [], checklist: [], dealerConsentAttestations: [], dealerDocumentRequests: [], documents: [],
  dealerCommissionLines: [
    { kind: "EARNED", effectiveOn: new Date("2026-01-05T00:00:00Z"), netCents: 1000, vatCents: 150, grossCents: 1150, reason: null },
    { kind: "REVERSED", effectiveOn: new Date("2026-06-05T00:00:00Z"), netCents: -1000, vatCents: -150, grossCents: -1150, reason: "LOAN_WRITTEN_OFF" },
  ],
} as unknown as Row
describe("dealer projection after booking", () => {
  it("does not tell the dealer the borrower's loan was written off", () => {
    const view = projectDealerDeal(row, "dealer-1")
    expect(view.borrower).toBe("TEST Borrower")
    expect(JSON.stringify(view)).not.toContain("WRITTEN_OFF")
  })
})
