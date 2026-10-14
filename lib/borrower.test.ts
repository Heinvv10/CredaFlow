import { describe, expect, it } from "vitest"
import {
  borrowerDisplayName,
  EntityBorrowerError,
  hasClientBorrower,
  hasClientBorrowerId,
  isEntityBorrowerError,
  requireClientBorrower,
  requireClientBorrowerId,
  requireClientBorrowerRow,
} from "./borrower"

const client = { firstName: "Thandi", lastName: "Mocktest" }
const consumerRow = { id: "loan-c", clientId: "client-1", client }
const entityRow = { id: "loan-e", clientId: null, client: null }

describe("EntityBorrowerError", () => {
  it("is a 409 with a message saying the action is for consumer borrowers", () => {
    const error = new EntityBorrowerError()
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("EntityBorrowerError")
    expect(error.status).toBe(409)
    expect(error.message).toMatch(/individual \(consumer\) borrowers only/)
    expect(new EntityBorrowerError("custom").message).toBe("custom")
  })
})

describe("requireClientBorrower", () => {
  it("returns the Client of a consumer row", () => {
    expect(requireClientBorrower(consumerRow)).toBe(client)
  })

  it("refuses an entity row with EntityBorrowerError", () => {
    expect(() => requireClientBorrower(entityRow)).toThrow(EntityBorrowerError)
  })
})

describe("requireClientBorrowerId", () => {
  it("returns the clientId of a consumer row", () => {
    expect(requireClientBorrowerId({ clientId: "client-1" })).toBe("client-1")
  })

  it("refuses an entity row with EntityBorrowerError", () => {
    expect(() => requireClientBorrowerId({ clientId: null })).toThrow(EntityBorrowerError)
  })
})

describe("hasClientBorrower", () => {
  it("keeps consumer rows and drops entity rows", () => {
    expect([consumerRow, entityRow].filter(hasClientBorrower)).toEqual([consumerRow])
  })

  it("drops a row whose client was not loaded (undefined) or whose clientId is null", () => {
    expect(hasClientBorrower({ client: undefined })).toBe(false)
    expect(hasClientBorrower({ client, clientId: null })).toBe(false)
  })

  it("accepts a row that selects client but not clientId", () => {
    expect(hasClientBorrower({ client })).toBe(true)
  })
})

describe("hasClientBorrowerId", () => {
  it("keeps rows with a clientId and drops entity rows", () => {
    expect([{ clientId: "client-1" }, { clientId: null }].filter(hasClientBorrowerId)).toEqual([{ clientId: "client-1" }])
  })
})

describe("requireClientBorrowerRow", () => {
  it("returns the same consumer row, narrowed", () => {
    const row = requireClientBorrowerRow(consumerRow)
    expect(row).toBe(consumerRow)
    expect(row.client.firstName).toBe("Thandi")
  })

  it("refuses an entity row with EntityBorrowerError", () => {
    expect(() => requireClientBorrowerRow(entityRow)).toThrow(EntityBorrowerError)
  })
})

describe("isEntityBorrowerError", () => {
  it("recognises only EntityBorrowerError", () => {
    expect(isEntityBorrowerError(new EntityBorrowerError())).toBe(true)
    expect(isEntityBorrowerError(new Error("other"))).toBe(false)
    expect(isEntityBorrowerError("EntityBorrowerError")).toBe(false)
  })
})

describe("borrowerDisplayName", () => {
  it("names the person, else the entity, else says the borrower is unknown", () => {
    expect(borrowerDisplayName({ client })).toBe("Thandi Mocktest")
    expect(borrowerDisplayName({ client: null, entity: { legalName: "TEST Plant Hire (Pty) Ltd" } })).toBe("TEST Plant Hire (Pty) Ltd")
    expect(borrowerDisplayName({ client: null, entity: null })).toBe("Unknown borrower")
    expect(borrowerDisplayName({})).toBe("Unknown borrower")
  })

  it("prefers the person when a row somehow carries both", () => {
    expect(borrowerDisplayName({ client, entity: { legalName: "TEST Co" } })).toBe("Thandi Mocktest")
  })

  it("trims a name with an empty part", () => {
    expect(borrowerDisplayName({ client: { firstName: "Thandi", lastName: "" } })).toBe("Thandi")
  })
})
