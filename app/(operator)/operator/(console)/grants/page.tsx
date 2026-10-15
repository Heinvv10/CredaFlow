import Link from "next/link"
import { requireOperatorPage } from "@/lib/operator/console-auth"
import { grantState, listMyGrants } from "@/lib/operator/console/grants"
import { OperatorPageTitle } from "@/components/operator/OperatorShell"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatDateTime } from "@/lib/utils"

export const dynamic = "force-dynamic"

const STATE_VARIANT = { active: "success", expired: "neutral", revoked: "danger" } as const

// The support grants lenders have given the signed-in operator user.
export default async function OperatorGrantsPage() {
  const principal = await requireOperatorPage()
  const now = new Date()
  const grants = await listMyGrants(principal.id, principal.operatorId)

  return (
    <>
      <OperatorPageTitle title="My support grants" subtitle="Read-only access lenders have given you. Each grant lasts at most 7 days and the lender can revoke it at any time." />
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lender</TableHead><TableHead>State</TableHead><TableHead>Reason</TableHead>
              <TableHead>Granted by</TableHead><TableHead>Granted</TableHead><TableHead>Expires</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {grants.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center text-[var(--cf-text-muted)]">No lender has granted you support access.</TableCell></TableRow>
            ) : grants.map((g) => {
              const state = grantState(g, now)
              return (
                <TableRow key={g.id}>
                  <TableCell>{g.tenant.name}</TableCell>
                  <TableCell><Badge variant={STATE_VARIANT[state]}>{state}</Badge></TableCell>
                  <TableCell className="max-w-xs truncate" title={g.reason}>{g.reason}</TableCell>
                  <TableCell>{g.grantedBy.name ?? g.grantedBy.email}</TableCell>
                  <TableCell>{formatDateTime(g.createdAt)}</TableCell>
                  <TableCell>{formatDateTime(g.revokedAt ?? g.expiresAt)}</TableCell>
                  <TableCell className="text-right">
                    {state === "active" && g.tenant.status === "ACTIVE" ? (
                      <Link href={`/operator/lenders/${g.tenant.id}/support`} className="text-sm font-medium text-[var(--cf-brand-alt)] hover:underline">Open lender</Link>
                    ) : null}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Card>
    </>
  )
}
