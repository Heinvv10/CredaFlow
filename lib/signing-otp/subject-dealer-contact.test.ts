import { beforeEach, describe, expect, it, vi } from "vitest"

// No signing code goes to contact details a dealer typed until a staff
// member verifies them: the email could be the dealer's own (review S1).
const h = vi.hoisted(() => ({ signer: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { dealSigner: { findFirst: h.signer } } }))

import { resolveSigningSubject } from "./subject"

const signer = (client: Record<string, unknown>) => ({
  clientId: "c-1", method: null, documentSha256: "a".repeat(64), deal: { status: "APPROVED" },
  client: { firstName: "TEST", lastName: "Borrower", email: "borrower@client.invalid", whatsapp: null, ...client },
})

beforeEach(() => h.signer.mockReset())

describe("resolveSigningSubject and dealer-captured contact details", () => {
  it("refuses a dealer-captured client whose contact details staff have not verified", async () => {
    h.signer.mockResolvedValue(signer({ createdByDealerId: "dealer-1", dealerContactVerifiedAt: null }))
    expect(await resolveSigningSubject("tenant-1", "DEAL_DOCUMENT", "signer-1")).toMatchObject({ ok: false, status: 409 })
  })

  it("resolves once they are verified, and for a client the lender captured", async () => {
    h.signer.mockResolvedValue(signer({ createdByDealerId: "dealer-1", dealerContactVerifiedAt: new Date("2026-10-19T10:00:00Z") }))
    expect(await resolveSigningSubject("tenant-1", "DEAL_DOCUMENT", "signer-1")).toMatchObject({ ok: true, subject: { clientId: "c-1" } })
    h.signer.mockResolvedValue(signer({ createdByDealerId: null, dealerContactVerifiedAt: null }))
    expect(await resolveSigningSubject("tenant-1", "DEAL_DOCUMENT", "signer-1")).toMatchObject({ ok: true })
  })
})
