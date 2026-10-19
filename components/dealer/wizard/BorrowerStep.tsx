"use client"

import { useState } from "react"
import type { BusinessEntityType } from "@prisma/client"
import { Button } from "@/components/ui/button"
import { FormError, SelectField, TextField, sendJson } from "@/components/asset-finance/register-form-controls"
import { ENTITY_TYPE_LABELS } from "@/lib/asset-finance/labels"
import { PersonFields, EMPTY_PERSON, type PersonValues } from "./PersonFields"
import { optionalCents, type BorrowerChoice, type DealerWizardOptions } from "./types"

const EMPTY_ENTITY = { type: "COMPANY" as BusinessEntityType, legalName: "", tradingName: "", registrationNumber: "", vatNumber: "", turnoverRands: "", assetValueRands: "", financialYearEnd: "" }

/**
 * Step 1: the borrower — a business (one the dealer captured before, or a new
 * one) or a sole proprietor (a person the dealer captured, or a new one). A
 * business or person already on the lender's book is refused (409) and
 * nothing of it is shown: the lender is asked instead.
 */
export function BorrowerStep({ options, onChosen }: { options: DealerWizardOptions; onChosen: (choice: BorrowerChoice) => void }) {
  const [kind, setKind] = useState<"ENTITY" | "CLIENT">("ENTITY")
  const [existing, setExisting] = useState("")
  const [entity, setEntity] = useState(EMPTY_ENTITY)
  const [person, setPerson] = useState<PersonValues>(EMPTY_PERSON)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const pickList = kind === "ENTITY" ? options.entities.map((e) => ({ id: e.id, label: `${e.legalName} · ${e.registrationNumber}` })) : options.people.map((p) => ({ id: p.id, label: p.name }))

  async function next() {
    setError(null)
    setFields({})
    if (existing) {
      const type = options.entities.find((e) => e.id === existing)?.type ?? "COMPANY"
      return onChosen(kind === "ENTITY" ? { kind, entityId: existing, entityType: type } : { kind, clientId: existing })
    }
    let body: Record<string, unknown>
    if (kind === "ENTITY") {
      const turnover = optionalCents(entity.turnoverRands)
      const assets = optionalCents(entity.assetValueRands)
      if (turnover.error || assets.error) return setFields({ ...(turnover.error ? { annualTurnover: turnover.error } : {}), ...(assets.error ? { totalAssetValue: assets.error } : {}) })
      body = {
        type: entity.type, legalName: entity.legalName, tradingName: entity.tradingName, registrationNumber: entity.registrationNumber,
        vatNumber: entity.vatNumber, annualTurnover: turnover.cents ?? null, totalAssetValue: assets.cents ?? null, financialYearEnd: entity.financialYearEnd || null,
      }
    } else {
      body = { ...person }
    }
    setSaving(true)
    const result = await sendJson(kind === "ENTITY" ? "/api/dealer/borrowers/entities" : "/api/dealer/borrowers/clients", "POST", body)
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      setFields(result.fields)
      return
    }
    const id = (result.body as { id: string }).id
    onChosen(kind === "ENTITY" ? { kind, entityId: id, entityType: entity.type } : { kind, clientId: id })
  }

  const setE = (key: keyof typeof EMPTY_ENTITY) => (value: string) => setEntity((prev) => ({ ...prev, [key]: value }))
  return (
    <div className="space-y-4">
      <FormError message={error} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SelectField id="borrowerKind" label="Borrower" required value={kind} onChange={(k) => { setKind(k as "ENTITY" | "CLIENT"); setExisting("") }}
          options={{ ENTITY: "A business (company, CC, trust, partnership)", CLIENT: "A sole proprietor" }} />
        {pickList.length > 0 ? (
          <SelectField id="existingBorrower" label="One you captured before" value={existing} onChange={setExisting}
            options={Object.fromEntries([["", "No: capture a new one"], ...pickList.map((o) => [o.id, o.label])])} />
        ) : null}
      </div>
      {existing ? null : kind === "ENTITY" ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <SelectField id="entityType" label="Type" required value={entity.type} onChange={setE("type")} options={ENTITY_TYPE_LABELS} error={fields.type} />
          <TextField id="legalName" label="Registered name" required value={entity.legalName} onChange={setE("legalName")} error={fields.legalName} />
          <TextField id="tradingName" label="Trading name" value={entity.tradingName} onChange={setE("tradingName")} error={fields.tradingName} />
          <TextField id="registrationNumber" label={entity.type === "TRUST" ? "Master's trust number" : "Registration number"} required
            placeholder={entity.type === "TRUST" ? "IT1234/2015" : "2015/123456/07"} value={entity.registrationNumber} onChange={setE("registrationNumber")} error={fields.registrationNumber} />
          <TextField id="vatNumber" label="VAT number" value={entity.vatNumber} onChange={setE("vatNumber")} error={fields.vatNumber} />
          <TextField id="annualTurnover" label="Annual turnover (R)" inputMode="decimal" value={entity.turnoverRands} onChange={setE("turnoverRands")} error={fields.annualTurnover} />
          <TextField id="totalAssetValue" label="Total asset value (R)" inputMode="decimal" value={entity.assetValueRands} onChange={setE("assetValueRands")} error={fields.totalAssetValue} />
          <TextField id="financialYearEnd" label="Financial year end of those figures" type="date" value={entity.financialYearEnd} onChange={setE("financialYearEnd")} error={fields.financialYearEnd} />
        </div>
      ) : (
        <PersonFields idPrefix="sole" values={person} onChange={setPerson} errors={fields} />
      )}
      <Button size="sm" onClick={next} disabled={saving}>{saving ? "Saving…" : existing ? "Continue" : "Save and continue"}</Button>
    </div>
  )
}
