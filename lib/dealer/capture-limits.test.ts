import { beforeEach, describe, expect, it, vi } from "vitest"

// Capture is an existence oracle by design (409 "already on the lender's
// book"): each such refusal is audited and every dealer user's captures are
// rate limited (review S3).
const h = vi.hoisted(() => ({ createEntity: vi.fn(), auditRefusal: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/audit-refusals", () => ({ auditRefusal: h.auditRefusal }))
vi.mock("@/lib/asset-finance/entity-create", () => ({ createBusinessEntity: h.createEntity }))

import { _resetRateLimitStore } from "@/lib/rate-limit"
import { captureDealerEntity, DEALER_CAPTURE_RATE_LIMIT } from "./capture"

const actor = { tenantId: "tenant-1", dealerId: "dealer-1", dealerUserId: "du-1", email: "sales@dealer.invalid", dealerRole: "DEALER_SALES" as const }
const company = { type: "COMPANY", legalName: "TEST Plant (Pty) Ltd", registrationNumber: "2099/000001/07" }

beforeEach(() => {
  vi.clearAllMocks()
  _resetRateLimitStore()
  h.createEntity.mockResolvedValue({ kind: "created", id: "e-1" })
})

describe("dealer capture limits", () => {
  it("audits a refusal for a row already on the lender's book, naming the dealer user and not the values typed", async () => {
    h.createEntity.mockResolvedValue({ kind: "duplicate" })
    expect(await captureDealerEntity(actor, company)).toMatchObject({ kind: "refused", status: 409 })
    expect(h.auditRefusal).toHaveBeenCalledTimes(1)
    const row = h.auditRefusal.mock.calls[0][0]
    expect(row).toMatchObject({
      action: "DEALER_CAPTURE_REFUSED_ON_BOOK", tenantId: "tenant-1", userEmail: "sales@dealer.invalid", status: 409,
      detail: { captured: "entity", actor: { type: "dealer", dealerId: "dealer-1", dealerUserId: "du-1" } },
    })
    expect(JSON.stringify(row)).not.toContain("2099/000001/07")
  })

  it("refuses a dealer user's captures beyond the window's limit (429), per user", async () => {
    for (let i = 0; i < DEALER_CAPTURE_RATE_LIMIT.limit; i++) expect((await captureDealerEntity(actor, company)).kind).toBe("created")
    expect(await captureDealerEntity(actor, company)).toMatchObject({ kind: "refused", status: 429 })
    expect(h.createEntity).toHaveBeenCalledTimes(DEALER_CAPTURE_RATE_LIMIT.limit)
    expect((await captureDealerEntity({ ...actor, dealerUserId: "du-2" }, company)).kind).toBe("created")
  })
})
