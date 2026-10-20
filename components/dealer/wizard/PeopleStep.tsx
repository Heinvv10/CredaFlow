"use client"

import { useState } from "react"
import type { BusinessEntityType, EntityRole } from "@prisma/client"
import { Button } from "@/components/ui/button"
import { FormError, SelectField, TextField, sendJson } from "@/components/asset-finance/register-form-controls"
import { ENTITY_ROLE_LABELS } from "@/lib/asset-finance/labels"
import { ROLES_BY_ENTITY_TYPE } from "@/lib/asset-finance/relationship-input"
import { PersonFields, EMPTY_PERSON, type PersonValues } from "./PersonFields"

type Person = { id: string; name: string; roles: string[] }

/**
 * Step 2 (a business only): its directors, members, trustees, signatories,
 * sureties and owners, each a new person the dealer captures in their roles.
 * Each person must sign the POPIA consent form before the deal is submitted.
 */
export function PeopleStep({ entityId, entityType, known, lenderAdded, onDone }: {
  entityId: string
  entityType: BusinessEntityType
  known: Person[]
  lenderAdded: number
  onDone: () => void
}) {
  const allowed = ROLES_BY_ENTITY_TYPE[entityType]
  const [people, setPeople] = useState<Person[]>(known)
  const [person, setPerson] = useState<PersonValues>(EMPTY_PERSON)
  const [roles, setRoles] = useState<EntityRole[]>([allowed[0]])
  const [trusteeKind, setTrusteeKind] = useState<"NATURAL" | "JURISTIC">("NATURAL")
  const [ownershipPct, setOwnershipPct] = useState("")
  const [fields, setFields] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const holdsShare = roles.includes("MEMBER") || roles.includes("BENEFICIAL_OWNER")

  const toggle = (role: EntityRole) => setRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]))

  async function add() {
    setSaving(true)
    setError(null)
    setFields({})
    const result = await sendJson(`/api/dealer/borrowers/entities/${entityId}/people`, "POST", {
      ...person, roles, ...(roles.includes("TRUSTEE") ? { trusteeKind } : {}), ...(holdsShare && ownershipPct.trim() ? { ownershipPct: ownershipPct.trim() } : {}),
    })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      setFields(result.fields)
      return
    }
    setPeople((prev) => [...prev, { id: (result.body as { id: string }).id, name: `${person.firstName.trim()} ${person.lastName.trim()}`, roles }])
    setPerson(EMPTY_PERSON)
    setOwnershipPct("")
  }

  const total = people.length + lenderAdded
  return (
    <div className="space-y-4">
      <ul className="space-y-1 text-sm">
        {people.map((p) => (
          <li key={p.id} className="flex justify-between gap-3">
            <span className="text-[var(--cf-text)]">{p.name}</span>
            <span className="text-[var(--cf-text-muted)]">{p.roles.map((r) => ENTITY_ROLE_LABELS[r as EntityRole] ?? r).join(", ")}</span>
          </li>
        ))}
        {lenderAdded > 0 ? <li className="text-[var(--cf-text-muted)]">{lenderAdded} {lenderAdded === 1 ? "person" : "people"} added by the lender</li> : null}
        {total === 0 ? <li className="text-[var(--cf-text-muted)]">No people yet. Add at least the directors, members or trustees.</li> : null}
      </ul>
      <div className="space-y-4 rounded-md border border-[var(--cf-border-subtle)] p-4">
        <FormError message={error} />
        <PersonFields idPrefix="person" values={person} onChange={setPerson} errors={fields} />
        <fieldset className="space-y-1">
          <legend className="mb-1 text-xs font-semibold text-[var(--cf-text-secondary)]">Roles *</legend>
          <div className="flex flex-wrap gap-4">
            {allowed.map((role) => (
              <label key={role} className="flex items-center gap-2 text-sm text-[var(--cf-text)]">
                <input type="checkbox" checked={roles.includes(role)} onChange={() => toggle(role)} />
                {ENTITY_ROLE_LABELS[role]}
              </label>
            ))}
          </div>
          {fields.roles ? <p className="text-xs text-[var(--cf-danger)]">{fields.roles}</p> : null}
        </fieldset>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {roles.includes("TRUSTEE") ? (
            <SelectField id="trusteeKind" label="Trustee is" required value={trusteeKind} onChange={(v) => setTrusteeKind(v as "NATURAL" | "JURISTIC")}
              options={{ NATURAL: "A natural person", JURISTIC: "A juristic person" }} error={fields.trusteeKind} />
          ) : null}
          {holdsShare ? (
            <TextField id="ownershipPct" label="Ownership (%)" inputMode="decimal" value={ownershipPct} onChange={setOwnershipPct} error={fields.ownershipPct} />
          ) : null}
        </div>
        <Button size="sm" variant="outline" onClick={add} disabled={saving}>{saving ? "Adding…" : "Add person"}</Button>
      </div>
      <Button size="sm" onClick={onDone} disabled={total === 0}>Continue</Button>
    </div>
  )
}
