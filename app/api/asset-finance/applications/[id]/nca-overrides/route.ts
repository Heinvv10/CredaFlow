import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { isRegimeOpen, lockApplicationForRegime } from "@/lib/asset-finance/classification"

const MIN_REASON = 10
const MAX_REASON = 2000

type Regime = "NCA" | "NON_NCA"

function parseBody(body: unknown): { toRegime: Regime; reason: string } | string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "Body must be a JSON object"
  const { toRegime, reason } = body as { toRegime?: unknown; reason?: unknown }
  if (toRegime !== "NCA" && toRegime !== "NON_NCA") return "toRegime must be NCA or NON_NCA"
  const trimmed = typeof reason === "string" ? reason.trim() : ""
  if (trimmed.length < MIN_REASON || trimmed.length > MAX_REASON) {
    return `reason must be ${MIN_REASON} to ${MAX_REASON} characters`
  }
  return { toRegime, reason: trimmed }
}

/**
 * Request a change to a classified application's NCA regime (DESIGN D5).
 * Body: `{ toRegime: "NCA" | "NON_NCA", reason: string }`.
 *
 * To NCA only adds protection, so it applies at once, decided by the
 * requester. To NON_NCA stays PENDING until a different decider approves it
 * (app/api/asset-finance/nca-overrides/[overrideId]/decide).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // manage_asset_finance
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled

    const { id } = await params
    const parsed = parseBody(await req.json().catch(() => null))
    if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 })
    const { toRegime, reason } = parsed
    const actor = { tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email }

    const result = await prisma.$transaction(async (tx) => {
      if (!(await lockApplicationForRegime(tx, tenant.id, id))) return { kind: "not_found" as const }
      const application = await tx.loanApplication.findFirst({
        where: { id, tenantId: tenant.id },
        select: { id: true, entityId: true, status: true, ncaRegime: true },
      })
      if (!application) return { kind: "not_found" as const }
      if (!application.entityId) return { kind: "not_entity_borrower" as const }
      const fromRegime = application.ncaRegime
      if (!fromRegime) return { kind: "unclassified" as const }
      if (!isRegimeOpen(application.status)) return { kind: "regime_frozen" as const, status: application.status }
      if (fromRegime === toRegime) return { kind: "unchanged" as const }
      const pending = await tx.ncaRegimeOverride.findFirst({
        where: { tenantId: tenant.id, applicationId: id, status: "PENDING" },
        select: { id: true },
      })
      if (pending) return { kind: "pending_exists" as const, overrideId: pending.id }

      const appliesNow = toRegime === "NCA"
      const decidedAt = new Date()
      const override = await tx.ncaRegimeOverride.create({
        data: {
          tenantId: tenant.id,
          applicationId: id,
          fromRegime,
          toRegime,
          reason,
          requestedById: guard.user.id,
          ...(appliesNow ? { status: "APPROVED" as const, decidedById: guard.user.id, decidedAt } : {}),
        },
      })
      await logAuditStrict({
        ...actor,
        action: AuditAction.NCA_OVERRIDE_REQUESTED,
        entity: "NcaRegimeOverride",
        entityId: override.id,
        newValue: { applicationId: id, fromRegime, toRegime, reason, status: override.status },
      }, tx)

      if (appliesNow) {
        await tx.loanApplication.update({ where: { id, tenantId: tenant.id }, data: { ncaRegime: toRegime } })
        await logAuditStrict({
          ...actor,
          action: AuditAction.NCA_OVERRIDE_DECIDED,
          entity: "NcaRegimeOverride",
          entityId: override.id,
          oldValue: { status: "PENDING", ncaRegime: fromRegime },
          newValue: {
            applicationId: id,
            status: override.status,
            ncaRegime: toRegime,
            // A move to NCA needs no second approver (CHECK NcaRegimeOverride_four_eyes).
            appliedOnRequest: true,
          },
        }, tx)
      }
      return { kind: "created" as const, override }
    })

    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Application not found" }, { status: 404 })
      case "not_entity_borrower":
        return NextResponse.json(
          { error: "A natural-person application is always NCA and cannot be overridden" },
          { status: 422 },
        )
      case "unclassified":
        return NextResponse.json({ error: "Classify the application before overriding its regime" }, { status: 409 })
      case "regime_frozen":
        return NextResponse.json(
          { error: `The NCA regime is frozen once an application is ${result.status}` },
          { status: 409 },
        )
      case "unchanged":
        return NextResponse.json({ error: `The application is already ${toRegime}` }, { status: 409 })
      case "pending_exists":
        return NextResponse.json(
          { error: "An override for this application is already pending", overrideId: result.overrideId },
          { status: 409 },
        )
      case "created":
        return NextResponse.json(result.override, { status: 201 })
    }
  })
}
