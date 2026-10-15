"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type OperatorUser = {
  id: string; name: string | null; email: string; role: string; active: boolean; totpEnabled: boolean; lastLoginAt: string | null
}

async function post(url: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> | null }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null)
  return { ok: !!res?.ok, data: (await res?.json().catch(() => null)) as Record<string, unknown> | null }
}

const sentText = (data: Record<string, unknown> | null) =>
  data?.emailSent ? "Link emailed" : "Link issued, but no email was sent (platform SMTP not configured)"

/** Invite, deactivate and re-send links for operator users (OPERATOR_ADMIN). */
export function OperatorUsersPanel({ users, selfId }: { users: OperatorUser[]; selfId: string }) {
  const router = useRouter()
  const [form, setForm] = useState({ name: "", email: "", role: "OPERATOR_SUPPORT" })
  const [message, setMessage] = useState<string | null>(null)
  const [rowStatus, setRowStatus] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  async function invite() {
    setBusy(true)
    const { ok, data } = await post("/api/operator/users", form)
    setBusy(false)
    setMessage(ok ? `Invited ${form.email}. ${sentText(data)}.` : String(data?.error ?? "Invite failed"))
    if (ok) {
      setForm({ name: "", email: "", role: "OPERATOR_SUPPORT" })
      router.refresh()
    }
  }

  const DONE = { reset: "", deactivate: "Deactivated", "totp-reset": "2FA reset: they set it up again at their next sign-in" } as const
  const CONFIRM = { deactivate: "Deactivate this user and end their sessions?", "totp-reset": "Reset this user's two-factor authentication and end their sessions?" }

  async function act(id: string, action: "deactivate" | "reset" | "totp-reset") {
    if (action !== "reset" && !window.confirm(CONFIRM[action])) return
    const { ok, data } = await post(`/api/operator/users/${id}/${action}`)
    setRowStatus((s) => ({ ...s, [id]: ok ? (action === "reset" ? sentText(data) : DONE[action]) : String(data?.error ?? "Failed") }))
    if (ok && action !== "reset") router.refresh()
  }

  // A deactivated user is invited again: reactivated, 2FA cleared, a new link.
  async function reinvite(u: OperatorUser) {
    const { ok, data } = await post("/api/operator/users", { email: u.email, name: u.name ?? u.email, role: u.role })
    setRowStatus((s) => ({ ...s, [u.id]: ok ? `Re-invited. ${sentText(data)}` : String(data?.error ?? "Failed") }))
    if (ok) router.refresh()
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">Invite an operator user</CardTitle></CardHeader>
        <CardContent className="grid gap-3 text-sm md:grid-cols-4">
          <Input aria-label="Name" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input aria-label="Email" placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <select
            aria-label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}
            className="h-10 rounded-md border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-3 text-[var(--cf-text)]"
          >
            <option value="OPERATOR_SUPPORT">Support</option>
            <option value="OPERATOR_ADMIN">Admin</option>
          </select>
          <Button onClick={invite} disabled={busy || !form.name.trim() || !form.email.trim()}>{busy ? "Inviting…" : "Send invite"}</Button>
          {message ? <p className="md:col-span-4 text-[var(--cf-text-secondary)]">{message}</p> : null}
        </CardContent>
      </Card>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead><TableHead>Email</TableHead><TableHead>Role</TableHead>
              <TableHead>2FA</TableHead><TableHead>Last sign-in</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id} className={u.active ? undefined : "opacity-60"}>
                <TableCell>{u.name ?? "—"}{u.active ? "" : " (inactive)"}</TableCell>
                <TableCell>{u.email}</TableCell>
                <TableCell>{u.role === "OPERATOR_ADMIN" ? "Admin" : "Support"}</TableCell>
                <TableCell>{u.totpEnabled ? "On" : "Not set up"}</TableCell>
                <TableCell>{u.lastLoginAt ?? "—"}</TableCell>
                <TableCell className="text-right">
                  {u.active && u.id !== selfId ? (
                    <div className="flex items-center justify-end gap-2">
                      {rowStatus[u.id] ? <span className="text-xs text-[var(--cf-text-muted)]">{rowStatus[u.id]}</span> : null}
                      <Button size="sm" variant="outline" onClick={() => act(u.id, "reset")}>Send password link</Button>
                      {u.totpEnabled ? <Button size="sm" variant="outline" onClick={() => act(u.id, "totp-reset")}>Reset 2FA</Button> : null}
                      <Button size="sm" variant="destructive" onClick={() => act(u.id, "deactivate")}>Deactivate</Button>
                    </div>
                  ) : !u.active ? (
                    <div className="flex items-center justify-end gap-2">
                      {rowStatus[u.id] ? <span className="text-xs text-[var(--cf-text-muted)]">{rowStatus[u.id]}</span> : null}
                      <Button size="sm" variant="outline" onClick={() => reinvite(u)}>Re-invite</Button>
                    </div>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
