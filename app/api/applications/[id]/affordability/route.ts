import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { calculateLoan } from "@/lib/loan-calculator"
import { assessAffordability } from "@/lib/affordability/ndi"
import type { Prisma } from "@prisma/client"
import { lockExistingApplicationSubmissionEvidence } from "@/lib/applications/submission-lock"
import {
  AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
  ASSESSMENT_AFFORDABILITY_POLICY_VERSION,
  InvalidAffordabilityDebtError,
  affordabilityDecisionSnapshotIsIntact,
  affordabilityDebtFingerprint,
  affordabilityExpenseEvidenceIsIntact,
  affordabilityExpenseEvidenceNeedsMleJustification,
  createAffordabilityExpenseEvidence,
  createAffordabilitySnapshot,
  normaliseAffordabilityDebts,
  totalAffordabilityDebt,
  withAffordabilitySnapshot,
} from "@/lib/affordability/snapshot"
import {
  calculateCreditLifePremiumPeriodsForSchedule,
  creditLifePremiumPaymentLoadCents,
} from "@/lib/insurance/credit-life-billing"
import { EntityBorrowerError, hasClientBorrower } from "@/lib/borrower"
import { isOwnLoanSourceId, loadOwnLenderDebts, withOwnLenderDebts } from "@/lib/affordability/own-lender-debt"

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("CREDIT_OFFICER")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const { id } = await params
      // Only the debt list is taken from the client. NDI is RECOMPUTED server-side
      // from the application's own financials — the client-posted NDI is never
      // trusted (NCA s.80-81 reckless-lending evidence rests on it). All cents.
      const body = await req.json() as {
        // `provider` is the key the application-create debt snapshot uses; `creditor`
        // is what the affordability UI uses. Accept either so re-saving a snapshot
        // debt doesn't blank the name.
        existingDebtObligations?: {
          sourceId?: string | null
          creditor?: string
          provider?: string
          type?: string
          monthlyInstalment?: number
          balance?: number
          notes?: string | null
        }[]
      }
      if (!Array.isArray(body.existingDebtObligations)) {
        return NextResponse.json(
          { error: "existingDebtObligations must be an array; omitted debt evidence is never treated as an empty declaration" },
          { status: 422 },
        )
      }
      // `own-loan:` entries are written by the lender only (lib/affordability/own-lender-debt.ts).
      if (body.existingDebtObligations.some((debt) => isOwnLoanSourceId(debt?.sourceId))) {
        return NextResponse.json(
          { error: "Loans with this lender are counted automatically; remove the own-loan rows from the declaration." },
          { status: 422 },
        )
      }
      let debts: ReturnType<typeof normaliseAffordabilityDebts>
      try {
        debts = normaliseAffordabilityDebts(body.existingDebtObligations)
        totalAffordabilityDebt(debts)
      } catch (error) {
        if (error instanceof InvalidAffordabilityDebtError) {
          return NextResponse.json(
            {
              error: "Invalid affordability debt evidence",
              errors: { [error.field]: error.message },
            },
            { status: 422 },
          )
        }
        throw error
      }

      const outcome = await prisma.$transaction(async (tx) => {
        const locked = await lockExistingApplicationSubmissionEvidence(tx, {
          tenantId: tenant.id,
          applicationId: id,
        })
        if (!locked || !locked.evidenceExists) return { kind: "not_found" as const }

        const app = await tx.loanApplication.findUnique({
          where: { id, tenantId: tenant.id },
          select: {
            id: true,
            clientId: true,
            status: true,
            productId: true,
            appliedAmount: true,
            appliedTermDays: true,
            initiationFeePayment: true,
            creditLifeElection: true,
            creditLifeMonthlyPremiumCents: true,
            affordabilityResult: true,
            updatedAt: true,
            client: {
              select: {
                grossMonthlyIncome: true,
                monthlyIncome: true,
                monthlyExpenses: true,
                expenseBreakdown: {
                  select: {
                    id: true,
                    updatedAt: true,
                    housing: true,
                    transport: true,
                    food: true,
                    education: true,
                    insurance: true,
                    clothing: true,
                    entertainment: true,
                    medical: true,
                    other: true,
                    belowMleJustification: true,
                  },
                },
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
        if (!app) return { kind: "not_found" as const }
        // Consumer NDI affordability; an entity borrower is refused.
        if (!hasClientBorrower(app)) return { kind: "entity_borrower" as const }
        if (!["DRAFT", "SUBMITTED", "UNDER_REVIEW"].includes(app.status)) {
          return { kind: "locked" as const }
        }
        const creditLifeMonthlyPremiumCents =
          app.creditLifeElection === "ACCEPTED"
            ? app.creditLifeMonthlyPremiumCents
            : 0
        if (
          creditLifeMonthlyPremiumCents === null
          || !Number.isSafeInteger(creditLifeMonthlyPremiumCents)
          || creditLifeMonthlyPremiumCents < 0
          || (
            app.creditLifeElection === "ACCEPTED"
            && creditLifeMonthlyPremiumCents === 0
          )
        ) {
          return { kind: "credit_life_invalid" as const }
        }

        // The client's own loans with this lender count unless declared
        // (lib/affordability/own-lender-debt.ts). The declaration is stored as
        // typed; the assessment adds the own loans to both lists.
        const ownLenderDebts = await loadOwnLenderDebts(tx, tenant.id, app.clientId, app.id)
        let assessedApplicationDebts: ReturnType<typeof normaliseAffordabilityDebts>
        let assessedApplicationDebtCents: number
        let clientDebts: ReturnType<typeof normaliseAffordabilityDebts>
        let clientDebtCents: number
        try {
          assessedApplicationDebts = normaliseAffordabilityDebts(withOwnLenderDebts(debts, ownLenderDebts))
          assessedApplicationDebtCents = totalAffordabilityDebt(assessedApplicationDebts)
          clientDebts = normaliseAffordabilityDebts(withOwnLenderDebts(app.client.debtObligations, ownLenderDebts))
          clientDebtCents = totalAffordabilityDebt(clientDebts)
        } catch (error) {
          if (error instanceof InvalidAffordabilityDebtError) {
            return {
              kind: "client_debt_invalid" as const,
              field: error.field,
              message: error.message,
            }
          }
          throw error
        }

        const declaredDebtCents = Math.max(assessedApplicationDebtCents, clientDebtCents)
        const debtSnapshot = debts.map((debt) => ({
          sourceId: debt.sourceId,
          provider: debt.provider,
          type: debt.type,
          monthlyInstalment: debt.monthlyInstalmentCents,
          balance: debt.balanceCents,
          notes: debt.notes,
        }))
        const assessedAt = new Date()
        const interestModel = app.product.interestModel as
          | "FLAT"
          | "REDUCING_BALANCE"
          | "DAILY_ACCRUAL"
        const loanCalc = calculateLoan({
          principal: app.appliedAmount,
          termDays: app.appliedTermDays,
          interestRatePm: app.product.interestRatePm,
          productType: app.product.productType,
          interestModel,
          initiationFeeModel: app.product.initiationFeeModel,
          initiationFeePct: app.product.initiationFeePct,
          initiationFeeMax: app.product.initiationFeeMax,
          monthlyServiceFee: app.product.monthlyServiceFee,
          initiationFeePayment: app.initiationFeePayment,
        }, assessedAt)
        const creditLifePremiumCents = creditLifeMonthlyPremiumCents === 0
          ? 0
          : creditLifePremiumPaymentLoadCents({
              scheduleLength: loanCalc.schedule.length,
              premiumPeriods: calculateCreditLifePremiumPeriodsForSchedule(
                loanCalc.schedule.length,
                app.appliedTermDays,
              ),
              monthlyPremiumCents: creditLifeMonthlyPremiumCents,
              accepted: true,
            })
        const expenseEvidence = createAffordabilityExpenseEvidence(app.client)
        if (affordabilityExpenseEvidenceNeedsMleJustification(expenseEvidence)) {
          return {
            kind: "mle" as const,
            minimumLivingExpenses: expenseEvidence.mle.minimumExpenseCents,
            declaredLivingExpenses: expenseEvidence.statedMonthlyExpensesCents,
          }
        }
        if (!affordabilityExpenseEvidenceIsIntact(expenseEvidence)) {
          return { kind: "expense_invalid" as const }
        }
        const proposedInstalmentCents =
          loanCalc.monthlyInstalment + creditLifePremiumCents
        const assessment = assessAffordability({
          monthlyIncomeCents: app.client.monthlyIncome,
          monthlyExpensesCents: app.client.monthlyExpenses,
          debts: [{ monthlyInstalment: declaredDebtCents }],
          proposedInstalmentCents,
        })
        const snapshot = createAffordabilitySnapshot({
          stage: "ASSESSMENT",
          policyVersion: ASSESSMENT_AFFORDABILITY_POLICY_VERSION,
          capturedAt: assessedAt,
          capturedById: guard.user.id,
          applicationDebts: assessedApplicationDebts,
          clientDebts,
          expenseEvidence,
          calculation: loanCalc,
          calculationStartDate: assessedAt,
          inputs: {
            monthlyIncomeCents: app.client.monthlyIncome,
            monthlyExpensesCents: app.client.monthlyExpenses,
            applicationDebtCents: assessedApplicationDebtCents,
            clientDebtCents,
            declaredDebtCents,
            bureauObligationsCents: 0,
            proposedInstalmentCents,
            creditLifePremiumCents,
            principalCents: app.appliedAmount,
            termDays: app.appliedTermDays,
            productId: app.productId,
            interestRatePm: app.product.interestRatePm,
            productType: app.product.productType,
            interestModel,
            initiationFeeModel: app.product.initiationFeeModel,
            initiationFeePct: app.product.initiationFeePct,
            initiationFeeMaxCents: app.product.initiationFeeMax,
            monthlyServiceFeeCents: app.product.monthlyServiceFee,
            initiationFeePayment: app.initiationFeePayment,
            ndiBufferPct: 100,
          },
          outcome: {
            netDisposableIncomeCents: assessment.netDisposableIncome,
            ndiAfterLoanCents: assessment.ndiAfterLoan,
            requiredNdiCents: proposedInstalmentCents,
            isAffordable: assessment.isAffordable,
            reason: assessment.isAffordable ? null : "Assessment affordability policy failed",
          },
        })
        if (!affordabilityDecisionSnapshotIsIntact(snapshot)) {
          return { kind: "snapshot_invalid" as const }
        }

        const updated = await tx.loanApplication.updateMany({
          where: {
            id,
            tenantId: tenant.id,
            status: app.status,
            updatedAt: app.updatedAt,
          },
          data: {
            existingDebtObligations: debtSnapshot,
            totalExistingDebt: declaredDebtCents,
            netDisposableIncome: assessment.netDisposableIncome,
            affordabilityNDI: assessment.ndiAfterLoan,
            affordabilityResult: withAffordabilitySnapshot(
              app.affordabilityResult,
              snapshot,
            ) as unknown as Prisma.InputJsonValue,
          },
        })
        if (updated.count !== 1) return { kind: "changed" as const }

        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            action: "AFFORDABILITY_ASSESSED",
            entity: "LoanApplication",
            entityId: id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            newValue: {
              ndi: assessment.netDisposableIncome,
              ndiAfterLoan: assessment.ndiAfterLoan,
              isAffordable: assessment.isAffordable,
              debts: debts.length,
              ownLenderLoans: ownLenderDebts.loans.map((loan) => loan.reference),
              applicationDebtFingerprint: affordabilityDebtFingerprint(assessedApplicationDebts),
              clientDebtFingerprint: affordabilityDebtFingerprint(clientDebts),
              snapshotSchemaVersion: AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
            },
          },
        })

        return {
          kind: "assessed" as const,
          id: app.id,
          netDisposableIncome: assessment.netDisposableIncome,
          affordabilityNDI: assessment.ndiAfterLoan,
          isAffordable: assessment.isAffordable,
        }
      })

      if (outcome.kind === "not_found") {
        return NextResponse.json({ error: "Application not found" }, { status: 404 })
      }
      if (outcome.kind === "entity_borrower") {
        return NextResponse.json({ error: new EntityBorrowerError().message }, { status: 409 })
      }
      if (outcome.kind === "locked") {
        return NextResponse.json(
          { error: "Affordability evidence is locked after a lending decision. Reassessment requires returning the application to review." },
          { status: 409 },
        )
      }
      if (outcome.kind === "client_debt_invalid") {
        return NextResponse.json(
          {
            error: "Stored client debt evidence is invalid; repair the client record before reassessment.",
            errors: { [outcome.field]: outcome.message },
          },
          { status: 422 },
        )
      }
      if (outcome.kind === "mle") {
        return NextResponse.json(
          {
            error: "Stored living expenses are below the Regulation 23A minimum without a documented justification.",
            affordabilitySnapshot: "mle_justification_missing",
            minimumLivingExpenses: outcome.minimumLivingExpenses,
            declaredLivingExpenses: outcome.declaredLivingExpenses,
          },
          { status: 422 },
        )
      }
      if (outcome.kind === "expense_invalid") {
        return NextResponse.json(
          {
            error: "Stored client expense evidence is incomplete or inconsistent; repair the client record before reassessment.",
            affordabilitySnapshot: "expense_evidence_invalid",
          },
          { status: 422 },
        )
      }
      if (outcome.kind === "credit_life_invalid") {
        return NextResponse.json(
          {
            error: "Accepted credit-life cover has no intact monthly premium; return the application to draft and recapture the election.",
            affordabilitySnapshot: "credit_life_evidence_invalid",
          },
          { status: 422 },
        )
      }
      if (outcome.kind === "snapshot_invalid") {
        return NextResponse.json(
          {
            error: "The affordability assessment could not be recorded with intact decision evidence.",
            affordabilitySnapshot: "assessment_changed",
          },
          { status: 422 },
        )
      }
      if (outcome.kind === "changed") {
        return NextResponse.json(
          { error: "Application status changed before affordability evidence could be saved; refresh and try again." },
          { status: 409 },
        )
      }
      return NextResponse.json({
        success: true,
        id: outcome.id,
        netDisposableIncome: outcome.netDisposableIncome,
        affordabilityNDI: outcome.affordabilityNDI,
        isAffordable: outcome.isAffordable,
      })
    }) // end withTenantContext
  } catch {
    return NextResponse.json({ error: "Failed to save affordability" }, { status: 500 })
  }
}
