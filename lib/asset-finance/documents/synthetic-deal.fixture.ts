// A synthetic deal for the document renderer tests and the evidence render
// (scripts/asset-finance/render-agreement-evidence.ts). Every name, number
// and identifier is obviously fake. The schedule is the real solver's output:
// an excavator on an annual seasonal structure with a 20% balloon at prime
// plus 1%.
import { annualSeasonal } from "../structure-presets"
import { solveStructure } from "../structure"
import { deriveRequiredSigners } from "../signing"
import type { DealDocumentData } from "./deal-document-data"

const PRIME = "0.1075"
const RATE = "0.1175"
const CASH_EXCL = 1_500_000_00
const VAT = 225_000_00
const DEPOSIT = 172_500_00
const BALLOON = 300_000_00

export function syntheticDealDocumentData(overrides: Partial<DealDocumentData> = {}): DealDocumentData {
  const solved = solveStructure({
    cashPriceCents: CASH_EXCL + VAT,
    depositCents: DEPOSIT,
    tradeInCents: 0,
    financedFeesCents: 0,
    balloonCents: BALLOON,
    weights: annualSeasonal(48, 1, [3, 4], 4, 0.5),
    startDate: "2026-12-31",
    firstDueDate: "2027-01-31",
    ratePath: [{ effectiveDate: "2026-12-31", annualRate: Number(RATE) }],
  })
  const relationships = [
    { clientId: "client-director", role: "DIRECTOR" as const, active: true },
    { clientId: "client-director", role: "SURETY" as const, active: true },
    { clientId: "client-surety", role: "SURETY" as const, active: true },
  ]
  return {
    isaCpaApplies: false,
    legalWordingApproved: false,
    ncaApplies: false,
    documentDate: new Date("2026-10-13T08:00:00.000Z"),
    reference: "AF-TEST-0001",
    lender: {
      legalName: "Test Asset Lender (Pty) Ltd",
      tradingName: "Test Asset Finance",
      companyRegNumber: "2000/000000/07",
      ncrNumber: "NCRCP00000",
      registeredOfficeLines: ["1 Test Street", "Testville", "0001"],
    },
    entity: {
      type: "COMPANY",
      legalName: "TEST Earthmoving (Pty) Ltd",
      tradingName: "TEST Plant",
      registrationNumber: "2099/000001/07",
      mastersReference: null,
      vatNumber: "4999999999",
      addressLines: ["2 Test Road", "Testburg", "Gauteng", "0002"],
    },
    asset: {
      classLabel: "Excavator",
      make: "TESTMAKE",
      model: "EX-200",
      year: 2026,
      serialNumber: "TESTSERIAL0001",
      vin: "TEST0000000000001",
      engineNumber: "TESTENGINE0001",
      registrationNumber: null,
    },
    supplier: { name: "TEST Plant Sales (Pty) Ltd", registrationNumber: "2099/000002/07", vatNumber: "4888888888" },
    pricing: {
      cashPriceExclVatCents: CASH_EXCL,
      vatCents: VAT,
      depositCents: DEPOSIT,
      tradeInCents: 0,
      financedFeesCents: 0,
      balloonCents: BALLOON,
      financedAmountCents: solved.financedAmountCents,
      baseInstalmentCents: solved.baseInstalmentCents,
      totalInterestCents: solved.totalInterestCents,
      totalPayableCents: solved.totalPayableCents,
      rateBasis: "PRIME",
      rateMargin: "0.01",
      fixedRate: null,
      annualRate: RATE,
      reference: { effectiveDate: "2026-05-29", rate: PRIME },
      structurePreset: "ANNUAL_SEASONAL",
      startDate: "2026-12-31",
      arrearsMarginRate: "0.02",
      collectionFeeCents: 45_000,
    },
    schedule: solved.rows,
    signatories: [{ clientId: "client-director", name: "TEST Director", idNumber: "0000000000001" }],
    sureties: [
      { clientId: "client-director", name: "TEST Director", idNumber: "0000000000001" },
      { clientId: "client-surety", name: "TEST Surety", idNumber: "0000000000002", addressLines: ["3 Test Surety Road", "Testville", "0003"] },
    ],
    requiredSigners: deriveRequiredSigners("COMPANY", relationships),
    ...overrides,
  }
}
