import { beforeEach, describe, expect, it, vi } from "vitest"

// A borrower the dealer captures (a business, or a sole proprietor) carries
// its address: booking needs it for the tax invoice and it is fixed once the
// deal is approved, so a deal without one could never book (browser
// acceptance B2). A person captured into a business needs none.
const h = vi.hoisted(() => ({ createEntity: vi.fn(), transaction: vi.fn(), entity: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: h.transaction, businessEntity: { findFirst: h.entity } } }))
vi.mock("@/lib/audit-refusals", () => ({ auditRefusal: vi.fn() }))
vi.mock("@/lib/asset-finance/entity-create", () => ({ createBusinessEntity: h.createEntity }))

import { _resetRateLimitStore } from "@/lib/rate-limit"
import { captureDealerEntity, captureDealerPerson } from "./capture"

const actor = { tenantId: "tenant-1", dealerId: "dealer-1", dealerUserId: "du-1", email: "sales@dealer.invalid", dealerRole: "DEALER_SALES" as const }
const company = { type: "COMPANY", legalName: "TEST Plant (Pty) Ltd", registrationNumber: "2099/000001/07" }
const address = { addressLine1: "1 Synthetic Road", city: "Testville", province: "Gauteng", postalCode: "0001" }
const person = { idNumber: "8001015009087", firstName: "TEST", lastName: "Owner", email: "owner@client.invalid", phone: "+27820000000" }

beforeEach(() => {
  vi.clearAllMocks()
  _resetRateLimitStore()
  h.createEntity.mockResolvedValue({ kind: "created", id: "e-1" })
  h.transaction.mockResolvedValue("c-1")
  h.entity.mockResolvedValue({ id: "e-1", type: "COMPANY" })
})

describe("dealer borrower address", () => {
  it("refuses a business without its address, and passes the address through", async () => {
    expect(await captureDealerEntity(actor, company)).toMatchObject({ kind: "invalid", fields: { addressLine1: expect.any(String), city: expect.any(String) } })
    expect(h.createEntity).not.toHaveBeenCalled()
    expect(await captureDealerEntity(actor, { ...company, ...address })).toEqual({ kind: "created", id: "e-1" })
    expect(h.createEntity.mock.calls[0][1]).toMatchObject(address)
  })

  it("refuses a sole proprietor without an address or with a bad postal code; a person of a business needs none", async () => {
    expect(await captureDealerPerson(actor, person)).toMatchObject({ kind: "invalid", fields: { addressLine1: expect.any(String), city: expect.any(String) } })
    expect(await captureDealerPerson(actor, { ...person, ...address, postalCode: "12" })).toMatchObject({ kind: "invalid", fields: { postalCode: "Four digits" } })
    expect(h.transaction).not.toHaveBeenCalled()
    expect(await captureDealerPerson(actor, { ...person, ...address })).toEqual({ kind: "created", id: "c-1" })
    expect(await captureDealerPerson(actor, { ...person, roles: ["DIRECTOR"] }, "e-1")).toEqual({ kind: "created", id: "c-1" })
  })
})
