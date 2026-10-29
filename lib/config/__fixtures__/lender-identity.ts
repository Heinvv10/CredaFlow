import type { LenderIdentity, LenderIdentityColumns } from "../identity"

/** A neutral demo lender. None of these is a real registration. */
export const VALID_LENDER_COLUMNS: LenderIdentityColumns = {
  legalName: "Acme Lending (Pty) Ltd",
  brandName: "Acme Lending",
  ncrNumber: "NCRCP99999",
  fscaNumber: "12345",
  companyRegNumber: "2020/123456/07",
  registeredOffice: "1 Main Road\nSandton\n2196",
  publicEmail: "hello@acme-lending.example",
  publicPhone: "+27 11 000 0000",
  publicWhatsapp: null,
  collectionsEmail: "collections@acme-lending.example",
  collectionsPhone: "+27 11 000 0001",
  collectionsPhoneSecondary: null,
  brandTagline: null,
  ncrRegistrationDate: null,
  fscaAuthorisationDate: null,
  ncrStatus: null,
  headOfficeCity: null,
}

/** `VALID_LENDER_COLUMNS` as `parseLenderIdentity` returns it (a test pins the
 *  equality). Literal rather than computed so this file imports no runtime
 *  module: tests load it from inside `vi.mock` factories of identity.ts. */
export const ACME_LENDER: LenderIdentity & { ncrNumber: string } = {
  legalName: "Acme Lending (Pty) Ltd",
  tradingName: "Acme Lending",
  ncrNumber: "NCRCP99999",
  fspNumber: "12345",
  companyRegNumber: "2020/123456/07",
  registeredOfficeLines: ["1 Main Road", "Sandton", "2196"],
  publicEmail: "hello@acme-lending.example",
  publicPhone: "+27 11 000 0000",
  publicPhoneE164: "+27110000000",
  publicWhatsapp: null,
  publicWhatsappE164: null,
  collectionsEmail: "collections@acme-lending.example",
  collectionsPhone: "+27 11 000 0001",
  collectionsPhoneSecondary: null,
  brandTagline: null,
  ncrRegistrationDate: null,
  fscaAuthorisationDate: null,
  ncrStatus: null,
  headOfficeCity: null,
}
