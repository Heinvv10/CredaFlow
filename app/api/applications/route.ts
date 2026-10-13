import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { generateReference } from "@/lib/utils"
import { triggerNotification } from "@/lib/notifications"
import { withTenantContext } from "@/lib/tenant"
import { requireApiRole } from "@/lib/auth-guards"
import { prepareApplicationFields, type PrepareApplicationInput } from "@/lib/applications/prepare-application"
import { lockNewApplicationSubmissionEvidence } from "@/lib/applications/submission-lock"
import {
  AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
  readAffordabilitySnapshotStore,
} from "@/lib/affordability/snapshot"
import {
  isUniqueConstraintViolation,
  OPEN_APPLICATION_STATUSES,
} from "@/lib/applications/open-application"
import { AuditAction } from "@/lib/audit"

export async function POST(req: NextRequest) {
  try {
    const guard = await requireApiRole("CREDIT_OFFICER")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const data = await req.json() as PrepareApplicationInput

      let application
      let preparedStatus: string | null = null
      try {
        const result = await prisma.$transaction(async (tx) => {
          if (typeof data.clientId === "string" && typeof data.productId === "string") {
            await lockNewApplicationSubmissionEvidence(tx, {
              tenantId: tenant.id,
              clientId: data.clientId,
              productId: data.productId,
            })
          }

          // Re-read the active product and all client affordability inputs only
          // after their locks are held, then persist that exact snapshot before
          // releasing either lock.
          const prepared = await prepareApplicationFields(
            data,
            tenant.id,
            guard.user.id,
            { action: "create" },
            tx,
          )
          if (!prepared.ok) return { ok: false as const, prepared }

          const created = await tx.loanApplication.create({
            data: {
              tenantId: tenant.id,
              reference: generateReference("APP"),
              ...prepared.fields,
            },
          })
          if (prepared.fields.status === "SUBMITTED") {
            const submissionSnapshot = readAffordabilitySnapshotStore(
              prepared.fields.affordabilityResult,
            ).submission
            await tx.auditLog.create({
              data: {
                tenantId: tenant.id,
                userId: guard.user.id,
                userEmail: guard.user.email,
                action: "APPLICATION_SUBMITTED_BY_STAFF",
                entity: "LoanApplication",
                entityId: created.id,
                newValue: {
                  reference: created.reference,
                  clientId: created.clientId,
                  productId: created.productId,
                  status: created.status,
                  snapshotSchemaVersion: AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
                  decisionFingerprint: submissionSnapshot?.decisionFingerprint ?? null,
                },
              },
            })
            await tx.auditLog.create({
              data: {
                tenantId: tenant.id,
                userId: guard.user.id,
                userEmail: guard.user.email,
                action: AuditAction.CREDIT_LIFE_ELECTION_RECORDED,
                entity: "LoanApplication",
                entityId: created.id,
                newValue: {
                  election: prepared.fields.creditLifeElection,
                  productId: prepared.fields.creditLifeProductId,
                  productName: prepared.fields.creditLifeProductName,
                  insurerId: prepared.fields.creditLifeInsurerId,
                  insurerName: prepared.fields.creditLifeInsurerName,
                  monthlyPremiumCents: prepared.fields.creditLifeMonthlyPremiumCents,
                  disclosureVersion: prepared.fields.creditLifeDisclosureVersion,
                  disclosureSha256: prepared.fields.creditLifeDisclosureSha256,
                  acknowledgedAt: prepared.fields.creditLifeDisclosureAcknowledgedAt?.toISOString(),
                  acknowledgedBy: prepared.fields.creditLifeDisclosureAcknowledgedBy,
                },
              },
            })
          }
          return { ok: true as const, application: created, status: prepared.fields.status }
        })

        if (!result.ok) {
          return NextResponse.json(result.prepared.body, { status: result.prepared.status })
        }
        application = result.application
        preparedStatus = result.status
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          const concurrentApplication = await prisma.loanApplication.findFirst({
            where: {
              tenantId: tenant.id,
              clientId: data.clientId,
              productId: data.productId,
              status: { in: [...OPEN_APPLICATION_STATUSES] },
            },
            select: { id: true, reference: true, status: true },
          })
          if (concurrentApplication) {
            return NextResponse.json(
              {
                error: `An application for this client and product is already in progress (${concurrentApplication.reference}).`,
                existingApplicationId: concurrentApplication.id,
              },
              { status: 409 },
            )
          }
        }
        throw error
      }

      // Trigger application_submitted notification (fire-and-forget)
      if (preparedStatus === "SUBMITTED") {
        triggerNotification({
          tenantId: tenant.id,
          event: "application_submitted",
          loanId: application.id,
          clientId: application.clientId ?? undefined,
        }).catch(() => {})
      }

      return NextResponse.json(application)
    }) // end withTenantContext
  } catch (error) {
    console.error("Failed to create application:", error)
    return NextResponse.json(
      { error: "Failed to create application" },
      { status: 500 }
    )
  }
}
