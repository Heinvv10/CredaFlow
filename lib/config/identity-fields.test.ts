import { describe, expect, it } from "vitest"
import { LenderIdentityError, parseLenderIdentity, requireLenderIdentityFields, validateLenderIdentityColumns } from "./identity-schema"
import { ACME_LENDER, VALID_LENDER_COLUMNS } from "./__fixtures__/lender-identity"

function fieldsOf(fn: () => unknown): string[] {
  try {
    fn()
  } catch (e) {
    if (e instanceof LenderIdentityError) return e.fields
    throw e
  }
  throw new Error("expected LenderIdentityError, nothing was thrown")
}

describe("ACME_LENDER fixture", () => {
  it("is exactly what parseLenderIdentity returns for VALID_LENDER_COLUMNS", () => {
    expect(parseLenderIdentity(VALID_LENDER_COLUMNS)).toEqual(ACME_LENDER)
  })
})

// What an NCA document is about to print, re-validated at the document, so a
// caller that hand-builds an identity cannot get a wrong number onto paper.
describe("requireLenderIdentityFields", () => {
  it("returns exactly the requested fields of a valid identity", () => {
    expect(requireLenderIdentityFields(ACME_LENDER, ["legalName", "ncrNumber", "registeredOfficeLines"])).toEqual({
      legalName: "Acme Lending (Pty) Ltd",
      ncrNumber: "NCRCP99999",
      registeredOfficeLines: ["1 Main Road", "Sandton", "2196"],
    })
  })

  it("names every missing required field by its column, when there is no identity at all", () => {
    for (const raw of [undefined, null, {}]) {
      expect(fieldsOf(() => requireLenderIdentityFields(raw, ["legalName", "ncrNumber", "fspNumber", "companyRegNumber"])))
        .toEqual(["legalName", "ncrNumber", "fscaNumber", "companyRegNumber"])
    }
  })

  // An optional column may be null in the identity, but a document that asks
  // for the FSP number prints it: null there must refuse, never print "null".
  it("refuses a null FSP number when one is asked for", () => {
    expect(fieldsOf(() => requireLenderIdentityFields({ ...ACME_LENDER, fspNumber: null }, ["legalName", "fspNumber"])))
      .toEqual(["fscaNumber"])
  })

  it.each([
    ["ncrNumber", "NCRCP"],
    ["ncrNumber", "ncrcp99999"], // valid once normalised, but would print as given
    ["ncrNumber", " NCRCP99999"],
    ["fspNumber", "FSP 12345"],
    ["companyRegNumber", "2020/12345/07"],
    ["legalName", "Acme\nLending"],
    ["legalName", "A"],
    ["collectionsEmail", "not-an-email"],
    ["collectionsPhone", "011 000 0001"],
    ["collectionsPhoneSecondary", "12345"],
    ["brandTagline", "x".repeat(61)],
  ] as const)("refuses an invalid %s (%j)", (field, value) => {
    expect(() => requireLenderIdentityFields({ ...ACME_LENDER, [field]: value }, [field])).toThrow(LenderIdentityError)
  })

  it.each([
    [[]],
    [["1 Main Road", ""]],
    [["x".repeat(81)]],
    [["1", "2", "3", "4", "5", "6", "7"]],
    ["1 Main Road"],
  ])("refuses an invalid registered office %j", (lines) => {
    expect(fieldsOf(() => requireLenderIdentityFields({ ...ACME_LENDER, registeredOfficeLines: lines as never }, ["registeredOfficeLines"])))
      .toEqual(["registeredOffice"])
  })

  it("refuses an office line that hides a line break", () => {
    expect(fieldsOf(() => requireLenderIdentityFields(
      { ...ACME_LENDER, registeredOfficeLines: ["1 Main Road\nSandton", "2196"] }, ["registeredOfficeLines"],
    ))).toEqual(["registeredOffice"])
  })

  it("accepts null for the optional fields and returns null", () => {
    expect(requireLenderIdentityFields(
      { ...ACME_LENDER, collectionsPhoneSecondary: null, brandTagline: null },
      ["collectionsPhoneSecondary", "brandTagline"],
    )).toEqual({ collectionsPhoneSecondary: null, brandTagline: null })
  })

  it("accepts set optional fields", () => {
    expect(requireLenderIdentityFields(
      { ...ACME_LENDER, collectionsPhoneSecondary: "+27 82 000 0002", brandTagline: "Credit made simple" },
      ["collectionsPhoneSecondary", "brandTagline"],
    )).toEqual({ collectionsPhoneSecondary: "+27 82 000 0002", brandTagline: "Credit made simple" })
  })
})

// The NCA documents print with the PDF standard fonts, which encode WinAnsi
// only; anything else crashes the render with a plain Error after the user
// has asked for a statutory document. Refused at validation instead, so the
// writer never stores it and the document reports a LenderIdentityError.
describe("text the documents cannot print", () => {
  it.each([
    ["legalName", "Ōmega Lending (Pty) Ltd"],
    ["legalName", "Acme \u{1F600} (Pty) Ltd"],
    ["brandTagline", "Ōmega"],
    ["tradingName", "Łódź Lending"],
  ] as const)("refuses %s %j", (field, value) => {
    expect(() => requireLenderIdentityFields({ ...ACME_LENDER, [field]: value }, [field])).toThrow(LenderIdentityError)
  })

  it("refuses an office line the documents cannot print", () => {
    expect(() => requireLenderIdentityFields({ ...ACME_LENDER, registeredOfficeLines: ["1 Łódź Road", "2196"] }, ["registeredOfficeLines"]))
      .toThrow(LenderIdentityError)
  })

  it("the writer's validation refuses it too", () => {
    expect(validateLenderIdentityColumns({ ...VALID_LENDER_COLUMNS, legalName: "Ōmega Lending (Pty) Ltd" }))
      .toMatchObject({ ok: false, errors: { legalName: expect.any(String) } })
  })

  it("accepts Latin-1 and the typographic marks WinAnsi does carry", () => {
    expect(requireLenderIdentityFields(
      { ...ACME_LENDER, legalName: "Café Crème Lending (Pty) Ltd", registeredOfficeLines: ["Office 2 – Rosebank’s Corner", "0181"] },
      ["legalName", "registeredOfficeLines"],
    )).toMatchObject({ legalName: "Café Crème Lending (Pty) Ltd" })
  })
})
