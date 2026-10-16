/**
 * Synthetic values for the asset-finance demo seed (./asset-finance.ts). Every
 * name, number, VIN and ID here is invented: fictional but plausible names (a
 * prospect is shown them, so no "TEST" labels), 2099 registration years,
 * `.invalid` email domains. ID numbers are synthetic but pass the SA ID check
 * digit, so the client screens accept them.
 *
 * PORTAL PASSWORDS. As for every demo login, no password is in source: the
 * trustee's, director's and surety's portal passwords come from
 * SEED_AF_TRUSTEE_PASSWORD / SEED_AF_DIRECTOR_PASSWORD /
 * SEED_AF_SURETY_PASSWORD (set on every run when
 * given), else are generated when the client row is created and printed only
 * with SEED_PRINT_CREDENTIALS=1. The seed refuses NODE_ENV=production.
 * Emails are on the demo lender's client domain (prisma/demo-lender.ts), e.g.
 * for the default DEMO_LENDER=acme:
 *   Nandi Mthethwa  nandi.mthethwa@acme-lending.invalid  (DIRECTOR, AUTHORISED_SIGNATORY, SURETY)
 *   Kagiso Molefe   kagiso.molefe@acme-lending.invalid   (SURETY only: no entity access)
 */
import type { AssetClass } from "@prisma/client"
import { demoLender } from "../demo-lender"

export const AF_PRODUCT_CODE = "AF-IS"
export const PRIME = { basis: "PRIME", effectiveDate: "2025-01-01", rate: "0.1075" } as const
export const REPO = { basis: "REPO", effectiveDate: "2025-01-01", rate: "0.0825" } as const
export const VAT_VENDOR_NUMBER = "4999999999"

export const SUPPLIER = {
  name: "Kwela Plant Sales (Pty) Ltd",
  registrationNumber: "2099/000003/07",
  vatNumber: "4999999998",
  contactName: "Ayanda Mkhize",
  contactEmail: "sales@kwela-plant-sales.invalid",
  contactPhone: "+27 11 000 0099",
  address: "3 Steenbok Street, Boksburg North, 1459",
}
export const SUPPLIER_ACCOUNT = {
  bankName: "Highveld Merchant Bank",
  branchCode: "000099",
  accountNumber: "0000000099",
  accountHolder: "Kwela Plant Sales (Pty) Ltd",
  accountType: "CHEQUE",
}
export const SUPPLIER_ACCOUNT_NOTE =
  "Not run: company AVS unsupported. Verified manually against the bank-stamped confirmation letter on file."

export type AfPersonKey = "trusteeOne" | "trusteeTwo" | "director" | "surety"

export interface AfPerson {
  key: AfPersonKey
  reference: string
  firstName: string
  lastName: string
  idNumber: string
  dob: string
  gender: "MALE" | "FEMALE"
  phone: string
  /** Env var holding this client's portal password; null = no portal login. */
  portalPasswordEnv: "SEED_AF_TRUSTEE_PASSWORD" | "SEED_AF_DIRECTOR_PASSWORD" | "SEED_AF_SURETY_PASSWORD" | null
}

// References sort after the consumer demo clients (CLI-SEED-0001…), which
// prisma/seed-staging.ts takes by position.
export const PEOPLE: AfPerson[] = [
  { key: "trusteeOne", reference: "CLI-SEED-AF-0001", firstName: "Johan", lastName: "Botha", idNumber: "7001015000087", dob: "1970-01-01", gender: "MALE", phone: "+27700000101", portalPasswordEnv: "SEED_AF_TRUSTEE_PASSWORD" },
  { key: "trusteeTwo", reference: "CLI-SEED-AF-0002", firstName: "Willem", lastName: "Botha", idNumber: "7102025000081", dob: "1971-02-02", gender: "MALE", phone: "+27700000102", portalPasswordEnv: null },
  { key: "director", reference: "CLI-SEED-AF-0003", firstName: "Nandi", lastName: "Mthethwa", idNumber: "7203030000080", dob: "1972-03-03", gender: "FEMALE", phone: "+27700000103", portalPasswordEnv: "SEED_AF_DIRECTOR_PASSWORD" },
  { key: "surety", reference: "CLI-SEED-AF-0004", firstName: "Kagiso", lastName: "Molefe", idNumber: "7304045000089", dob: "1973-04-04", gender: "MALE", phone: "+27700000104", portalPasswordEnv: "SEED_AF_SURETY_PASSWORD" },
]

