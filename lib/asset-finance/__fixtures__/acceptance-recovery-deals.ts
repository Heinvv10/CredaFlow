/**
 * Slice-4 recovery acceptance deals: synthetic recoveries, two per route,
 * worked INDEPENDENTLY of lib/asset-finance/recovery-*.ts in exact rational
 * arithmetic (a script, not the code under test). Asserted by
 * lib/asset-finance/acceptance-recovery-deals.test.ts. Every figure is
 * synthetic integer cents. CLIENT_DEALS in ./acceptance-deals.ts stays empty.
 *
 * Rules applied (VAT rate 15%, half-up rounding once per figure):
 *   cost vat        = round(net × 1500 / 10000); gross = net + vat
 *   deducted        = Σ gross of DEDUCT_FROM_PROCEEDS costs
 *   charged         = Σ gross of CHARGE_TO_ACCOUNT costs
 *   net proceeds    = gross proceeds − deducted
 *   owed            = settlement due + charged
 *   shortfall       = max(0, owed − net);  surplus = max(0, net − owed)
 *   payment         = min(net, settlement due)   (the Payment on the loan)
 *   repossession    (instalment sale, finance lease): s8(10) deemed supply,
 *                   value = min(unpaid cash price, cash price incl. VAT),
 *                   input tax = round(value × 1500 / 11500)
 *   lessor resale   (operating, full-maintenance lease): no deemed supply
 *   resale invoice  vat = round(price × 1500 / 11500); excl = price − vat
 *
 * UNTESTED: the legal (cost treatment) and tax (s8(10)/s10(10)) rules await
 * the lender's legal team and tax adviser.
 */
export type RecoveryRouteName = "NCA_S127_SURRENDER" | "NCA_S131_ATTACHMENT" | "NON_NCA_VOLUNTARY" | "NON_NCA_COURT_ORDER"
export type RecoveryContractType = "INSTALMENT_SALE" | "FINANCE_LEASE" | "OPERATING_LEASE" | "FULL_MAINTENANCE_LEASE"

export interface AcceptanceRecoveryCost {
  type: string
  netCents: number
  vatCents: number
  grossCents: number
  treatment: "DEDUCT_FROM_PROCEEDS" | "CHARGE_TO_ACCOUNT"
}

export interface AcceptanceRecoveryDeal {
  id: string
  route: RecoveryRouteName
  contractType: RecoveryContractType
  debtorVatVendor: boolean
  settlementDueCents: number
  unpaidCashPriceCents: number
  cashPriceInclVatCents: number
  grossProceedsCents: number
  costs: AcceptanceRecoveryCost[]
  expected: {
    deductedCostsCents: number
    chargedCostsCents: number
    netProceedsCents: number
    paymentCents: number
    shortfallCents: number
    surplusCents: number
    vat: { kind: "REPOSSESSION_DEEMED_SUPPLY" | "LESSOR_RESALE"; deemedSupplyValueCents: number; inputTaxClaimCents: number }
    resale: { exclVatCents: number; vatCents: number }
  }
}

