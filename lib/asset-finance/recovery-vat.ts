import { splitInclusive } from "@/lib/vat/amounts"

// VAT consequences of a recovery. ALL money is CENTS; the rate is in
// ten-thousandths (1500 = 15%), as in lib/vat/amounts.ts, whose half-up
// inclusive split is the house rounding.
//  - Instalment sale / finance lease: the debtor is deemed to supply the goods
//    back to the lender at repossession (s8(10)) for the unpaid balance of
//    the cash price, excluding finance charges, capped at the VAT-inclusive
//    cash price (s10(10)). The lender's input tax is the VAT contained in that
//    value. A vendor debtor accounts for the output tax and issues the lender
//    a tax invoice; for a non-vendor the lender claims notional input tax
//    (s16(3)) on the same value.
//  - Operating / full-maintenance lease: the lessor owns the asset throughout,
//    so repossession is no supply; only its later resale carries output tax
//    (resaleOutputTax).
// Every rule here is signed off by the lender's tax adviser, 2026-10-17.

export type RecoveryContractType =
  | "INSTALMENT_SALE"
  | "FINANCE_LEASE"
  | "OPERATING_LEASE"
  | "FULL_MAINTENANCE_LEASE"

export interface RepossessionVatInput {
  contractType: RecoveryContractType
  debtorVatVendor: boolean
  unpaidCashPriceCents: number
  cashPriceInclVatCents: number
  vatRateTenThousandths: number
}

export interface RepossessionVatEvent {
  kind: "REPOSSESSION_DEEMED_SUPPLY" | "LESSOR_RESALE"
  deemedSupplyValueCents: number
  inputTaxClaimCents: number
  basis: string
}

const DEEMED_SUPPLY_BASIS_VENDOR =
  "Instalment sale or finance lease, vendor debtor: deemed supply of the goods back to the lender on " +
  "repossession (s8(10)) at the unpaid cash price, capped at the VAT-inclusive cash price (s10(10)). " +
  "The debtor accounts for the output tax and issues the lender a tax invoice; the lender claims the input tax."
const DEEMED_SUPPLY_BASIS_NON_VENDOR =
  "Instalment sale or finance lease, non-vendor debtor: deemed supply of the goods back to the lender on " +
  "repossession (s8(10)) at the unpaid cash price, capped at the VAT-inclusive cash price (s10(10)). " +
  "The lender claims notional input tax (s16(3)) on the same value."
const LESSOR_RESALE_BASIS =
  "Operating or full-maintenance lease: the lessor owns the asset, so repossession is no supply. " +
  "Output tax arises only on the lessor's resale, on the resale price."

function requireCents(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be non-negative integer cents`)
  }
}

export function repossessionVatEvent(input: RepossessionVatInput): RepossessionVatEvent {
  requireCents(input.unpaidCashPriceCents, "Unpaid cash price")
  requireCents(input.cashPriceInclVatCents, "Cash price")
  switch (input.contractType) {
    case "INSTALMENT_SALE":
    case "FINANCE_LEASE": {
      const deemedSupplyValueCents = Math.min(input.unpaidCashPriceCents, input.cashPriceInclVatCents)
      return {
        kind: "REPOSSESSION_DEEMED_SUPPLY",
        deemedSupplyValueCents,
        inputTaxClaimCents: splitInclusive(deemedSupplyValueCents, input.vatRateTenThousandths).vatCents,
        basis: input.debtorVatVendor ? DEEMED_SUPPLY_BASIS_VENDOR : DEEMED_SUPPLY_BASIS_NON_VENDOR,
      }
    }
    case "OPERATING_LEASE":
    case "FULL_MAINTENANCE_LEASE":
      splitInclusive(0, input.vatRateTenThousandths) // validates the rate
      return { kind: "LESSOR_RESALE", deemedSupplyValueCents: 0, inputTaxClaimCents: 0, basis: LESSOR_RESALE_BASIS }
    default:
      throw new RangeError(`Contract type ${String(input.contractType)} has no recovery VAT event`)
  }
}

/** Output tax contained in a VAT-inclusive resale price (the buyer's tax invoice). */
export function resaleOutputTax(priceInclVatCents: number, vatRateTenThousandths: number): number {
  return splitInclusive(priceInclVatCents, vatRateTenThousandths).vatCents
}
