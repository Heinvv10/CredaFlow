"use client"

import Link from "next/link"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { UserPlus } from "lucide-react"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ENTITY_ROLE_LABELS } from "@/lib/asset-finance/labels"
import type { EntityPerson } from "@/lib/asset-finance/entity-detail"

const PORTAL_ROLES = new Set(["DIRECTOR", "TRUSTEE", "AUTHORISED_SIGNATORY"])

export function PeoplePanel({ entityId, people, canManage }: { entityId: string; people: EntityPerson[]; canManage: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)

  async function deactivate(person: EntityPerson) {
    if (!window.confirm(`Remove ${person.name} as ${ENTITY_ROLE_LABELS[person.role]}?`)) return
    setBusy(person.relationshipId)
    try {
      const res = await fetch(`/api/asset-finance/entities/${entityId}/people/${person.relationshipId}`, { method: "DELETE" })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        toast.error(body.error ?? "Could not remove the role")
        return
      }
      toast.success("Role removed")
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  const actions = canManage ? (
    <Button asChild size="sm" variant="outline">
      <Link href={`/asset-finance/entities/${entityId}/people/new`}>
        <UserPlus className="h-3.5 w-3.5" />
        Add person
      </Link>
    </Button>
  ) : null

  return (
    <DataPanel
      title="Related people"
      description="Directors, trustees and authorised signatories can act for the entity in the client portal; a surety alone cannot."
      actions={actions}
      density="compact"
    >
      {people.length === 0 ? (
        <p className="text-sm text-[var(--cf-text-muted)]">No people linked yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Person</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Detail</TableHead>
              <TableHead>Status</TableHead>
              {canManage && <TableHead className="text-right">Action</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {people.map((p) => (
              <TableRow key={p.relationshipId}>
                <TableCell>
                  <Link href={`/clients/${p.clientId}`} className="font-medium text-[var(--cf-brand)] hover:underline">
                    {p.name}
                  </Link>
                  <p className="font-mono text-xs text-[var(--cf-text-muted)]">{p.clientReference}</p>
                </TableCell>
                <TableCell>
                  {ENTITY_ROLE_LABELS[p.role]}
                  {p.active && PORTAL_ROLES.has(p.role) && <p className="text-xs text-[var(--cf-text-muted)]">Portal access</p>}
                </TableCell>
                <TableCell className="text-xs text-[var(--cf-text-secondary)]">
                  {p.trusteeKind ? (p.trusteeKind === "NATURAL" ? "Natural person" : "Juristic person") : null}
                  {p.ownershipPct ? `${p.ownershipPct}%` : null}
                </TableCell>
                <TableCell>
                  <StatusPill tone={p.active ? "success" : "neutral"}>{p.active ? "Active" : "Inactive"}</StatusPill>
                </TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    {p.active && (
                      <Button size="sm" variant="ghost" disabled={busy === p.relationshipId} onClick={() => deactivate(p)}>
                        Remove
                      </Button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </DataPanel>
  )
}
