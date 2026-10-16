import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { evaluateCollectionsEligibility } from "@/lib/collections/section129-eligibility"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import {
  isCollectionsStageAtOrAfter,
  wouldRegressCollectionsStage,
} from "@/lib/collections/stages"

interface ReferralBody {
  firmId?: string
  firmName: string
  contactPerson?: string
  contactPhone?: string
  contactEmail?: string
  referralDate: string
  matterNumber?: string
  notes?: string
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("COLLECTIONS_OFFICER")
    if (guard.error) return guard.error
    // act_on_collections: the COLLECTIONS_OFFICER ladder minus INSURANCE_OFFICER.
    if (!canDo(guard.user.role, "act_on_collections")) {
      return NextResponse.json({ error: "Your role cannot act on collections." }, { status: 403 })
    }

    return await withTenantContext(req, async (tenant) => {
      const { id } = await params
      const body: ReferralBody = await req.json()

      if (!body.firmName) {
        return NextResponse.json({ error: "firmName required" }, { status: 422 })
      }

      const mutation = await prisma.$transaction(async (tx) => {
        // A concurrent payment can cure or settle the account. Lock and
        // re-evaluate inside the mutation transaction before creating any
        // attorney matter or advancing the collections stage.
        await lockLoanForUpdate(tx, id)
        const loan = await tx.loan.findFirst({
          where: { id, tenantId: tenant.id },
          select: {
            id: true,
            status: true,
            ncaRegime: true,
            arrearsAmount: true,
            outstandingPrincipal: true,
            daysInArrears: true,
            collectionsStage: true,
          },
        })
        if (!loan) return { kind: "NOT_FOUND" as const }

        const eligibility = evaluateCollectionsEligibility(loan, "DUNNING")
        if (!eligibility.eligible) {
          return { kind: "INELIGIBLE" as const, reason: eligibility.reason }
        }
        if (!isCollectionsStageAtOrAfter(loan.collectionsStage, "SECTION_129_SENT")) {
          return { kind: "NOTICE_REQUIRED" as const }
        }
        if (wouldRegressCollectionsStage(loan.collectionsStage, "ATTORNEY_REFERRED")) {
          return { kind: "STAGE_CONFLICT" as const, currentStage: loan.collectionsStage }
        }

        // Referral is a preparatory legal-review step only. It requires an
        // immutable issued-notice record, but it does not assert delivery or
        // that the separate NCA s130 enforcement prerequisites have elapsed.
        const issuedNotice = await tx.complianceRecord.findFirst({
          where: {
            tenantId: tenant.id,
            type: "SECTION_129_NOTICE",
            referenceId: id,
            status: "COMPLETED",
            completedAt: { not: null },
            data: { path: ["lifecycle"], equals: "ISSUED" },
          },
          select: { id: true, completedAt: true },
          orderBy: { completedAt: "desc" },
        })
        if (!issuedNotice) return { kind: "NOTICE_REQUIRED" as const }

        const previousReferral = await tx.attorneyReferral.findUnique({
          where: { loanId: id },
          select: { id: true, firmName: true, matterNumber: true },
        })
        const ref = await tx.attorneyReferral.upsert({
          where: { loanId: id },
          update: {
            firmId: body.firmId ?? null,
            firmName: body.firmName,
            contactPerson: body.contactPerson ?? null,
            contactPhone: body.contactPhone ?? null,
            contactEmail: body.contactEmail ?? null,
            referralDate: new Date(body.referralDate ?? new Date()),
            matterNumber: body.matterNumber ?? null,
            notes: body.notes ?? null,
            createdById: guard.user.id,
          },
          create: {
            loanId: id,
            firmId: body.firmId ?? null,
            firmName: body.firmName,
            contactPerson: body.contactPerson ?? null,
            contactPhone: body.contactPhone ?? null,
            contactEmail: body.contactEmail ?? null,
            referralDate: new Date(body.referralDate ?? new Date()),
            matterNumber: body.matterNumber ?? null,
            notes: body.notes ?? null,
            createdById: guard.user.id,
          },
        })

        if (loan.collectionsStage !== "ATTORNEY_REFERRED") {
          await tx.loan.update({
            where: { id, tenantId: tenant.id },
            data: {
              collectionsStage: "ATTORNEY_REFERRED",
              collectionsStageUpdatedAt: new Date(),
            },
          })
        }

        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            action: previousReferral
              ? "ATTORNEY_REFERRAL_UPDATED"
              : "ATTORNEY_REFERRAL_CREATED",
            entity: "Loan",
            entityId: id,
            oldValue: {
              stage: loan.collectionsStage,
              ...(previousReferral ? { referral: previousReferral } : {}),
            },
            newValue: {
              referralId: ref.id,
              stage: "ATTORNEY_REFERRED",
              firmName: body.firmName,
              matterNumber: body.matterNumber ?? null,
              issuedNoticeId: issuedNotice.id,
              legalScope: "PRE_ENFORCEMENT_REVIEW_ONLY",
            },
          },
        })

        return { kind: "CREATED" as const, referral: ref }
      })

      if (mutation.kind === "NOT_FOUND") {
        return NextResponse.json({ error: "Loan not found" }, { status: 404 })
      }
      if (mutation.kind === "INELIGIBLE") {
        return NextResponse.json(
          { error: `Cannot refer this account to an attorney: ${mutation.reason}.` },
          { status: 422 },
        )
      }
      if (mutation.kind === "NOTICE_REQUIRED") {
        return NextResponse.json(
          { error: "Pre-enforcement legal review requires a completed issued Section 129 notice for this loan." },
          { status: 422 },
        )
      }
      if (mutation.kind === "STAGE_CONFLICT") {
        return NextResponse.json(
          { error: `Cannot move collections stage from ${mutation.currentStage} to ATTORNEY_REFERRED.` },
          { status: 409 },
        )
      }
      const referral = mutation.referral

      return NextResponse.json(referral)
    })
  } catch {
    return NextResponse.json({ error: "Failed to create attorney referral" }, { status: 500 })
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params

    const loan = await prisma.loan.findFirst({
      where: { id, tenantId: tenant.id },
      select: { id: true },
    })
    if (!loan) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const referral = await prisma.attorneyReferral.findUnique({ where: { loanId: id } })
    return NextResponse.json(referral)
  })
}
