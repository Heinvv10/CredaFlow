import { NextRequest, NextResponse } from "next/server"
import { ncaOnlyRefusal } from "@/lib/jurisdiction/nca-only"
import { prisma } from "@/lib/prisma"
import { PERMISSIONS, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { callerIp } from "@/lib/rate-limit"
import { loadStrRegister } from "@/lib/fic/registers"
import { ficTotpRefusal } from "@/lib/fic/session"
import {
  GROUNDS_MAX_LENGTH,
  GROUNDS_MIN_LENGTH,
  TIPPING_OFF_WARNING,
  generateStrReference,
  isStrKind,
  logStrAccess,
} from "@/lib/fic/str-cases"

/**
 * GET  — the STR register. FIC compliance role only; every read is logged.
 * POST — raise a case about a client, loan or payment. Any operational role:
 *        the raiser gets the case reference back and nothing else, and cannot
 *        read the register.
 */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole(PERMISSIONS.manage_fic_compliance)
  if (guard.error) return guard.error
  const notNca = await ncaOnlyRefusal("FIC Act compliance")
  if (notNca) return notNca
  return withTenantContext(req, async (tenant) => {
    const totp = await ficTotpRefusal(guard.user, tenant.id)
    if (totp) return totp
    await logStrAccess(prisma, { tenantId: tenant.id, userId: guard.user.id, action: "VIEW_REGISTER" })
    const register = await loadStrRegister(tenant.id)
    return NextResponse.json({ ...register, warning: TIPPING_OFF_WARNING })
  })
}

type Subject = { clientId: string | null; loanId: string | null; paymentId: string | null }

async function resolveSubject(tenantId: string, body: Record<string, unknown>): Promise<Subject | null> {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)
  let clientId = str(body.clientId)
  let loanId = str(body.loanId)
  const paymentId = str(body.paymentId)
  if (paymentId) {
    const payment = await prisma.payment.findFirst({ where: { id: paymentId, tenantId }, select: { loanId: true } })
    if (!payment || (loanId && loanId !== payment.loanId)) return null
    loanId = payment.loanId
  }
  if (loanId) {
    const loan = await prisma.loan.findFirst({ where: { id: loanId, tenantId }, select: { clientId: true } })
    if (!loan || (clientId && loan.clientId && clientId !== loan.clientId)) return null
    clientId = clientId ?? loan.clientId
  }
  if (clientId) {
    const client = await prisma.client.findFirst({ where: { id: clientId, tenantId }, select: { id: true } })
    if (!client) return null
  }
  if (!clientId && !loanId) return null
  return { clientId, loanId, paymentId }
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole(PERMISSIONS.raise_suspicious_report)
  if (guard.error) return guard.error
  const notNca = await ncaOnlyRefusal("FIC Act compliance")
  if (notNca) return notNca
  return withTenantContext(req, async (tenant) => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || !isStrKind(body.kind) || typeof body.grounds !== "string") {
      return NextResponse.json({ error: "Send a kind and the grounds for suspicion." }, { status: 400 })
    }
    const grounds = body.grounds.trim()
    const length = [...grounds].length
    if (length < GROUNDS_MIN_LENGTH || length > GROUNDS_MAX_LENGTH) {
      return NextResponse.json(
        { error: `Describe the grounds in ${GROUNDS_MIN_LENGTH} to ${GROUNDS_MAX_LENGTH} characters.` },
        { status: 400 },
      )
    }
    const subject = await resolveSubject(tenant.id, body)
    if (!subject) {
      return NextResponse.json({ error: "Name a client, loan or payment of this lender." }, { status: 400 })
    }
    const kind = body.kind
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.suspiciousReportCase.create({
        data: {
          tenantId: tenant.id,
          reference: generateStrReference(),
          kind,
          ...subject,
          grounds,
          raisedById: guard.user.id,
        },
        select: { id: true, reference: true },
      })
      // Case id and status only: the audit view is wider than the register.
      await logAuditStrict({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.STR_CASE_RAISED,
        entity: "SuspiciousReportCase",
        entityId: row.id,
        newValue: { status: "OPEN" },
        ipAddress: callerIp(req),
      }, tx)
      return row
    })
    return NextResponse.json({ reference: created.reference, warning: TIPPING_OFF_WARNING }, { status: 201 })
  })
}
