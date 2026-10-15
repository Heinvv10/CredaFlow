"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type Grant = {
  id: string; state: "active" | "expired" | "revoked"; operatorUser: string; reason: string
  grantedBy: string; createdAt: string; endsAt: string; revokedBy: string | null
}
type AuditRow = { id: string; at: string; action: string; who: string; detail: string }

type Props = {
  canManage: boolean
  operatorName: string | null
  operatorUsers: Array<{ id: string; label: string }>
  grants: Grant[]
  audit: AuditRow[]
}

const STATE_VARIANT = { active: "success", expired: "neutral", revoked: "danger" } as const
const selectClass = "h-10 w-full rounded-md border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-3 text-sm text-[var(--cf-text)]"

export function SupportAccessPanel({ canManage, operatorName, operatorUsers, grants, audit }: Props) {
  const router = useRouter()
  const [operatorUserId, setOperatorUserId] = useState(operatorUsers[0]?.id ?? "")
  const [hours, setHours] = useState("24")
  const [reason, setReason] = useState("")
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function call(url: string, body?: unknown): Promise<boolean> {
    setBusy(true)
    setMessage(null)
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => null)
    setBusy(false)
    if (res?.ok) {
      router.refresh()
      return true
    }
    setMessage(((await res?.json().catch(() => null)) as { error?: string } | null)?.error ?? "The request failed")
    return false
  }

  async function grant() {
    if (await call("/api/settings/support-access", { operatorUserId, durationHours: Number(hours), reason })) {
      setReason("")
      setMessage("Support access granted.")
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-base">Grant support access</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm text-[var(--cf-text-secondary)]">
          <p>
            {operatorName ? `${operatorName} runs this platform.` : "No platform operator is set for this lender."} Their support staff
            cannot see your clients, loans or documents unless you grant it here. Access is read-only, lasts at most 7 days, can be revoked
            at any time, and every use is recorded below.
          </p>
          {!canManage ? (
            <p className="font-medium text-[var(--cf-text)]">
              Sign in with two-factor authentication to grant or revoke support access (Settings → Security, then sign out and back in).
            </p>
          ) : operatorUsers.length === 0 ? (
            <p>Your platform operator has no active support staff to grant.</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <label htmlFor="grant-operator-user" className="mb-1 block text-xs font-medium">Who</label>
                <select id="grant-operator-user" className={selectClass} value={operatorUserId} onChange={(e) => setOperatorUserId(e.target.value)}>
                  {operatorUsers.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="grant-hours" className="mb-1 block text-xs font-medium">For how many hours (1–168)</label>
                <Input id="grant-hours" type="number" min={1} max={168} value={hours} onChange={(e) => setHours(e.target.value)} />
              </div>
              <div className="md:col-span-3">
                <label htmlFor="grant-reason" className="mb-1 block text-xs font-medium">Reason (e.g. the support ticket)</label>
                <Textarea id="grant-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
              <div><Button onClick={grant} disabled={busy || !reason.trim() || !operatorUserId}>Grant read-only access</Button></div>
            </div>
          )}
          {message ? <p role="status" className="text-[var(--cf-text)]">{message}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Grants</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Who</TableHead><TableHead>State</TableHead><TableHead>Reason</TableHead><TableHead>Granted by</TableHead>
                <TableHead>Granted</TableHead><TableHead>Ends / ended</TableHead><TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {grants.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-[var(--cf-text-muted)]">No support access has been granted.</TableCell></TableRow>
              ) : grants.map((g) => (
                <TableRow key={g.id}>
                  <TableCell>{g.operatorUser}</TableCell>
                  <TableCell><Badge variant={STATE_VARIANT[g.state]}>{g.state}{g.revokedBy ? ` by ${g.revokedBy}` : ""}</Badge></TableCell>
                  <TableCell className="max-w-xs truncate" title={g.reason}>{g.reason}</TableCell>
                  <TableCell>{g.grantedBy}</TableCell>
                  <TableCell>{g.createdAt}</TableCell>
                  <TableCell>{g.endsAt}</TableCell>
                  <TableCell className="text-right">
                    {g.state === "active" && canManage ? (
                      <Button size="sm" variant="destructive" disabled={busy} onClick={() => call(`/api/settings/support-access/${g.id}/revoke`)}>Revoke</Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Support access log</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>When</TableHead><TableHead>What</TableHead><TableHead>Who</TableHead><TableHead>Detail</TableHead></TableRow></TableHeader>
            <TableBody>
              {audit.length === 0 ? (
                <TableRow><TableCell colSpan={4} className="text-[var(--cf-text-muted)]">Nothing recorded yet.</TableCell></TableRow>
              ) : audit.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>{a.at}</TableCell><TableCell>{a.action}</TableCell><TableCell>{a.who}</TableCell>
                  <TableCell className="text-xs text-[var(--cf-text-muted)]">{a.detail}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
