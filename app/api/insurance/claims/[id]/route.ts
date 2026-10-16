import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"
import { formatCents, toCents } from "@/lib/insurance/rand-cents"
import { DECIMAL_12_2_MAX_CENTS, parseDecimalAmount } from "../../decimal-input"
import { CLAIM_ACTIONS, OPEN_CLAIM_STATUSES, parseGenericClaimUpdate, type ClaimPatchBody } from "@/lib/insurance/claims/claim-patch"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("READONLY")
    if (guard.error) return guard.error

    const { id } = await params

    return withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const claim = await prisma.insuranceClaim.findFirst({
        where: { id, tenantId: tenant.id },
        include: {
          policy: {
            select: {
              policyNumber: true,
              type: true,
              client: { select: { firstName: true, lastName: true, idNumber: true } },
            },
          },
          assessor: { select: { id: true, name: true, email: true } },
        },
      })

      if (!claim) return NextResponse.json({ error: "Claim not found" }, { status: 404 })
      return NextResponse.json(claim)
    })
  } catch {
    return NextResponse.json({ error: "Failed to fetch claim" }, { status: 500 })
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    const { id } = await params

    return withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const body = (await req.json().catch(() => null)) as ClaimPatchBody | null
      if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
      const action = body.action ?? undefined
      if (action !== undefined && !(CLAIM_ACTIONS as readonly unknown[]).includes(action)) {
        return NextResponse.json({ error: `action must be one of ${CLAIM_ACTIONS.join(", ")}` }, { status: 400 })
      }
      if (body.assessorId !== undefined && body.assessorId !== null) {
        const assessor = typeof body.assessorId === "string"
          ? await prisma.user.findFirst({ where: { id: body.assessorId, tenantId: tenant.id, active: true }, select: { id: true } })
          : null
        if (!assessor) return NextResponse.json({ error: "assessorId must be an active staff user of this lender" }, { status: 400 })
      }
      const assessorId = body.assessorId as string | null | undefined
      const insurerRef = typeof body.insurerRef === "string" ? body.insurerRef : undefined
      const decisionFields = {
        ...(assessorId !== undefined ? { assessorId } : {}),
        ...(insurerRef !== undefined ? { insurerRef } : {}),
      }
      const audit = (auditAction: string, newValue: Record<string, unknown>) => logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: auditAction,
        entity: "InsuranceClaim",
        entityId: id,
        newValue,
      })
      const current = await prisma.insuranceClaim.findFirst({
        where: { id, tenantId: tenant.id },
        select: { status: true, claimAmount: true, approvedAmount: true, policy: { select: { sumAssured: true } } },
      })
      if (!current) return NextResponse.json({ error: "Claim not found" }, { status: 404 })
      const decidable = (OPEN_CLAIM_STATUSES as readonly string[]).includes(current.status)
      const changed = () => NextResponse.json({ error: "The claim changed while it was being updated. Refresh and try again." }, { status: 409 })
      const reread = () => prisma.insuranceClaim.findFirst({ where: { id, tenantId: tenant.id } })

      if (action === "approve") {
        if (body.approvedAmount == null) {
          return NextResponse.json({ error: "approvedAmount is required for approval" }, { status: 400 })
        }
        const parsed = parseDecimalAmount("approvedAmount", body.approvedAmount, { maxCents: DECIMAL_12_2_MAX_CENTS })
        if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
        const approvedAmount = parsed.value
        if (!decidable) return NextResponse.json({ error: `A ${current.status} claim has already been decided.` }, { status: 409 })

        // The insurer pays at most what was claimed, and never more than the
        // cover. Compared in exact cents (Decimal columns, never a float).
        const approvedCents = toCents(approvedAmount)
        if (approvedCents > toCents(current.claimAmount)) {
          return NextResponse.json(
            { error: `The approved amount cannot exceed the amount claimed (${formatCents(toCents(current.claimAmount))}).` },
            { status: 422 },
          )
        }
        if (approvedCents > toCents(current.policy.sumAssured)) {
          return NextResponse.json(
            { error: `The approved amount cannot exceed the policy's sum assured (${formatCents(toCents(current.policy.sumAssured))}).` },
            { status: 422 },
          )
        }

        // The status and both bounds again in the write itself, so a claim or
        // policy changed since the read cannot slip an amount past them.
        const written = await prisma.insuranceClaim.updateMany({
          where: {
            id,
            tenantId: tenant.id,
            status: { in: [...OPEN_CLAIM_STATUSES] },
            claimAmount: { gte: approvedAmount },
            policy: { sumAssured: { gte: approvedAmount } },
          },
          data: { status: "APPROVED", approvedAmount, resolvedAt: new Date(), ...decisionFields },
        })
        if (written.count === 0) return changed()
        await audit(AuditAction.INSURANCE_CLAIM_APPROVED, { status: "APPROVED", approvedAmount, ...decisionFields })
        return NextResponse.json(await reread())
      }

      if (action === "reject") {
        if (typeof body.rejectionReason !== "string" || !body.rejectionReason.trim()) {
          return NextResponse.json({ error: "rejectionReason is required for rejection" }, { status: 400 })
        }
        const rejectionReason = body.rejectionReason
        if (!decidable) return NextResponse.json({ error: `A ${current.status} claim has already been decided.` }, { status: 409 })
        const written = await prisma.insuranceClaim.updateMany({
          where: { id, tenantId: tenant.id, status: { in: [...OPEN_CLAIM_STATUSES] } },
          data: { status: "REJECTED", resolvedAt: new Date(), rejectionReason, ...decisionFields },
        })
        if (written.count === 0) return changed()
        await audit(AuditAction.INSURANCE_CLAIM_REJECTED, { status: "REJECTED", rejectionReason, ...decisionFields })
        return NextResponse.json(await reread())
      }

      if (action === "mark_paid") {
        if (current.status !== "APPROVED") {
          return NextResponse.json({ error: `Only an APPROVED claim can be recorded as paid; this one is ${current.status}.` }, { status: 409 })
        }
        const written = await prisma.insuranceClaim.updateMany({
          where: { id, tenantId: tenant.id, status: "APPROVED" },
          data: { status: "PAID", ...decisionFields },
        })
        if (written.count === 0) return changed()
        await audit(AuditAction.INSURANCE_CLAIM_PAID, {
          status: "PAID",
          approvedAmount: current.approvedAmount === null ? null : current.approvedAmount.toFixed(2),
          ...decisionFields,
        })
        return NextResponse.json(await reread())
      }

      // Generic update: details, and a move between the two open statuses only.
      const generic = parseGenericClaimUpdate(body)
      if (!generic.ok) return NextResponse.json({ error: generic.error }, { status: 400 })
      const updateData: Record<string, unknown> = { ...generic.data, ...decisionFields }
      if (updateData.status !== undefined && !decidable) {
        return NextResponse.json({ error: `A ${current.status} claim has already been decided.` }, { status: 409 })
      }
      const written = await prisma.insuranceClaim.updateMany({
        where: { id, tenantId: tenant.id, ...(updateData.status !== undefined ? { status: { in: [...OPEN_CLAIM_STATUSES] } } : {}) },
        data: updateData,
      })
      if (written.count === 0) return changed()
      await audit(AuditAction.INSURANCE_CLAIM_UPDATED, updateData)
      return NextResponse.json(await reread())
    })
  } catch (error) {
    console.error("Failed to update claim:", error)
    return NextResponse.json({ error: "Failed to update claim" }, { status: 500 })
  }
}
