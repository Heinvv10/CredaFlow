import { describe, expect, it } from "vitest"
import {
  LenderIdentityError,
  getLenderBrandName,
  getLenderIdentity,
  parseLenderIdentity,
  parseNcrNumber,
  type LenderIdentityColumns,
} from "./identity"
import { VALID_LENDER_COLUMNS as VALID_COLUMNS } from "./__fixtures__/lender-identity"

function fieldsOf(fn: () => unknown): string[] {
  try {
    fn()
  } catch (e) {
    if (e instanceof LenderIdentityError) return e.fields
    throw e
  }
  throw new Error("expected LenderIdentityError, nothing was thrown")
}

describe("parseLenderIdentity", () => {
  it("returns the normalised identity for a complete, valid row", () => {
    const identity = parseLenderIdentity({ ...VALID_COLUMNS, ncrNumber: "  ncrcp99999 " })
    expect(identity).toMatchObject({
      legalName: "Acme Lending (Pty) Ltd",
      tradingName: "Acme Lending",
      ncrNumber: "NCRCP99999",
      fspNumber: "12345",
      companyRegNumber: "2020/123456/07",
      registeredOfficeLines: ["1 Main Road", "Sandton", "2196"],
      publicPhoneE164: "+27110000000",
      collectionsPhone: "+27 11 000 0001",
      publicWhatsapp: null,
    })
  })

  it("refuses when there is no config row at all, naming every required field", () => {
    for (const raw of [null, undefined, {}]) {
      expect(fieldsOf(() => parseLenderIdentity(raw))).toEqual(expect.arrayContaining([
        "legalName", "brandName", "ncrNumber", "fscaNumber", "companyRegNumber",
        "registeredOffice", "publicEmail", "publicPhone", "collectionsEmail", "collectionsPhone",
      ]))
    }
  })

  it.each([
    ["ncrNumber", null],
    ["ncrNumber", ""],
    ["ncrNumber", "NCR99999"],
    ["ncrNumber", "NCRCP"],
    ["ncrNumber", "NCRCP12a45"],
    ["ncrNumber", "NCRCP 99999"],
    ["fscaNumber", null],
    ["fscaNumber", "FSP12345"],
    ["fscaNumber", "12 345"],
    ["legalName", null],
    ["legalName", " "],
    ["legalName", "A"],
    ["legalName", "Acme\u0000Lending"],
    ["companyRegNumber", null],
    ["companyRegNumber", "2020/12345/07"],
    ["companyRegNumber", "2020-123456-07"],
    ["publicEmail", "not-an-email"],
    ["publicPhone", "011 000 0000"],
    ["collectionsPhone", "+27 11 000 000"],
    ["registeredOffice", ""],
    ["publicWhatsapp", "+1 555 0100"],
  ] as const)("refuses %s = %j", (field, value) => {
    expect(fieldsOf(() => parseLenderIdentity({ ...VALID_COLUMNS, [field]: value }))).toEqual([field])
  })
})

describe("parseNcrNumber", () => {
  it("accepts the NCRCP format and upper-cases it", () => {
    expect(parseNcrNumber(" ncrcp1234 ")).toBe("NCRCP1234")
  })

  it.each([null, undefined, "", "NCRCP", "NCR1234", "1234", 1234])("throws on %j", (value) => {
    expect(fieldsOf(() => parseNcrNumber(value))).toEqual(["ncrNumber"])
  })
})

function fakeDb(tenant: { name: string; config: Partial<LenderIdentityColumns> | null } | null) {
  return {
    tenant: {
      findUnique: async () => tenant,
    },
  }
}

describe("getLenderIdentity", () => {
  it("returns the tenant's own configured identity", async () => {
    const identity = await getLenderIdentity("t1", fakeDb({ name: "Acme", config: VALID_COLUMNS }))
    expect(identity.ncrNumber).toBe("NCRCP99999")
    expect(identity.legalName).toBe("Acme Lending (Pty) Ltd")
  })

  // F-11: the old resolver printed a hardcoded constant whatever the DB said.
  // With no constant left, an unconfigured tenant must get an error, never a
  // value from somewhere else.
  it("throws for an unconfigured tenant instead of returning any default", async () => {
    await expect(getLenderIdentity("t1", fakeDb({ name: "Acme", config: null })))
      .rejects.toBeInstanceOf(LenderIdentityError)
    await expect(getLenderIdentity("t1", fakeDb({ name: "Acme", config: {} })))
      .rejects.toBeInstanceOf(LenderIdentityError)
    await expect(getLenderIdentity("t1", fakeDb(null)))
      .rejects.toBeInstanceOf(LenderIdentityError)
  })

  it("throws when one statutory number is invalid, even if everything else is set", async () => {
    await expect(getLenderIdentity("t1", fakeDb({ name: "Acme", config: { ...VALID_COLUMNS, ncrNumber: "NCRCP99-999" } })))
      .rejects.toMatchObject({ fields: ["ncrNumber"] })
  })
})

describe("getLenderBrandName", () => {
  it("prefers the configured brand name", async () => {
    await expect(getLenderBrandName("t1", fakeDb({ name: "Tenant label", config: { brandName: "Acme" } })))
      .resolves.toBe("Acme")
  })

  it("falls back to the tenant's own name, not to a constant", async () => {
    await expect(getLenderBrandName("t1", fakeDb({ name: "Tenant label", config: null })))
      .resolves.toBe("Tenant label")
    await expect(getLenderBrandName("t1", fakeDb({ name: "Tenant label", config: { brandName: "  " } })))
      .resolves.toBe("Tenant label")
  })

  it("throws when the tenant does not exist", async () => {
    await expect(getLenderBrandName("t1", fakeDb(null))).rejects.toBeInstanceOf(LenderIdentityError)
  })
})
