"use client"

import { TextField } from "@/components/asset-finance/register-form-controls"

export type PersonValues = { idNumber: string; firstName: string; lastName: string; email: string; phone: string }
export const EMPTY_PERSON: PersonValues = { idNumber: "", firstName: "", lastName: "", email: "", phone: "" }

/** A person the dealer captures: SA ID number, names, email and phone (lib/dealer/capture.ts parseDealerPerson). */
export function PersonFields({ idPrefix, values, onChange, errors }: {
  idPrefix: string
  values: PersonValues
  onChange: (values: PersonValues) => void
  errors: Record<string, string>
}) {
  const set = (key: keyof PersonValues) => (value: string) => onChange({ ...values, [key]: value })
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <TextField id={`${idPrefix}-firstName`} label="First names" required value={values.firstName} onChange={set("firstName")} error={errors.firstName} />
      <TextField id={`${idPrefix}-lastName`} label="Surname" required value={values.lastName} onChange={set("lastName")} error={errors.lastName} />
      <TextField id={`${idPrefix}-idNumber`} label="SA ID number" required inputMode="numeric" value={values.idNumber} onChange={set("idNumber")} error={errors.idNumber} />
      <TextField id={`${idPrefix}-email`} label="Email address" required type="email" value={values.email} onChange={set("email")} error={errors.email} />
      <TextField id={`${idPrefix}-phone`} label="Mobile number" required placeholder="+27 82 000 0000" value={values.phone} onChange={set("phone")} error={errors.phone} />
    </div>
  )
}
