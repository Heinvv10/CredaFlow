import { NextResponse } from "next/server"
import { isClientPoDocument, parsePoFundingFacts, requiresPoFundingFacts } from "@/lib/applications/po-funding"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { triggerNotification } from "@/lib/notifications"
import { screenOnSubmit } from "@/lib/screening/on-submit"
import { withInputStaff } from "@/lib/applications/input-staff"
import { prepareApplicationFields, type PrepareApplicationInput } from "@/lib/applications/prepare-application"
import { lockExistingApplicationSubmissionEvidence } from "@/lib/applications/submission-lock"
import { Prisma } from "@prisma/client"
import {
  isUniqueConstraintViolation,
  OPEN_APPLICATION_STATUSES,
} from "@/lib/applications/open-application"
import {
  AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
  affordabilityDecisionSnapshotIsIntact,
  affordabilityExpenseEvidenceIsIntact,
  affordabilityExpenseEvidenceNeedsMleJustification,
  createAffordabilityExpenseEvidence,
  readAffordabilitySnapshotStore,
  withAffordabilitySnapshot,
} from "@/lib/affordability/snapshot"
import { ownAwareSubmissionSnapshot } from "@/lib/affordability/own-lender-debt-load"
import { AuditAction } from "@/lib/audit"
import { verifyStoredCreditLifeDisclosure } from "@/lib/insurance/credit-life-election.server"
import { EntityBorrowerError, hasClientBorrower } from "@/lib/borrower"

