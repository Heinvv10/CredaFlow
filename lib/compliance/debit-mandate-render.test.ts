import { describe, expect, it, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"

const { generateMock, logoMock } = vi.hoisted(() => ({ generateMock: vi.fn(async () => Buffer.from("%PDF")), logoMock: vi.fn() }))
vi.mock("@/lib/pdf/debitMandate", () => ({ generateDebitMandatePdf: generateMock }))
vi.mock("@/lib/config/identity", () => ({ getLenderIdentity: async () => ACME_LENDER }))
vi.mock("@/lib/config/lender-logo", () => ({ getLenderLogo: logoMock }))
vi.mock("@/lib/config/debit-mandate", () => ({
  assertDebitMandateCreditorTenant: () => undefined,
  getDebitMandateCreditorBankDetails: () => ({ bankName: "Provider Bank", accountNumber: "9876543210", branchCode: "250655" }),
}))

import { renderApplicationDebitMandatePdf } from "./debit-mandate.server"

// The application's mandate draft is fingerprinted when it is prepared, and
// the preview and the signature re-render it and compare. A tenant changing
// (or losing) its logo in between would make every pending mandate fail its
// integrity check, so this path prints the text letterhead regardless.
describe("renderApplicationDebitMandatePdf", () => {
  it("renders the same bytes whatever the tenant's current logo is", async () => {
    logoMock.mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    await renderApplicationDebitMandatePdf({
      tenant: { id: "t1" },
      application: { reference: "APP-1", client: { firstName: "Synthetic", lastName: "Customer", idNumber: "9001015009086", phone: null, email: null } },
      collectionReference: "COL-1",
      bankDetails: { bankName: "Test Bank", branchCode: "000001", accountNumber: "1234567890", accountType: "CHEQUE" },
      paymentTerms: {},
      generatedAt: new Date("2026-10-09T08:00:00Z"),
    } as unknown as Parameters<typeof renderApplicationDebitMandatePdf>[0])
    expect(generateMock).toHaveBeenCalledTimes(1)
    expect((generateMock.mock.calls[0] as unknown[])[0]).not.toHaveProperty("logo", expect.anything())
    expect(logoMock).not.toHaveBeenCalled()
  })
})