export const personEmail = (p: AfPerson) => `${p.firstName}.${p.lastName.replace(/ /g, ".")}@${demoLender().clientDomain}`.toLowerCase()

export const TRUST = {
  type: "TRUST",
  legalName: "Botha Family Farming Trust",
  registrationNumber: "IT 000001/2099",
  annualTurnover: 80_000_000, // R800 000
  financialYearEnd: "2026-02-28",
  addressLine1: "1 Rietvlei Farm Road",
  city: "Bethlehem",
  province: "Free State",
  postalCode: "9999",
} as const

export const COMPANY = {
  type: "COMPANY",
  legalName: "Ridgeback Earthmoving (Pty) Ltd",
  tradingName: "Ridgeback Earthmoving",
  registrationNumber: "2099/000001/07",
  vatNumber: "4999999997",
  // R25 000 000 in cents: 2.5e9 overflows INT4, the column is BIGINT (big-cents.ts).
  annualTurnover: 2_500_000_000,
  totalAssetValue: 1_800_000_000,
  financialYearEnd: "2026-02-28",
  addressLine1: "9 Quarry Road",
  city: "eMalahleni",
  province: "Mpumalanga",
  postalCode: "9998",
} as const

export interface AfAsset {
  assetClass: AssetClass
  make: string
  model: string
  year: number
  serialNumber: string
  vin: string | null
  engineNumber: string | null
  hours: number | null
  cashPriceExclVatCents: number
  vatCents: number
  insurer: string
  policyNumber: string
  trackerProvider: string
  trackerId: string
  lenderNotedConfirmed: boolean
}

// R1 725 000.00 incl. VAT: R1 500 000.00 + 15% VAT. Unregistered: no eNaTIS item.
export const EXCAVATOR: AfAsset = {
  assetClass: "EXCAVATOR", make: "Mabula", model: "EX-300", year: 2025,
  serialNumber: "MBEX0000000001", vin: "MBX00000000000001", engineNumber: "MBENG0000001", hours: 12,
  cashPriceExclVatCents: 150_000_000, vatCents: 22_500_000,
  insurer: "Umoya Insurance Ltd", policyNumber: "UMY-POL-0001", trackerProvider: "Kudu Tracking", trackerId: "KDT-0001",
  lenderNotedConfirmed: true,
}

// R345 000.00 incl. VAT, for the trust's NCA finance lease.
export const TRACTOR: AfAsset = {
  assetClass: "TRACTOR", make: "Mabula", model: "TR-90", year: 2025,
  serialNumber: "MBTR0000000001", vin: "MBX00000000000002", engineNumber: null, hours: 3,
  cashPriceExclVatCents: 30_000_000, vatCents: 4_500_000,
  insurer: "Umoya Insurance Ltd", policyNumber: "UMY-POL-0002", trackerProvider: "Kudu Tracking", trackerId: "KDT-0002",
  lenderNotedConfirmed: true,
}

// R575 000.00 incl. VAT, sole-proprietor NCA instalment sale.
export const TLB: AfAsset = {
  assetClass: "TLB", make: "Mabula", model: "TLB-4x4", year: 2025,
  serialNumber: "MBTLB000000001", vin: "MBX00000000000003", engineNumber: "MBENG0000003", hours: 8,
  cashPriceExclVatCents: 50_000_000, vatCents: 7_500_000,
  insurer: "Umoya Insurance Ltd", policyNumber: "UMY-POL-0003", trackerProvider: "Kudu Tracking", trackerId: "KDT-0003",
  lenderNotedConfirmed: true,
}

/** The company deal: 10% deposit, 20% balloon, 60 months, harvest Apr–Jun ×3, others ×0.5, PRIME + 1.00%. */
export const COMPANY_DEAL = {
  depositCents: 17_250_000,
  balloonCents: 34_500_000,
  preset: { kind: "ANNUAL_SEASONAL", periods: 60, seasonMonths: [4, 5, 6], seasonWeight: 3, offWeight: 0.5 },
  rateBasis: "PRIME",
  rateMargin: "0.0100",
} as const

export const CREDIT_MEMO = {
  periodEnd: "2026-02-28",
  turnoverCents: 2_500_000_000,
  ebitdaCents: 600_000_000,
  totalAssetsCents: 1_800_000_000,
  totalLiabilitiesCents: 700_000_000,
  existingDebtServiceCents: 120_000_000,
  avgMonthlyCreditsCents: 210_000_000,
  returnedDebitsCount: 0,
  notes: "Credit memo: audited AFS and six months of bank statements.",
}
