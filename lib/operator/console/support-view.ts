/**
 * "Open lender": what an operator user sees of a lender's borrower data, and
 * only through that lender's active support grant.
 *
 * Every open goes through resolveOperatorTenantAccess (lib/operator/
 * tenant-access.ts), the one decision W0 built: active grant, the operator's
 * own lender, a TOTP-verified sign-in, a read method, READONLY floor; audited
 * as SUPPORT_ACCESS_USED (strict) or SUPPORT_ACCESS_REFUSED. Nothing here is
 * read before that decision. The reads are a short, read-only summary in the
 * lender's own tenant frame; ID numbers are masked and no contact details are
 * shown (minimum necessary, POPIA s10).
 */
import { headers } from "next/headers"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { resolveOperatorTenantAccess, type OperatorAccessRefusal } from "../tenant-access"
import { REQUEST_ID_HEADER, REQUEST_METHOD_HEADER } from "@/lib/proxy/operator-read-only"
import type { OperatorPrincipal } from "../console-auth"

const ROWS = 50

export function maskIdNumber(idNumber: string | null): string {
  if (!idNumber) return "—"
  return idNumber.length <= 4 ? "••••" : `${"•".repeat(idNumber.length - 4)}${idNumber.slice(-4)}`
}

async function readSummary(tenantId: string) {
  return runWithTenant(tenantId, async () => {
    const [clients, loans, applications] = await Promise.all([
      prisma.client.findMany({
        where: { tenantId },
        select: { id: true, firstName: true, lastName: true, idNumber: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: ROWS,
      }),
      prisma.loan.findMany({
        where: { tenantId },
        select: { id: true, reference: true, status: true, principal: true, arrearsAmount: true, daysInArrears: true, startDate: true },
        orderBy: { startDate: "desc" },
        take: ROWS,
      }),
      prisma.loanApplication.findMany({
        where: { tenantId },
        select: { id: true, status: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: ROWS,
      }),
    ])
    return {
      clients: clients.map(({ idNumber, ...c }) => ({ ...c, idNumber: maskIdNumber(idNumber) })),
      loans,
      applications,
    }
  })
}

export type SupportView =
  | { allowed: false; reason: OperatorAccessRefusal }
  | { allowed: true; grantId: string; expiresAt: Date; data: Awaited<ReturnType<typeof readSummary>> }

/** The page's one entry point: the grant decision, then (only if allowed) the reads. */
export async function openLenderAsSupport(principal: OperatorPrincipal, tenantId: string): Promise<SupportView> {
  const h = await headers()
  const access = await resolveOperatorTenantAccess({
    session: principal,
    tenantId,
    requiredRole: "READONLY",
    resource: `/operator/lenders/${tenantId}/support`,
    method: h.get(REQUEST_METHOD_HEADER),
    requestId: h.get(REQUEST_ID_HEADER),
  })
  if (!access.allowed) return { allowed: false, reason: access.reason }
  return { allowed: true, grantId: access.grantId, expiresAt: access.grantExpiresAt, data: await readSummary(tenantId) }
}
