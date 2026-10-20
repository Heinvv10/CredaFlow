"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { FormError, TextField, sendJson } from "@/components/asset-finance/register-form-controls"
import { formatDateTime } from "@/lib/utils"

type DealerUserRow = {
  id: string; email: string; name: string; role: "DEALER_ADMIN" | "DEALER_SALES"; active: boolean
  lastLoginAt: string | null; passwordSet: boolean; linkPending: boolean
}

/** The dealer admin's user list: add a sales user (shown its one-time link), deactivate any other user. */
export function DealerUsersPanel({ users, selfId }: { users: DealerUserRow[]; selfId: string }) {
  const router = useRouter()
  const [form, setForm] = useState({ name: "", email: "" })
  const [fields, setFields] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState<{ url: string; email: string; expiresAt: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  async function add() {
    setBusy("add")
    setError(null)
    setFields({})
    const result = await sendJson("/api/dealer/users", "POST", { ...form, role: "DEALER_SALES" })
    setBusy(null)
    if (!result.ok) {
      setError(result.error)
      setFields(result.fields)
      return
    }
    const body = result.body as { setPasswordUrl: string; expiresAt: string }
    setLink({ url: body.setPasswordUrl, email: form.email.trim().toLowerCase(), expiresAt: body.expiresAt })
    setForm({ name: "", email: "" })
    router.refresh()
  }

  async function deactivate(user: DealerUserRow) {
    if (!window.confirm(`Deactivate ${user.name}? They are signed out at once and cannot sign in again.`)) return
    setBusy(user.id)
    setError(null)
    const result = await sendJson(`/api/dealer/users/${user.id}/deactivate`, "POST", {})
    setBusy(null)
    if (!result.ok) return setError(result.error)
    router.refresh()
  }

  return (
    <div className="space-y-5">
      <DataPanel title="Add a sales user" density="loose">
        <div className="space-y-4">
          <FormError message={error} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <TextField id="dealer-user-name" label="Name" required value={form.name} onChange={(name) => setForm((f) => ({ ...f, name }))} error={fields.name} />
            <TextField id="dealer-user-email" label="Email address" required type="email" value={form.email} onChange={(email) => setForm((f) => ({ ...f, email }))} error={fields.email} />
          </div>
          {fields.role ? <p className="text-xs text-[var(--cf-danger)]">{fields.role}</p> : null}
          <Button size="sm" onClick={add} disabled={busy !== null}>{busy === "add" ? "Adding…" : "Add user"}</Button>
          {link ? (
            <div className="space-y-2 rounded-md border border-[var(--cf-border-strong)] bg-[var(--cf-surface-soft)] p-3 text-sm">
              <p className="text-[var(--cf-text)]">Give {link.email} this link to set a password. It works once, until {formatDateTime(link.expiresAt)}, and is not shown again.</p>
              <input readOnly aria-label="One-time set-password link" value={link.url} onFocus={(e) => e.currentTarget.select()}
                className="w-full rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] px-2 py-1.5 font-mono text-xs text-[var(--cf-text)]" />
            </div>
          ) : null}
        </div>
      </DataPanel>
      <DataPanel title="Users">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead><TableHead>Email</TableHead><TableHead>Role</TableHead><TableHead>Status</TableHead><TableHead>Last sign-in</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id}>
                <TableCell>{u.name}</TableCell>
                <TableCell className="text-xs">{u.email}</TableCell>
                <TableCell>{u.role === "DEALER_ADMIN" ? "Admin" : "Sales"}</TableCell>
                <TableCell>
                  {!u.active ? <StatusPill>Deactivated</StatusPill>
                    : !u.passwordSet ? <StatusPill tone="warning">{u.linkPending ? "Link sent" : "Link expired"}</StatusPill>
                      : <StatusPill tone="success">Active</StatusPill>}
                </TableCell>
                <TableCell>{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "—"}</TableCell>
                <TableCell className="text-right">
                  {u.active && u.id !== selfId ? (
                    <Button size="sm" variant="outline" onClick={() => deactivate(u)} disabled={busy !== null}>{busy === u.id ? "Deactivating…" : "Deactivate"}</Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataPanel>
    </div>
  )
}
