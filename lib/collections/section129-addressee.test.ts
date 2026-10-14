import { describe, expect, it } from "vitest"
import { section129Addressee } from "./section129-addressee"

describe("section129Addressee", () => {
  it("preserves the consumer addressee fields", () => {
    expect(section129Addressee({
      clientId: "client-1", entityId: null,
      client: { firstName: "Test", lastName: "Borrower", idNumber: "9000000000000", addressLine1: "1 Test Road", city: "Johannesburg", email: "borrower@example.test" },
      entity: null,
    })).toMatchObject({ displayName: "Test Borrower", identityLabel: "ID", lockClientId: "client-1", lockEntityId: null })
  })

  it("addresses the entity at its registered address and delivers to an active authorised contact", () => {
    expect(section129Addressee({
      clientId: null, entityId: "entity-1", client: null,
      entity: {
        legalName: "TEST Farming Trust", registrationNumber: "IT000001/2026", addressLine1: "2 Test Farm", city: "Bothaville",
        relationships: [
          { client: { id: "dead", email: "dead@example.test", deceasedAt: new Date() } },
          { client: { id: "trustee", email: "trustee@example.test", deceasedAt: null } },
        ],
      },
    })).toEqual({
      displayName: "TEST Farming Trust", firstName: "TEST Farming Trust", lastName: "",
      identityNumber: "IT000001/2026", identityLabel: "Registration no.",
      addressLine1: "2 Test Farm", city: "Bothaville", email: "trustee@example.test",
      lockClientId: "trustee", lockEntityId: "entity-1",
    })
  })

  it("refuses an entity with no live authorised delivery contact", () => {
    expect(section129Addressee({
      clientId: null, entityId: "entity-1", client: null,
      entity: { legalName: "TEST CC", registrationNumber: "CK1", addressLine1: null, city: null, relationships: [] },
    })).toBeNull()
  })
})