// PATCH supports two, mutually exclusive request shapes on the same route:
//   1. `{ action: "update", ...ApplicationWizardData }` — the resumed wizard
//      saving field edits to an existing DRAFT (or submitting it for review).
//   2. `{ status: "SUBMITTED" }` — a staff member manually submitting a DRAFT
//      application for review without going through the wizard (the detail
//      page's "Submit for Review" button).
// Any other body is rejected.
// An asset-finance deal's application is edited and submitted only through
// its deal (app/api/asset-finance/deals/**): this route would re-validate it
// against consumer products and the consumer submission path (Fair Score E4).
const ASSET_FINANCE_APPLICATION_ERROR = "This application belongs to an asset-finance deal: edit and submit it on the deal."
async function isAssetFinanceApplication(tx: Pick<typeof prisma, "assetFinanceDeal">, tenantId: string, applicationId: string): Promise<boolean> {
  return (await tx.assetFinanceDeal.count({ where: { tenantId, applicationId } })) > 0
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  if (!canDo(guard.user.role, "edit_application")) {
    return NextResponse.json({ error: "Your role cannot edit an application." }, { status: 403 })
  }

  const body = (await req.json().catch(() => ({}))) as
    { status?: string; action?: string } & Partial<PrepareApplicationInput>

  if (body.action === "update") {
    return withTenantContext(req, async (tenant) => {
      const { id } = await params
      const targetClientId = typeof body.clientId === "string" ? body.clientId : undefined
      const targetProductId = typeof body.productId === "string" ? body.productId : undefined
      let outcome
      try {
        outcome = await prisma.$transaction(async (tx) => {
          const locked = await lockExistingApplicationSubmissionEvidence(tx, {
            tenantId: tenant.id,
            applicationId: id,
            clientId: targetClientId,
            productId: targetProductId,
          })
          if (!locked) return { kind: "not_found" as const }

          const application = await tx.loanApplication.findUnique({
            where: { id, tenantId: tenant.id },
            select: { id: true, status: true, updatedAt: true, affordabilityResult: true, inputStaffIds: true },
          })
          if (!application) return { kind: "not_found" as const }
          if (application.status !== "DRAFT") return { kind: "not_draft" as const }
          if (await isAssetFinanceApplication(tx, tenant.id, id)) return { kind: "asset_finance" as const }

          const prepared = await prepareApplicationFields(
            body as PrepareApplicationInput,
            tenant.id,
            guard.user.id,
            { action: "update" },
            tx,
          )
          if (!prepared.ok) return { kind: "prepare_error" as const, prepared }

          let fields = prepared.fields
          let submissionDecisionFingerprint: string | null = null
          if (prepared.fields.status === "SUBMITTED") {
            const submission = readAffordabilitySnapshotStore(
              prepared.fields.affordabilityResult,
            ).submission
            if (!submission || !affordabilityDecisionSnapshotIsIntact(submission)) {
              return { kind: "snapshot_error" as const }
            }
            submissionDecisionFingerprint = submission.decisionFingerprint
            fields = {
              ...prepared.fields,
              affordabilityResult: withAffordabilitySnapshot(
                application.affordabilityResult,
                submission,
              ) as unknown as Prisma.InputJsonValue,
            }
          } else if (application.affordabilityResult !== null) {
            fields = {
              ...prepared.fields,
              affordabilityResult: application.affordabilityResult as Prisma.InputJsonValue,
            }
          }

          const updated = await tx.loanApplication.updateMany({
            where: { id, tenantId: tenant.id, status: "DRAFT", updatedAt: application.updatedAt },
            // Whoever captures or submits the figures is recorded: they cannot disburse an engine approval of it.
            data: { ...fields, inputStaffIds: withInputStaff(application.inputStaffIds, guard.user.id) },
          })
          if (updated.count === 0) return { kind: "changed" as const }
          await tx.auditLog.create({
            data: {
              tenantId: tenant.id,
              userId: guard.user.id,
              userEmail: guard.user.email,
              action: fields.status === "SUBMITTED"
                ? "APPLICATION_SUBMITTED_BY_STAFF"
                : "APPLICATION_UPDATED_BY_STAFF",
              entity: "LoanApplication",
              entityId: id,
              oldValue: { status: application.status },
              newValue: {
                status: fields.status,
                ...(fields.status === "SUBMITTED"
                  ? {
                      snapshotSchemaVersion: AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
                      decisionFingerprint: submissionDecisionFingerprint,
                    }
                  : {}),
              },
            },
          })
          if (fields.status === "SUBMITTED") {
            await tx.auditLog.create({
              data: {
                tenantId: tenant.id,
                userId: guard.user.id,
                userEmail: guard.user.email,
                action: AuditAction.CREDIT_LIFE_ELECTION_RECORDED,
                entity: "LoanApplication",
                entityId: id,
                newValue: {
                  election: fields.creditLifeElection,
                  productId: fields.creditLifeProductId,
                  productName: fields.creditLifeProductName,
                  insurerId: fields.creditLifeInsurerId,
                  insurerName: fields.creditLifeInsurerName,
                  monthlyPremiumCents: fields.creditLifeMonthlyPremiumCents,
                  disclosureVersion: fields.creditLifeDisclosureVersion,
                  disclosureSha256: fields.creditLifeDisclosureSha256,
                  acknowledgedAt: fields.creditLifeDisclosureAcknowledgedAt?.toISOString(),
                  acknowledgedBy: fields.creditLifeDisclosureAcknowledgedBy,
                },
              },
            })
          }
          return {
            kind: "updated" as const,
            fields,
            previousStatus: application.status,
          }
        })
      } catch (error) {
        if (isUniqueConstraintViolation(error) && targetClientId && targetProductId) {
          const conflictingApplication = await prisma.loanApplication.findFirst({
            where: {
              id: { not: id },
              tenantId: tenant.id,
              clientId: targetClientId,
              productId: targetProductId,
              status: { in: [...OPEN_APPLICATION_STATUSES] },
            },
            select: { id: true, reference: true, status: true },
          })
          if (conflictingApplication) {
            return NextResponse.json(
              {
                error: `An application for this client and product is already in progress (${conflictingApplication.reference}).`,
                existingApplicationId: conflictingApplication.id,
              },
              { status: 409 },
            )
          }
        }
        throw error
      }

      if (outcome.kind === "not_found") {
        return NextResponse.json({ error: "Application not found" }, { status: 404 })
      }
      if (outcome.kind === "not_draft") {
        return NextResponse.json(
          { error: "Only draft applications can be edited." },
          { status: 400 },
        )
      }
      if (outcome.kind === "asset_finance") {
        return NextResponse.json({ error: ASSET_FINANCE_APPLICATION_ERROR }, { status: 409 })
      }
      if (outcome.kind === "prepare_error") {
        return NextResponse.json(outcome.prepared.body, { status: outcome.prepared.status })
      }
      if (outcome.kind === "snapshot_error") {
        return NextResponse.json(
          {
            error: "Cannot submit for review: the affordability evidence could not be recorded safely.",
            affordabilitySnapshot: "submission_changed",
          },
          { status: 422 },
        )
      }
      if (outcome.kind === "changed") {
        return NextResponse.json(
          { error: "Application status changed before it could be updated; refresh and try again." },
          { status: 409 },
        )
      }

      if (outcome.fields.status === "SUBMITTED") {
        triggerNotification({
          tenantId: tenant.id,
          event: "application_submitted",
          loanId: id,
          clientId: outcome.fields.clientId,
        }).catch(() => {})
        void screenOnSubmit({ tenantId: tenant.id, applicationId: id, actor: { id: guard.user.id, email: guard.user.email } })
      }

      return NextResponse.json({ ok: true, id, status: outcome.fields.status })
    })
  }

  if (body.status !== "SUBMITTED") {
    return NextResponse.json({ error: "Unsupported status transition" }, { status: 400 })
  }

  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const outcome = await prisma.$transaction(async (tx) => {
      const locked = await lockExistingApplicationSubmissionEvidence(tx, {
        tenantId: tenant.id,
        applicationId: id,
      })
      if (!locked) return { kind: "not_found" as const }
      if (!locked.evidenceExists) return { kind: "evidence_missing" as const }

      const application = await tx.loanApplication.findUnique({
        where: { id, tenantId: tenant.id },
        select: {
          id: true, clientId: true, inputStaffIds: true,
          status: true,
          appliedAmount: true,
          appliedTermDays: true,
          productId: true,
          initiationFeePayment: true,
          loanPurposeCategory: true,
          poNumber: true,
          poBuyerName: true,
          poDocumentId: true,
          affordabilityResult: true,
          updatedAt: true,
          creditLifeElection: true,
          creditLifeProductId: true,
          creditLifeProductName: true,
          creditLifeInsurerId: true,
          creditLifeInsurerName: true,
          creditLifeMonthlyPremiumCents: true,
          creditLifeDisclosureVersion: true,
          creditLifeDisclosureAcknowledgedAt: true,
          creditLifeDisclosureAcknowledgedBy: true,
          creditLifeDisclosureSha256: true,
          client: {
            select: {
              grossMonthlyIncome: true,
              monthlyIncome: true,
              monthlyExpenses: true,
              expenseBreakdown: true,
              debtObligations: {
                select: {
                  id: true,
                  creditProvider: true,
                  accountType: true,
                  outstandingBalance: true,
                  monthlyInstalment: true,
                  notes: true,
                },
              },
            },
          },
          product: {
            select: {
              interestRatePm: true,
              interestModel: true,
              initiationFeeModel: true,
              initiationFeePct: true,
              initiationFeeMax: true,
              monthlyServiceFee: true,
              productType: true,
            },
          },
        },
      })
      if (!application) return { kind: "not_found" as const }
      if (application.status !== "DRAFT") return { kind: "not_draft" as const }
      if (await isAssetFinanceApplication(tx, tenant.id, id)) return { kind: "asset_finance" as const }
      // Submission snapshots consumer affordability; an entity borrower is refused.
      if (!hasClientBorrower(application)) return { kind: "entity_borrower" as const }
      if (!verifyStoredCreditLifeDisclosure(application, {
        principalCents: application.appliedAmount,
        termDays: application.appliedTermDays,
      }).ok) {
        return { kind: "credit_life_missing" as const }
      }
      // A PO-funding draft still names the client's undeleted purchase order,
      // checked under the client-evidence lock DELETE /api/documents/[id] takes.
      if (requiresPoFundingFacts(application.product.productType)) {
        const facts = parsePoFundingFacts(application as unknown as Record<string, unknown>, application.loanPurposeCategory)
        if (!facts.ok || !(await isClientPoDocument(tx, {
          tenantId: tenant.id, clientId: application.clientId, documentId: facts.facts.poDocumentId,
        }))) {
          return { kind: "po_order_missing" as const }
        }
      }

      const expenseEvidence = createAffordabilityExpenseEvidence(application.client)
      if (affordabilityExpenseEvidenceNeedsMleJustification(expenseEvidence)) {
        return { kind: "mle" as const, expenseEvidence }
      }
      if (!affordabilityExpenseEvidenceIsIntact(expenseEvidence)) {
        return { kind: "expense_invalid" as const }
      }

      const debtSnapshot = application.client.debtObligations.map((debt) => ({
        sourceId: debt.id,
        provider: debt.creditProvider,
        type: debt.accountType,
        balance: debt.outstandingBalance,
        monthlyInstalment: debt.monthlyInstalment,
        notes: debt.notes,
      }))
      const totalExistingDebt = debtSnapshot.reduce(
        (sum, debt) => sum + debt.monthlyInstalment,
        0,
      )
      const submittedAt = new Date()
      const snapshot = await ownAwareSubmissionSnapshot(tx, tenant.id, application.clientId, {
        capturedAt: submittedAt,
        capturedById: guard.user.id,
        client: application.client,
        applicationDebts: debtSnapshot,
        clientDebts: application.client.debtObligations,
        application: {
          appliedAmount: application.appliedAmount,
          appliedTermDays: application.appliedTermDays,
          productId: application.productId,
          initiationFeePayment: application.initiationFeePayment,
          creditLifeMonthlyPremiumCents:
            application.creditLifeElection === "ACCEPTED"
              ? application.creditLifeMonthlyPremiumCents ?? 0
              : 0,
        },
        product: {
          ...application.product,
          interestModel: application.product.interestModel as "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL",
        },
      })
      if (!affordabilityDecisionSnapshotIsIntact(snapshot)) {
        return { kind: "snapshot_error" as const }
      }

      const updated = await tx.loanApplication.updateMany({
        where: { id, tenantId: tenant.id, status: "DRAFT", updatedAt: application.updatedAt },
        data: {
          status: "SUBMITTED",
          submittedAt,
          // The staff member who submits the snapshot of the client's current figures is an input staff member.
          inputStaffIds: withInputStaff(application.inputStaffIds, guard.user.id),
          bureauReviewGeneration: null,
          existingDebtObligations: debtSnapshot,
          totalExistingDebt,
          netDisposableIncome: snapshot.outcome.netDisposableIncomeCents,
          affordabilityNDI: snapshot.outcome.ndiAfterLoanCents,
          affordabilityResult: withAffordabilitySnapshot(
            application.affordabilityResult,
            snapshot,
          ) as unknown as Prisma.InputJsonValue,
        },
      })
      if (updated.count !== 1) return { kind: "changed" as const }
      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: "APPLICATION_SUBMITTED_BY_STAFF",
          entity: "LoanApplication",
          entityId: id,
          oldValue: { status: application.status },
          newValue: {
            status: "SUBMITTED",
            snapshotSchemaVersion: AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
            decisionFingerprint: snapshot.decisionFingerprint,
          },
        },
      })
      return { kind: "submitted" as const, previousStatus: application.status }
    })

    if (outcome.kind === "not_found" || outcome.kind === "evidence_missing") {
      return NextResponse.json({ error: "Application not found" }, { status: 404 })
    }
    if (outcome.kind === "entity_borrower") {
      return NextResponse.json({ error: new EntityBorrowerError().message }, { status: 409 })
    }
    if (outcome.kind === "not_draft") {
      return NextResponse.json(
        { error: "Only draft applications can be submitted for review." },
        { status: 400 },
      )
    }
    if (outcome.kind === "asset_finance") {
      return NextResponse.json({ error: ASSET_FINANCE_APPLICATION_ERROR }, { status: 409 })
    }
    if (outcome.kind === "po_order_missing") {
      return NextResponse.json(
        { error: "Open Edit Draft and record the purchase order (number, buyer and document) before submitting for review." },
        { status: 422 },
      )
    }
    if (outcome.kind === "credit_life_missing") {
      return NextResponse.json(
        {
          error: "Open Edit Draft and record the client's credit-life election and exact-premium disclosure before submitting for review.",
          missingComplianceEvidence: ["credit-life election"],
        },
        { status: 422 },
      )
    }
    if (outcome.kind === "mle") {
      return NextResponse.json(
        {
          error: "Cannot submit for review: declared living expenses are below the Regulation 23A minimum without a documented justification.",
          affordabilitySnapshot: "mle_justification_missing",
          minimumLivingExpenses: outcome.expenseEvidence.mle.minimumExpenseCents,
          declaredLivingExpenses: outcome.expenseEvidence.statedMonthlyExpensesCents,
        },
        { status: 422 },
      )
    }
    if (outcome.kind === "expense_invalid") {
      return NextResponse.json(
        {
          error: "Cannot submit for review: the client's scalar and itemised expense evidence is incomplete or inconsistent.",
          affordabilitySnapshot: "expense_evidence_invalid",
        },
        { status: 422 },
      )
    }
    if (outcome.kind === "snapshot_error") {
      return NextResponse.json(
        {
          error: "Cannot submit for review: the affordability evidence could not be recorded safely.",
          affordabilitySnapshot: "submission_changed",
        },
        { status: 422 },
      )
    }
    if (outcome.kind === "changed") {
      return NextResponse.json(
        { error: "Application status changed before it could be submitted; refresh and try again." },
        { status: 409 },
      )
    }

    void screenOnSubmit({ tenantId: tenant.id, applicationId: id, actor: { id: guard.user.id, email: guard.user.email } })
    return NextResponse.json({ ok: true, id, status: "SUBMITTED" })
  })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  if (!canDo(guard.user.role, "cancel_application")) {
    return NextResponse.json({ error: "Your role cannot cancel an application." }, { status: 403 })
  }

  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const application = await prisma.loanApplication.findUnique({
      where: { id, tenantId: tenant.id },
      select: { id: true, reference: true, status: true, loan: { select: { id: true } } },
    })

    if (!application) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 })
    }

    if (application.loan || ["APPROVED", "DISBURSED"].includes(application.status)) {
      return NextResponse.json(
        { error: "Approved or disbursed applications cannot be cancelled." },
        { status: 409 }
      )
    }

    if (application.status === "DECLINED") {
      return NextResponse.json(
        { error: "Declined applications are final and cannot be cancelled." },
        { status: 409 }
      )
    }

    if (application.status === "CANCELLED") {
      return NextResponse.json({ ok: true, id, status: "CANCELLED" })
    }

    // Guard against the read-then-write race: a concurrent approve/disburse
    // (or a second cancel) could move status between the findUnique above
    // and this write. `updateMany` with the same notIn set as the pre-check
    // atomically refuses the cancel if the row has moved into a terminal
    // approved/disbursed/cancelled state in the meantime.
    const cancelled = await prisma.$transaction(async (tx) => {
      const updated = await tx.loanApplication.updateMany({
        where: {
          id,
          tenantId: tenant.id,
          status: { notIn: ["APPROVED", "DISBURSED", "DECLINED", "CANCELLED"] },
        },
        data: {
          status: "CANCELLED",
          decisionReason: "Cancelled by staff",
        },
      })
      if (updated.count === 0) return false

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: "APPLICATION_CANCELLED",
          entity: "LoanApplication",
          entityId: id,
          oldValue: { status: application.status },
          newValue: { status: "CANCELLED", reference: application.reference },
        },
      })
      return true
    })
    if (!cancelled) {
      return NextResponse.json(
        { error: "Application status changed before it could be cancelled; refresh and try again." },
        { status: 409 }
      )
    }

    return NextResponse.json({ ok: true, id, status: "CANCELLED" })
  })
}
