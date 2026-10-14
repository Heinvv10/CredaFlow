"use client"

import { Suspense, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { BusinessEntityType, EntityRole, TrusteeKind } from "@prisma/client"
import { FormSection } from "@/components/app-shell/FormSection"
import { Button } from "@/components/ui/button"
import { ClientPicker } from "@/components/wizard/ClientPicker"
import type { Client } from "@/components/wizard/types"
import { ClientWizard } from "@/components/clients/wizard/ClientWizard"
import { ENTITY_ROLE_LABELS } from "@/lib/asset-finance/labels"
import { ROLES_BY_ENTITY_TYPE } from "@/lib/asset-finance/relationship-input"
import { FieldError, TextField } from "./form-fields"

/**
 * Link a person to an entity: pick the roles, then either choose an existing
 * client or create one through the standard client wizard (POST /api/clients,
 * its validation and duplicate checks) and link the new client.
 */
export function AddPersonClient({ entityId, entityType, clients }: { entityId: string; entityType: BusinessEntityType; clients: Client[] }) {
  const router = useRouter()
  const [roles, setRoles] = useState<EntityRole[]>([])
  const [trusteeKind, setTrusteeKind] = useState<TrusteeKind | "">("")
  const [ownershipPct, setOwnershipPct] = useState("")
  const [source, setSource] = useState<"existing" | "new">("existing")
  const [clientId, setClientId] = useState("")
  const [search, setSearch] = useState("")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [linking, setLinking] = useState(false)

  const needsKind = roles.includes("TRUSTEE")
  const takesShare = roles.includes("MEMBER") || roles.includes("BENEFICIAL_OWNER")
  const rolesReady = roles.length > 0 && (!needsKind || trusteeKind !== "")

  function toggleRole(role: EntityRole) {
    setRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]))
  }

  async function link(id: string, reference?: string): Promise<void> {
    setLinking(true)
    try {
      const res = await fetch(`/api/asset-finance/entities/${entityId}/people`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: id,
          roles,
          trusteeKind: needsKind ? trusteeKind : undefined,
          ownershipPct: takesShare && ownershipPct ? ownershipPct : undefined,
        }),
      })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string; fields?: Record<string, string> }
        setErrors(body.fields ?? {})
        const saved = reference ? ` Client ${reference} was created; link them as an existing client.` : ""
        toast.error(`${body.error ?? "Could not link the person"}.${saved}`)
        return
      }
      toast.success("Person linked")
      router.push(`/asset-finance/entities/${entityId}`)
      router.refresh()
    } finally {
      setLinking(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <FormSection number="1" title="Roles" description="One person can hold several roles. Directors, trustees and authorised signatories get portal access to the entity.">
        <div className="grid gap-2 sm:grid-cols-2">
          {ROLES_BY_ENTITY_TYPE[entityType].map((role) => (
            <label key={role} className="flex items-center gap-2 text-sm text-[var(--cf-text)]">
              <input type="checkbox" className="h-4 w-4 accent-[var(--cf-brand)]" checked={roles.includes(role)} onChange={() => toggleRole(role)} />
              {ENTITY_ROLE_LABELS[role]}
            </label>
          ))}
        </div>
        <FieldError message={errors.roles} />
        {needsKind && (
          <fieldset className="mt-4">
            <legend className="mb-1.5 text-xs font-semibold text-[var(--cf-text-secondary)]">The trustee is a</legend>
            <div className="flex gap-6 text-sm text-[var(--cf-text)]">
              {(["NATURAL", "JURISTIC"] as const).map((kind) => (
                <label key={kind} className="flex items-center gap-2">
                  <input type="radio" name="trusteeKind" className="accent-[var(--cf-brand)]" checked={trusteeKind === kind} onChange={() => setTrusteeKind(kind)} />
                  {kind === "NATURAL" ? "Natural person" : "Juristic person (acting through this person)"}
                </label>
              ))}
            </div>
            <FieldError message={errors.trusteeKind} />
          </fieldset>
        )}
        {takesShare && (
          <div className="mt-4 sm:w-48">
            <TextField id="ownershipPct" label="Ownership share (%)" value={ownershipPct} onChange={setOwnershipPct} error={errors.ownershipPct} inputMode="decimal" />
          </div>
        )}
      </FormSection>

      <FormSection number="2" title="Person">
        <div className="mb-4 flex gap-2">
          <Button type="button" size="sm" variant={source === "existing" ? "default" : "outline"} onClick={() => setSource("existing")}>
            Existing client
          </Button>
          <Button type="button" size="sm" variant={source === "new" ? "default" : "outline"} onClick={() => setSource("new")}>
            New client
          </Button>
        </div>
        {!rolesReady ? (
          <p className="text-sm text-[var(--cf-text-muted)]">Choose the roles first.</p>
        ) : source === "existing" ? (
          <div className="space-y-3">
            <ClientPicker clients={clients} selectedClientId={clientId} clientSearch={search} setClientSearch={setSearch} onSelect={setClientId} />
            <FieldError message={errors.clientId} />
            <Button type="button" onClick={() => link(clientId)} disabled={!clientId || linking}>
              {linking ? "Linking…" : "Link person"}
            </Button>
          </div>
        ) : (
          <Suspense fallback={<p className="text-sm text-[var(--cf-text-muted)]">Loading…</p>}>
            <ClientWizard mode="staff" onCreated={(created) => link(created.id, created.reference)} />
          </Suspense>
        )}
      </FormSection>
    </div>
  )
}