export const RECOVERY_DEALS: AcceptanceRecoveryDeal[] = [
  {
    id: "REC-S127-1", route: "NCA_S127_SURRENDER", contractType: "INSTALMENT_SALE", debtorVatVendor: false,
    settlementDueCents: 48213377, unpaidCashPriceCents: 41500000, cashPriceInclVatCents: 92000000, grossProceedsCents: 40000000,
    costs: [
      { type: "TOWING", netCents: 450000, vatCents: 67500, grossCents: 517500, treatment: "DEDUCT_FROM_PROCEEDS" },
      { type: "STORAGE", netCents: 180000, vatCents: 27000, grossCents: 207000, treatment: "DEDUCT_FROM_PROCEEDS" },
      { type: "AUCTION_COMMISSION", netCents: 2000000, vatCents: 300000, grossCents: 2300000, treatment: "DEDUCT_FROM_PROCEEDS" },
    ],
    expected: {
      deductedCostsCents: 3024500, chargedCostsCents: 0, netProceedsCents: 36975500, paymentCents: 36975500,
      shortfallCents: 11237877, surplusCents: 0,
      vat: { kind: "REPOSSESSION_DEEMED_SUPPLY", deemedSupplyValueCents: 41500000, inputTaxClaimCents: 5413043 },
      resale: { exclVatCents: 34782609, vatCents: 5217391 },
    },
  },
  {
    id: "REC-S127-2", route: "NCA_S127_SURRENDER", contractType: "FINANCE_LEASE", debtorVatVendor: true,
    settlementDueCents: 12005019, unpaidCashPriceCents: 10250033, cashPriceInclVatCents: 34500000, grossProceedsCents: 15500000,
    costs: [
      { type: "VALUATION", netCents: 95000, vatCents: 14250, grossCents: 109250, treatment: "DEDUCT_FROM_PROCEEDS" },
    ],
    expected: {
      deductedCostsCents: 109250, chargedCostsCents: 0, netProceedsCents: 15390750, paymentCents: 12005019,
      shortfallCents: 0, surplusCents: 3385731,
      vat: { kind: "REPOSSESSION_DEEMED_SUPPLY", deemedSupplyValueCents: 10250033, inputTaxClaimCents: 1336961 },
      resale: { exclVatCents: 13478261, vatCents: 2021739 },
    },
  },
  {
    id: "REC-S131-1", route: "NCA_S131_ATTACHMENT", contractType: "INSTALMENT_SALE", debtorVatVendor: false,
    settlementDueCents: 63337891, unpaidCashPriceCents: 55010101, cashPriceInclVatCents: 115000000, grossProceedsCents: 51750000,
    costs: [
      { type: "SHERIFF", netCents: 312550, vatCents: 46883, grossCents: 359433, treatment: "DEDUCT_FROM_PROCEEDS" },
      { type: "TOWING", netCents: 600000, vatCents: 90000, grossCents: 690000, treatment: "DEDUCT_FROM_PROCEEDS" },
      { type: "LEGAL_TAXED", netCents: 1850000, vatCents: 277500, grossCents: 2127500, treatment: "CHARGE_TO_ACCOUNT" },
    ],
    expected: {
      deductedCostsCents: 1049433, chargedCostsCents: 2127500, netProceedsCents: 50700567, paymentCents: 50700567,
      shortfallCents: 14764824, surplusCents: 0,
      vat: { kind: "REPOSSESSION_DEEMED_SUPPLY", deemedSupplyValueCents: 55010101, inputTaxClaimCents: 7175231 },
      resale: { exclVatCents: 45000000, vatCents: 6750000 },
    },
  },
  {
    id: "REC-S131-2", route: "NCA_S131_ATTACHMENT", contractType: "FINANCE_LEASE", debtorVatVendor: true,
    settlementDueCents: 20000000, unpaidCashPriceCents: 17391304, cashPriceInclVatCents: 46000000, grossProceedsCents: 26000000,
    costs: [
      { type: "REPAIRS", netCents: 1234567, vatCents: 185185, grossCents: 1419752, treatment: "DEDUCT_FROM_PROCEEDS" },
      { type: "LEGAL_TAXED", netCents: 700000, vatCents: 105000, grossCents: 805000, treatment: "CHARGE_TO_ACCOUNT" },
    ],
    expected: {
      deductedCostsCents: 1419752, chargedCostsCents: 805000, netProceedsCents: 24580248, paymentCents: 20000000,
      shortfallCents: 0, surplusCents: 3775248,
      vat: { kind: "REPOSSESSION_DEEMED_SUPPLY", deemedSupplyValueCents: 17391304, inputTaxClaimCents: 2268431 },
      resale: { exclVatCents: 22608696, vatCents: 3391304 },
    },
  },
  {
    id: "REC-NV-1", route: "NON_NCA_VOLUNTARY", contractType: "INSTALMENT_SALE", debtorVatVendor: true,
    settlementDueCents: 180456789, unpaidCashPriceCents: 160000000, cashPriceInclVatCents: 345000000, grossProceedsCents: 150000000,
    costs: [
      { type: "TOWING", netCents: 1100000, vatCents: 165000, grossCents: 1265000, treatment: "DEDUCT_FROM_PROCEEDS" },
      { type: "LEGAL_CONTRACTUAL", netCents: 2500000, vatCents: 375000, grossCents: 2875000, treatment: "CHARGE_TO_ACCOUNT" },
    ],
    expected: {
      deductedCostsCents: 1265000, chargedCostsCents: 2875000, netProceedsCents: 148735000, paymentCents: 148735000,
      shortfallCents: 34596789, surplusCents: 0,
      vat: { kind: "REPOSSESSION_DEEMED_SUPPLY", deemedSupplyValueCents: 160000000, inputTaxClaimCents: 20869565 },
      resale: { exclVatCents: 130434783, vatCents: 19565217 },
    },
  },
  {
    id: "REC-NV-2", route: "NON_NCA_VOLUNTARY", contractType: "OPERATING_LEASE", debtorVatVendor: true,
    settlementDueCents: 8765432, unpaidCashPriceCents: 0, cashPriceInclVatCents: 0, grossProceedsCents: 30000000,
    costs: [
      { type: "AUCTION_COMMISSION", netCents: 1500000, vatCents: 225000, grossCents: 1725000, treatment: "DEDUCT_FROM_PROCEEDS" },
    ],
    expected: {
      deductedCostsCents: 1725000, chargedCostsCents: 0, netProceedsCents: 28275000, paymentCents: 8765432,
      shortfallCents: 0, surplusCents: 19509568,
      vat: { kind: "LESSOR_RESALE", deemedSupplyValueCents: 0, inputTaxClaimCents: 0 },
      resale: { exclVatCents: 26086957, vatCents: 3913043 },
    },
  },
  {
    id: "REC-NC-1", route: "NON_NCA_COURT_ORDER", contractType: "FULL_MAINTENANCE_LEASE", debtorVatVendor: true,
    settlementDueCents: 25100000, unpaidCashPriceCents: 0, cashPriceInclVatCents: 0, grossProceedsCents: 19999999,
    costs: [
      { type: "SHERIFF", netCents: 450001, vatCents: 67500, grossCents: 517501, treatment: "DEDUCT_FROM_PROCEEDS" },
      { type: "LEGAL_CONTRACTUAL", netCents: 3300000, vatCents: 495000, grossCents: 3795000, treatment: "CHARGE_TO_ACCOUNT" },
    ],
    expected: {
      deductedCostsCents: 517501, chargedCostsCents: 3795000, netProceedsCents: 19482498, paymentCents: 19482498,
      shortfallCents: 9412502, surplusCents: 0,
      vat: { kind: "LESSOR_RESALE", deemedSupplyValueCents: 0, inputTaxClaimCents: 0 },
      resale: { exclVatCents: 17391303, vatCents: 2608696 },
    },
  },
  {
    id: "REC-NC-2", route: "NON_NCA_COURT_ORDER", contractType: "FINANCE_LEASE", debtorVatVendor: false,
    settlementDueCents: 77777777, unpaidCashPriceCents: 70000000, cashPriceInclVatCents: 230000000, grossProceedsCents: 99000000,
    costs: [
      { type: "STORAGE", netCents: 250000, vatCents: 37500, grossCents: 287500, treatment: "DEDUCT_FROM_PROCEEDS" },
      { type: "LEGAL_CONTRACTUAL", netCents: 1000000, vatCents: 150000, grossCents: 1150000, treatment: "CHARGE_TO_ACCOUNT" },
    ],
    expected: {
      deductedCostsCents: 287500, chargedCostsCents: 1150000, netProceedsCents: 98712500, paymentCents: 77777777,
      shortfallCents: 0, surplusCents: 19784723,
      vat: { kind: "REPOSSESSION_DEEMED_SUPPLY", deemedSupplyValueCents: 70000000, inputTaxClaimCents: 9130435 },
      resale: { exclVatCents: 86086957, vatCents: 12913043 },
    },
  },
]
