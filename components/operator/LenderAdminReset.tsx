"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type Admin = { id: string; name: string | null; email: string; role: string; active: boolean; lastLoginAt: string | null }

/**
 * Email one of the lender's admins a password reset link (OPERATOR_ADMIN).
 * The link goes to the admin's own address; the console never sees it.
 */
export function LenderAdminReset({ tenantId, admins }: { tenantId: string; admins: Admin[] }) {
  const [status, setStatus] = useState<Record<string, string>>({})

  async function send(userId: string) {
    setStatus((s) => ({ ...s, [userId]: "Sending…" }))
    const res = await fetch(`/api/operator/lenders/${tenantId}/admin-reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    }).catch(() => null)
    const data = (await res?.json().catch(() => null)) as { emailSent?: boolean; adminsNotified?: number; error?: string } | null
    const notified = data?.adminsNotified ? `; ${data.adminsNotified} other admin(s) told` : ""
    const message = !res?.ok
      ? data?.error ?? "Failed"
      : data?.emailSent ? `Reset link emailed${notified}` : "Link issued, but no email was sent (platform SMTP not configured)"
    setStatus((s) => ({ ...s, [userId]: message }))
  }

  return (
    <Card className="mt-4">
      <CardHeader><CardTitle className="text-base">Lender admins</CardTitle></CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead><TableHead>Email</TableHead><TableHead>Role</TableHead>
              <TableHead>Last sign-in</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {admins.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="text-[var(--cf-text-muted)]">No admins.</TableCell></TableRow>
            ) : admins.map((a) => (
              <TableRow key={a.id}>
                <TableCell>{a.name ?? "—"}</TableCell>
                <TableCell>{a.email}</TableCell>
                <TableCell>{a.role}{a.active ? "" : " (inactive)"}</TableCell>
                <TableCell>{a.lastLoginAt ?? "—"}</TableCell>
                <TableCell className="text-right">
                  {a.active ? (
                    <div className="flex items-center justify-end gap-2">
                      {status[a.id] ? <span className="text-xs text-[var(--cf-text-muted)]">{status[a.id]}</span> : null}
                      <Button size="sm" variant="outline" onClick={() => send(a.id)}>Send reset link</Button>
                    </div>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
