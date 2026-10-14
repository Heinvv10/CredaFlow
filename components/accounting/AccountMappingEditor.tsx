"use client"

import { useEffect, useState } from "react"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

interface Mapping {
  role: string
  code: string
  name: string
  taxCode: string | null
  isDefault: boolean
  description: string
  defaultCode: string
}

/** The chart-of-accounts mapping. Editable by ADMIN; applies to months closed after a change. */
export function AccountMappingEditor({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<Mapping[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    void fetch("/api/accounting/mappings").then(async (res) => {
      if (res.ok) setRows(((await res.json()) as { mappings: Mapping[] }).mappings)
      else setMessage(`Could not load the mapping (${res.status})`)
    })
  }, [])

  const update = (role: string, patch: Partial<Mapping>) => setRows((rs) => rs.map((r) => (r.role === role ? { ...r, ...patch } : r)))

  async function save() {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch("/api/accounting/mappings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mappings: rows.map((r) => ({ role: r.role, accountCode: r.code, accountName: r.name, taxCode: r.taxCode })) }),
      })
      const json = (await res.json().catch(() => ({}))) as { mappings?: Mapping[]; error?: string }
      if (res.ok && json.mappings) {
        setRows(json.mappings)
        setMessage("Saved. Months closed from now on use these codes.")
      } else {
        setMessage(json.error ?? `Save failed (${res.status})`)
      }
    } catch {
      setMessage("Network error; nothing was saved by this page.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <DataPanel
      title="Chart of accounts"
      description="Where each journal line posts in your general ledger. Xero refuses manual journals to a bank account: map Bank to a clearing account."
      actions={canEdit ? <Button size="sm" disabled={busy || rows.length === 0} onClick={save}>Save mapping</Button> : undefined}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Journal role</TableHead>
            <TableHead>Account code</TableHead>
            <TableHead>Account name</TableHead>
            <TableHead>Tax code</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.role}>
              <TableCell>
                <p className="font-medium text-[var(--cf-text)]">{r.role.replaceAll("_", " ").toLowerCase()}</p>
                <p className="text-[11px] text-[var(--cf-text-muted)]">{r.description}</p>
              </TableCell>
              <TableCell>
                <Input aria-label={`${r.role} account code`} value={r.code} disabled={!canEdit} onChange={(e) => update(r.role, { code: e.target.value })} className="w-28" />
              </TableCell>
              <TableCell>
                <Input aria-label={`${r.role} account name`} value={r.name} disabled={!canEdit} onChange={(e) => update(r.role, { name: e.target.value })} />
              </TableCell>
              <TableCell>
                <Input aria-label={`${r.role} tax code`} value={r.taxCode ?? ""} disabled={!canEdit} placeholder="none" onChange={(e) => update(r.role, { taxCode: e.target.value || null })} className="w-28" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {message && <p className="mt-3 text-sm text-[var(--cf-text-secondary)]" role="status">{message}</p>}
    </DataPanel>
  )
}
