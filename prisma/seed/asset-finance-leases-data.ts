/**
 * Synthetic values for the lease part of the asset-finance demo seed
 * (./asset-finance-leases.ts). Same rules as ./asset-finance-data.ts: "TEST"
 * names, `.invalid` emails, invented serials and an ID number that is
 * obviously synthetic but passes the SA ID check digit.
 *
 * Three leases, each priced by the real lease pricing from PRIME + 1.00%
 * (the approved PRIME of the base seed), 8% rental escalation:
 *   1. company full-maintenance lease on a TLB (maintenance risk with the lender)
 *   2. sole-proprietor operating lease on a bakkie (CPA applies)
 *   3. trust full-maintenance lease on a forklift (fund settled by the lessee),
 *      5 rentals, so its end-of-term choice is open from the day it is booked
 */
import type { AfAsset } from "./asset-finance-data"

export const LEASE_PRODUCT_CODE = "AF-LEASE"

export type LeaseKey = "companyFml" | "soleOl" | "trustFml"

export interface LeaseAsset extends AfAsset {
  registrationNumber: string | null
  odometerKm: number | null
  /** Set to the lender's legal name by the seed on a registered vehicle (the lessor owns it). */
  natisTitleholder: string | null
  natisOwner: string | null
}

// R450 000 ex VAT + 15% VAT. Unregistered: no eNaTIS item. Usage in HOURS from `hours`.
export const LEASE_TLB: LeaseAsset = {
  assetClass: "TLB", make: "Mabula", model: "TLB-4x4 L", year: 2025,
  serialNumber: "MBTLB000000002", vin: "MBX00000000000004", engineNumber: "MBENG0000004", hours: 40,
  cashPriceExclVatCents: 45_000_000, vatCents: 6_750_000,
  insurer: "Umoya Insurance Ltd", policyNumber: "UMY-POL-0004", trackerProvider: "Kudu Tracking", trackerId: "KDT-0004",
  lenderNotedConfirmed: true, registrationNumber: null, odometerKm: null, natisTitleholder: null, natisOwner: null,
}

// R400 000 ex VAT + 15% VAT; registered, so the eNaTIS owner and titleholder are the lender.
export const LEASE_BAKKIE: LeaseAsset = {
  assetClass: "LIGHT_COMMERCIAL", make: "Kudu Motors", model: "Bakkie 2.4", year: 2025,
  serialNumber: "KMBAK000000001", vin: "MBX00000000000005", engineNumber: "MBENG0000005", hours: null,
  cashPriceExclVatCents: 40_000_000, vatCents: 6_000_000,
  insurer: "Umoya Insurance Ltd", policyNumber: "UMY-POL-0005", trackerProvider: "Kudu Tracking", trackerId: "KDT-0005",
  lenderNotedConfirmed: true, registrationNumber: "DEMO001GP", odometerKm: 1_500, natisTitleholder: null, natisOwner: null,
}

// R200 000 ex VAT + 15% VAT; unregistered.
export const LEASE_FORKLIFT: LeaseAsset = {
  assetClass: "FORKLIFT", make: "Mabula", model: "FL-35", year: 2025,
  serialNumber: "MBFLK000000001", vin: null, engineNumber: null, hours: 400,
  cashPriceExclVatCents: 20_000_000, vatCents: 3_000_000,
  insurer: "Umoya Insurance Ltd", policyNumber: "UMY-POL-0006", trackerProvider: "Kudu Tracking", trackerId: "KDT-0006",
  lenderNotedConfirmed: true, registrationNumber: null, odometerKm: null, natisTitleholder: null, natisOwner: null,
}

// ID 7405055000081: a synthetic number with a valid check digit; reference sorts after the other AF people.
export const LEASE_SOLE_PROP = {
  reference: "CLI-SEED-AF-0005", idNumber: "7405055000081", firstName: "Zanele", lastName: "Baker",
  dob: "1974-05-05", gender: "FEMALE", phone: "+27700000105",
} as const

export interface LeaseSpec {
  key: LeaseKey
  contractType: "OPERATING_LEASE" | "FULL_MAINTENANCE_LEASE"
  rentalTiming: "ADVANCE" | "ARREARS"
  periods: number
  residualCents: number
  /** Present on a full-maintenance lease only. */
  fml: {
    maintenanceMonthlyExclVatCents: number
    maintenanceRiskModel: "LENDER_RISK" | "LESSEE_SETTLED"
    usageAllowancePerYear: number
    usageUnit: "HOURS"
    excessRateCents: number
  } | null
  /** Rentals paid by an early receipt after booking, which invoices each (supply date = the receipt). */
  rentalsPaidEarly: number
  memo: { turnoverCents: number; ebitdaCents: number; totalAssetsCents: number; totalLiabilitiesCents: number; existingDebtServiceCents: number; avgMonthlyCreditsCents: number }
}

export const LEASES: Record<LeaseKey, LeaseSpec> = {
  companyFml: {
    key: "companyFml", contractType: "FULL_MAINTENANCE_LEASE", rentalTiming: "ARREARS", periods: 36, residualCents: 15_000_000,
    fml: { maintenanceMonthlyExclVatCents: 450_000, maintenanceRiskModel: "LENDER_RISK", usageAllowancePerYear: 1_500, usageUnit: "HOURS", excessRateCents: 35_000 },
    rentalsPaidEarly: 3,
    memo: { turnoverCents: 2_500_000_000, ebitdaCents: 600_000_000, totalAssetsCents: 1_800_000_000, totalLiabilitiesCents: 700_000_000, existingDebtServiceCents: 120_000_000, avgMonthlyCreditsCents: 210_000_000 },
  },
  soleOl: {
    key: "soleOl", contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", periods: 36, residualCents: 12_000_000,
    fml: null, rentalsPaidEarly: 1,
    memo: { turnoverCents: 90_000_000, ebitdaCents: 24_000_000, totalAssetsCents: 60_000_000, totalLiabilitiesCents: 10_000_000, existingDebtServiceCents: 1_000_000, avgMonthlyCreditsCents: 7_500_000 },
  },
  trustFml: {
    key: "trustFml", contractType: "FULL_MAINTENANCE_LEASE", rentalTiming: "ARREARS", periods: 5, residualCents: 10_000_000,
    fml: { maintenanceMonthlyExclVatCents: 250_000, maintenanceRiskModel: "LESSEE_SETTLED", usageAllowancePerYear: 1_200, usageUnit: "HOURS", excessRateCents: 30_000 },
    rentalsPaidEarly: 1,
    memo: { turnoverCents: 80_000_000, ebitdaCents: 24_000_000, totalAssetsCents: 90_000_000, totalLiabilitiesCents: 10_000_000, existingDebtServiceCents: 1_000_000, avgMonthlyCreditsCents: 6_500_000 },
  },
}
