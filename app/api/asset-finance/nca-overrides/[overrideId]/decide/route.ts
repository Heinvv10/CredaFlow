import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { isRegimeOpen, lockApplicationForRegime, STALE_OVERRIDE_NOTE } from "@/lib/asset-finance/classification"
import { overrideMatchesApplication } from "@/lib/asset-finance/override-snapshot"

const MIN_NOTE = 5
const MAX_NOTE = 2000

type Decision = "APPROVE" | "REJECT"

function parseBody(body: unknown): { decision: Decision; note: string } | string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "Body must be a JSON object"
  const { decision, note } = body as { decision?: unknown; note?: unknown }
  if (decision !== "APPROVE" && decision !== "REJECT") return "decision must be APPROVE or REJECT"
  const trimmed = typeof note === "string" ? note.trim() : ""
  if (trimmed.length < MIN_NOTE || trimmed.length > MAX_NOTE) {
    return `note must be ${MIN_NOTE} to ${MAX_NOTE} characters`
  }
  return { decision, note: trimmed }
}

/**
 * Approve or reject a PENDING NCA regime override (DESIGN D5).
 * Body: `{ decision: "APPROVE" | "REJECT", note: string }`.
 *
 * Needs decide_asset_finance, and the decider must not be the requester. The
 * second rule is also CHECK NcaRegimeOverride_four_eyes; the route refuses
 * first so the caller gets a 403 and the attempt is audited.
 *
 * APPROVE moves the regime; the regime trigger spends the approval, so it
 * authorises exactly that one change. A request is stale when the
 * application's regime is no longer its fromRegime or, for a move to NON_NCA,
 * the application's borrower, amount, product or classification rule is no
 * longer the snapshot it was requested on (the regime trigger would refuse to
 * spend the approval). REJECT records a stale request as usual, and APPROVE
 * rejects it instead (note STALE_OVERRIDE_NOTE, 409), so a stale request never
 * holds the application's one PENDING slot. On a decided application only
 * REJECT is accepted; the regime is frozen.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ overrideId: string }> },
) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled

    const { overrideId } = await params
    const refuse = async (reason: string, error: string) => {
      await auditRefusal({
        action: AuditAction.NCA_OVERRIDE_DECISION_REFUSED,
        entity: "NcaRegimeOverride",
        entityId: overrideId,
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        reason,
        status: 403,
      })
      return NextResponse.json({ error }, { status: 403 })
    }

    if (!canDo(guard.user.role, "decide_asset_finance")) {
      return refuse("insufficient_role", "Deciding an NCA regime override needs the decide_asset_finance permission")
    }

    const parsed = parseBody(await req.json().catch(() => null))
    if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 })
    const { decision, note } = parsed

    // Read outside the transaction only to learn which application to lock:
    // locks are taken application first, then override, the same order as a
    // request or a classification, so they cannot deadlock. applicationId never
    // changes (trigger guardNcaRegimeOverrideLifecycle), and the override is
    // re-read under both locks before anything is decided.
    const found = await prisma.ncaRegimeOverride.findFirst({
      where: { id: overrideId, tenantId: tenant.id },
      select: { applicationId: true },
    })
    if (!found) return NextResponse.json({ error: "Override not found" }, { status: 404 })

    const decideInTransaction = () => prisma.$transaction(async (tx) => {
      if (!(await lockApplicationForRegime(tx, tenant.id, found.applicationId))) {
        return { kind: "not_found" as const }
      }
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "NcaRegimeOverride"
        WHERE "id" = ${overrideId} AND "tenantId" = ${tenant.id}
        FOR UPDATE
      `)
      if (!locked[0]) return { kind: "not_found" as const }
      const override = await tx.ncaRegimeOverride.findFirst({
        where: { id: overrideId, tenantId: tenant.id },
        include: {
          application: {
            select: {
              status: true, ncaRegime: true, entityId: true, appliedAmount: true, productId: true,
              ncaClassificationRule: true,
            },
          },
        },
      })
      if (!override) return { kind: "not_found" as const }
      if (override.status !== "PENDING") return { kind: "not_pending" as const, status: override.status }
      if (override.requestedById === guard.user.id) return { kind: "self_decision" as const }
      const approve = decision === "APPROVE"
      if (approve && !isRegimeOpen(override.application.status)) {
        return { kind: "regime_frozen" as const, status: override.application.status }
      }
      // The application moved since the request (a re-classification, another
      // override, a new amount or product): the request no longer describes
      // the change it would make.
      const stale =
        override.application.ncaRegime !== override.fromRegime ||
        (override.toRegime === "NON_NCA" && !overrideMatchesApplication(override, override.application))
      const approved = approve && !stale
      const decisionNote = approve && stale ? STALE_OVERRIDE_NOTE : note

      const updated = await tx.ncaRegimeOverride.update({
        where: { id: overrideId },
        data: {
          status: approved ? "APPROVED" : "REJECTED",
          decidedById: guard.user.id,
          decidedAt: new Date(),
          decisionNote,
        },
      })
      if (approved) {
        await tx.loanApplication.update({
          where: { id: override.applicationId, tenantId: tenant.id },
          data: { ncaRegime: override.toRegime },
        })
      }
      await logAuditStrict({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.NCA_OVERRIDE_DECIDED,
        entity: "NcaRegimeOverride",
        entityId: overrideId,
        oldValue: { status: "PENDING", ncaRegime: override.application.ncaRegime },
        newValue: {
          applicationId: override.applicationId,
          status: updated.status,
          note: decisionNote,
          requestedById: override.requestedById,
          ncaRegime: approved ? override.toRegime : override.application.ncaRegime,
          ...(stale ? { stale: true, requestedDecision: decision } : {}),
        },
      }, tx)
      return approve && stale
        ? { kind: "stale_rejected" as const, override: updated }
        : { kind: "decided" as const, override: updated }
    })

    let result: Awaited<ReturnType<typeof decideInTransaction>>
    try {
      result = await decideInTransaction()
    } catch (error) {
      // The regime triggers re-check under the row locks; a decision that lost
      // a race with another write is a conflict, not a server error.
      if (isCheckViolation(error)) {
        return NextResponse.json({ error: "The application changed while the override was being decided; try again" }, { status: 409 })
      }
      throw error
    }

    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Override not found" }, { status: 404 })
      case "not_pending":
        return NextResponse.json({ error: `The override is already ${result.status}` }, { status: 409 })
      case "self_decision":
        return refuse(
          "four_eyes_self_decision",
          "An NCA regime override must be decided by someone other than its requester",
        )
      case "regime_frozen":
        return NextResponse.json(
          { error: `The NCA regime is frozen once an application is ${result.status}` },
          { status: 409 },
        )
      case "stale_rejected":
        return NextResponse.json(
          {
            error: "The application's regime changed since this override was requested; it was rejected as stale",
            override: result.override,
          },
          { status: 409 },
        )
      case "decided":
        return NextResponse.json(result.override)
    }
  })
}
