"use client"

import { TextField } from "@/components/asset-finance/register-form-controls"

export type AddressValues = { addressLine1: string; city: string; province: string; postalCode: string }
export const EMPTY_ADDRESS: AddressValues = { addressLine1: "", city: "", province: "", postalCode: "" }

/**
 * The borrower's address (lib/dealer/capture.ts): the lender's tax invoice
 * needs a street line and a city, and the address is fixed once the deal is
 * approved, so it is captured with the borrower.
 */
export function AddressFields({ idPrefix, values, onChange, errors }: {
  idPrefix: string
  values: AddressValues
  onChange: (values: AddressValues) => void
  errors: Record<string, string>
}) {
  const set = (key: keyof AddressValues) => (value: string) => onChange({ ...values, [key]: value })
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <TextField id={`${idPrefix}-addressLine1`} label="Street address" required value={values.addressLine1} onChange={set("addressLine1")} error={errors.addressLine1} />
      <TextField id={`${idPrefix}-city`} label="City or town" required value={values.city} onChange={set("city")} error={errors.city} />
      <TextField id={`${idPrefix}-province`} label="Province" value={values.province} onChange={set("province")} error={errors.province} />
      <TextField id={`${idPrefix}-postalCode`} label="Postal code" inputMode="numeric" value={values.postalCode} onChange={set("postalCode")} error={errors.postalCode} />
    </div>
  )
}
