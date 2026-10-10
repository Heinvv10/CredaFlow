import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { generateReference } from "@/lib/utils"
import { AuditAction } from "@/lib/audit"
import {
  ContactPromotionConflictError,
  resolveContactForLeadConversion,
} from "@/lib/contact/provision"
import {
  AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
  affordabilityExpenseEvidenceNeedsMleJustification,
  createAffordabilityExpenseEvidence,
  createSubmissionAffordabilitySnapshot,
  withAffordabilitySnapshot,
} from "@/lib/affordability/snapshot"
import { Prisma } from "@prisma/client"
import { lockNewApplicationSubmissionEvidence } from "@/lib/applications/submission-lock"
import { creditBlock } from "@/lib/clients/status"

interface LockedLead {
  id: string
  status: string
  convertedToClientId: string | null
  convertedToApplicationId: string | null
  conversionRecoveryRequired: boolean
}

interface RecoveryApplicationCandidate {
  id: string
  reference: string
}

interface ConversionClient {
  id: string
  reference: string
  idNumber: string
  blacklisted: boolean
  deceasedAt: Date | null
  firstName: string
  lastName: string
  email: string
  phone: string
  whatsapp: string | null
  monthlyIncome: number
  monthlyExpenses: number
}

// Same rule as the portal: a fixed-term product (min == max) takes its own term
// when none is given; otherwise a whole number of days within [min, max].
function resolveTermDays(
  requested: unknown,
  product: { minTermDays: number; maxTermDays: number },
): number | null {
  const term = requested === undefined || requested === null ? null : Number(requested)
  if (product.minTermDays === product.maxTermDays) {
    return term === null ? product.minTermDays : term === product.minTermDays ? term : null
  }
  if (term === null || !Number.isInteger(term) || term <= 0) return null
  return term < product.minTermDays || term > product.maxTermDays ? null : term
}

function classifyAgreementType(amountCents: number): "SMALL" | "INTERMEDIATE" | "LARGE" {
  if (amountCents <= 1_500_000) return "SMALL"
  if (amountCents <= 25_000_000) return "INTERMEDIATE"
  return "LARGE"
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      const { id: leadId } = await params
      const data = await req.json()

      const recoveryApplicationId = typeof data.recoveryApplicationId === "string"
        ? data.recoveryApplicationId.trim()
        : ""
      const recoveryReason = typeof data.recoveryReason === "string"
        ? data.recoveryReason.trim()
        : ""
      // Parse amounts to cents. Selecting an existing recovery application
      // needs neither a fresh affordability declaration nor loan inputs.
      const requestedAmount = Number(data.appliedAmount)
      const amountCents = recoveryApplicationId ? 0 : Math.round(requestedAmount * 100)
      const incomeCents = recoveryApplicationId ? 0 : Math.round((data.monthlyIncome || 0) * 100)
      const expensesCents = recoveryApplicationId ? 0 : Math.round((data.monthlyExpenses || 0) * 100)
      const now = new Date()
      // A rand amount must be finite, positive and exact to the cent: a
      // silently cent-rounded amount differs from what staff typed.
      if (
        !recoveryApplicationId
        && (!Number.isFinite(requestedAmount)
          || requestedAmount <= 0
          || Math.abs(requestedAmount * 100 - amountCents) > 1e-6)
      ) {
        return NextResponse.json(
          { error: "Enter a valid loan amount (rand, at most 2 decimal places)." },
          { status: 422 },
        )
      }
      if (!recoveryApplicationId) {
        const expenseEvidence = createAffordabilityExpenseEvidence({
          monthlyIncome: incomeCents,
          monthlyExpenses: expensesCents,
        })
        if (affordabilityExpenseEvidenceNeedsMleJustification(expenseEvidence)) {
          return NextResponse.json(
            {
              error: "Declared living expenses are below the Regulation 23A minimum. Capture the client's complete expenses or add a documented justification before conversion.",
              minimumLivingExpenses: expenseEvidence.mle.minimumExpenseCents,
            },
            { status: 422 },
          )
        }
      }

      // Use a transaction: create Client + Application + update Lead atomically
      const result = await prisma.$transaction(async (tx) => {
        // Serialize conversion attempts for this exact tenant-scoped lead. A
        // double-submit waits here, then returns the first conversion instead
        // of creating a second client/application or surfacing a P2002 error.
        const [lockedLead] = await tx.$queryRaw<LockedLead[]>(Prisma.sql`
          SELECT "id", "status"::text AS "status", "convertedToClientId", "convertedToApplicationId", "conversionRecoveryRequired"
          FROM "Lead"
          WHERE "id" = ${leadId} AND "tenantId" = ${tenant.id}
          FOR UPDATE
        `)
        if (!lockedLead) return { kind: "not_found" as const }

        if (lockedLead.convertedToApplicationId && !lockedLead.convertedToClientId) {
          return { kind: "invalid_application_link" as const }
        }

        let client: ConversionClient | null = null
        let recoveryMode = false

        if (lockedLead.convertedToClientId) {
          const linkedClient = await tx.client.findUnique({
            where: {
              tenantId_id: {
                tenantId: tenant.id,
                id: lockedLead.convertedToClientId,
              },
            },
            select: {
              id: true,
              reference: true,
              idNumber: true,
              // Selected because the gate below reads them. Omitting either
              // would leave creditBlock() reading undefined — falsy, so a
              // deceased client would convert cleanly and the gate would look
              // present while doing nothing.
              blacklisted: true,
              deceasedAt: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              whatsapp: true,
              monthlyIncome: true,
              monthlyExpenses: true,
            },
          })
          if (!linkedClient) return { kind: "invalid_client_link" as const }

          // Converting a lead originates a LoanApplication for this client, so
          // it is an origination path and carries the same gate as the others.
          // A lead can be linked to a client who was blacklisted or recorded as
          // deceased after the link was made.
          const linkedBlock = creditBlock(linkedClient)
          if (linkedBlock.blocked) {
            return { kind: "client_blocked" as const, reason: linkedBlock.reason }
          }

          if (lockedLead.convertedToApplicationId && !lockedLead.conversionRecoveryRequired) {
            const application = await tx.loanApplication.findFirst({
              where: {
                id: lockedLead.convertedToApplicationId,
                tenantId: tenant.id,
                clientId: linkedClient.id,
              },
              select: { id: true, reference: true },
            })
            if (!application) return { kind: "invalid_application_link" as const }

            // A completed conversion can predate Contact/Lead linking. Repair
            // the safe case idempotently: a canonical Client Contact with no
            // representative Lead and no separate Lead Contact. Repeat-client
            // Contacts that already represent an earlier Lead remain unchanged.
            const contactPromotion = await resolveContactForLeadConversion(tx, {
              tenantId: tenant.id,
              leadId,
              clientId: linkedClient.id,
              firstName: linkedClient.firstName,
              lastName: linkedClient.lastName,
              email: linkedClient.email,
              phone: linkedClient.phone,
              whatsapp: linkedClient.whatsapp,
              source: "MANUAL",
              reuseExistingClientContact: true,
            })
            await tx.auditLog.create({
              data: {
                tenantId: tenant.id,
                userId: guard.user.id ?? null,
                userEmail: guard.user.email ?? null,
                action: contactPromotion.resolution === "REUSED_CLIENT_CONTACT"
                  ? AuditAction.CONTACT_REUSED_FOR_LEAD_CONVERSION
                  : AuditAction.CONTACT_PROMOTED_LEAD_TO_CLIENT,
                entity: "Contact",
                entityId: contactPromotion.contact.id,
                oldValue: contactPromotion.previous ?? Prisma.JsonNull,
                newValue: {
                  leadId: contactPromotion.contact.leadId,
                  conversionLeadId: leadId,
                  clientId: linkedClient.id,
                  status: contactPromotion.contact.status,
                  primaryEmail: contactPromotion.contact.primaryEmail,
                  primaryPhone: contactPromotion.contact.primaryPhone,
                  primaryWaJid: contactPromotion.contact.primaryWaJid,
                  created: contactPromotion.created,
                  resolution: contactPromotion.resolution,
                  reason: "reconciled_completed_lead_conversion",
                },
              },
            })

            if (lockedLead.status !== "CONVERTED") {
              const reconciledAt = new Date()
              await tx.lead.update({
                where: { id: leadId, tenantId: tenant.id },
                data: {
                  status: "CONVERTED",
                  statusChangedAt: reconciledAt,
                  conversionRecoveryRequired: false,
                },
              })
              await tx.auditLog.create({
                data: {
                  tenantId: tenant.id,
                  userId: guard.user.id ?? null,
                  userEmail: guard.user.email ?? null,
                  action: AuditAction.LEAD_STATUS_CHANGED,
                  entity: "Lead",
                  entityId: leadId,
                  oldValue: {
                    status: lockedLead.status,
                    convertedToClientId: lockedLead.convertedToClientId,
                  },
                  newValue: {
                    status: "CONVERTED",
                    convertedToClientId: lockedLead.convertedToClientId,
                    reason: "reconciled_existing_client_link",
                  },
                },
              })
            }

            return {
              kind: "already_converted" as const,
              clientId: lockedLead.convertedToClientId,
              application,
            }
          }

          if (recoveryReason.length < 10) {
            return { kind: "recovery_reason_required" as const }
          }

          if (recoveryApplicationId) {
            // Lock the selected application first, then validate evidence in a
            // separate statement. Under PostgreSQL READ COMMITTED the second
            // statement receives a fresh snapshot after any competing
            // recovery holding this row lock commits, so two leads cannot
            // both pass the ownership check and race the unique link index.
            const [lockedApplication] = await tx.$queryRaw<RecoveryApplicationCandidate[]>(Prisma.sql`
              SELECT application."id", application."reference"
              FROM "LoanApplication" AS application
              WHERE application."id" = ${recoveryApplicationId}
                AND application."tenantId" = ${tenant.id}
                AND application."clientId" = ${linkedClient.id}
              FOR UPDATE OF application
            `)
            if (!lockedApplication) return { kind: "invalid_recovery_application" as const }

            const [application] = await tx.$queryRaw<RecoveryApplicationCandidate[]>(Prisma.sql`
              SELECT application."id", application."reference"
              FROM "LoanApplication" AS application
              WHERE application."id" = ${lockedApplication.id}
                AND application."tenantId" = ${tenant.id}
                AND application."clientId" = ${linkedClient.id}
                AND EXISTS (
                  SELECT 1
                  FROM "AuditLog" AS audit
                  WHERE audit."tenantId" = ${tenant.id}
                    AND audit."action" IN ('APPLICATION_SUBMITTED_BY_CLIENT', 'APPLICATION_SUBMITTED_BY_STAFF')
                    AND audit."entity" = 'LoanApplication'
                    AND audit."entityId" = application."id"
                    AND audit."newValue" ->> 'leadId' = ${leadId}
                    AND audit."newValue" ->> 'clientId' = ${linkedClient.id}
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM "Lead" AS other_lead
                  WHERE other_lead."tenantId" = ${tenant.id}
                    AND other_lead."id" <> ${leadId}
                    AND other_lead."convertedToApplicationId" = application."id"
                )
            `)
            if (!application) return { kind: "invalid_recovery_application" as const }

            const promotion = await resolveContactForLeadConversion(tx, {
              tenantId: tenant.id,
              leadId,
              clientId: linkedClient.id,
              firstName: linkedClient.firstName,
              lastName: linkedClient.lastName,
              email: linkedClient.email,
              phone: linkedClient.phone,
              whatsapp: linkedClient.whatsapp,
              source: "MANUAL",
              reuseExistingClientContact: true,
            })
            await tx.lead.update({
              where: { id: leadId, tenantId: tenant.id },
              data: {
                status: "CONVERTED",
                convertedToApplicationId: application.id,
                conversionRecoveryRequired: false,
              },
            })
            await tx.auditLog.create({
              data: {
                tenantId: tenant.id,
                userId: guard.user.id ?? null,
                userEmail: guard.user.email ?? null,
                action: promotion.resolution === "REUSED_CLIENT_CONTACT"
                  ? AuditAction.CONTACT_REUSED_FOR_LEAD_CONVERSION
                  : AuditAction.CONTACT_PROMOTED_LEAD_TO_CLIENT,
                entity: "Contact",
                entityId: promotion.contact.id,
                oldValue: promotion.previous ?? Prisma.JsonNull,
                newValue: {
                  leadId: promotion.contact.leadId,
                  conversionLeadId: leadId,
                  clientId: linkedClient.id,
                  status: promotion.contact.status,
                  primaryEmail: promotion.contact.primaryEmail,
                  primaryPhone: promotion.contact.primaryPhone,
                  primaryWaJid: promotion.contact.primaryWaJid,
                  created: promotion.created,
                  resolution: promotion.resolution,
                },
              },
            })
            await tx.auditLog.create({
              data: {
                tenantId: tenant.id,
                userId: guard.user.id ?? null,
                userEmail: guard.user.email ?? null,
                action: AuditAction.LEAD_CONVERSION_RECOVERED,
                entity: "Lead",
                entityId: leadId,
                oldValue: {
                  status: lockedLead.status,
                  convertedToClientId: linkedClient.id,
                  convertedToApplicationId: lockedLead.convertedToApplicationId,
                  conversionRecoveryRequired: lockedLead.conversionRecoveryRequired,
                },
                newValue: {
                  status: "CONVERTED",
                  convertedToClientId: linkedClient.id,
                  convertedToApplicationId: application.id,
                  conversionRecoveryRequired: false,
                  recoveryReason,
                  method: "selected_audited_application",
                },
              },
            })
            await tx.crmActivity.create({
              data: {
                leadId,
                tenantId: tenant.id,
                createdById: guard.user.id ?? "admin",
                type: "NOTE",
                subject: "Lead conversion evidence recovered",
                notes: `Linked existing application ${application.reference}. Reason: ${recoveryReason}`,
              },
            })
            return {
              kind: "recovered_existing" as const,
              clientId: linkedClient.id,
              application,
            }
          }

          const candidates = await tx.$queryRaw<RecoveryApplicationCandidate[]>(Prisma.sql`
            SELECT DISTINCT application."id", application."reference"
            FROM "LoanApplication" AS application
            INNER JOIN "AuditLog" AS audit
              ON audit."tenantId" = application."tenantId"
             AND audit."entityId" = application."id"
             AND audit."entity" = 'LoanApplication'
             AND audit."action" IN ('APPLICATION_SUBMITTED_BY_CLIENT', 'APPLICATION_SUBMITTED_BY_STAFF')
            WHERE application."tenantId" = ${tenant.id}
              AND application."clientId" = ${linkedClient.id}
              AND audit."newValue" ->> 'leadId' = ${leadId}
              AND audit."newValue" ->> 'clientId' = ${linkedClient.id}
              AND NOT EXISTS (
                SELECT 1
                FROM "Lead" AS other_lead
                WHERE other_lead."tenantId" = ${tenant.id}
                  AND other_lead."id" <> ${leadId}
                  AND other_lead."convertedToApplicationId" = application."id"
              )
            ORDER BY application."reference"
          `)
          if (candidates.length > 0) {
            return { kind: "recovery_application_selection_required" as const, candidates }
          }

          if (
            linkedClient.idNumber !== data.idNumber
            || linkedClient.email.toLowerCase() !== String(data.email ?? "").trim().toLowerCase()
            || linkedClient.monthlyIncome !== incomeCents
            || linkedClient.monthlyExpenses !== expensesCents
          ) {
            return { kind: "recovery_profile_mismatch" as const }
          }
          client = linkedClient
          recoveryMode = true
        } else {
          if (lockedLead.status === "CONVERTED") return { kind: "stranded" as const }

          // recoveryApplicationId zeroes the loan inputs above and is only
          // honoured for a linked client; here it would create a client and
          // application from amount 0 with no MLE check, so refuse before any write.
          if (recoveryApplicationId) return { kind: "recovery_without_linked_client" as const }

          // Keep the duplicate check under the lead lock. It remains a
          // friendly error; Client unique constraints are the race authority.
          const existing = await tx.client.findFirst({
            where: {
              tenantId: tenant.id,
              OR: [
                { idNumber: data.idNumber },
                { email: data.email },
              ],
            },
            select: { id: true, idNumber: true, email: true },
          })
          if (existing) {
            return {
              kind: "client_conflict" as const,
              conflict: existing.idNumber === data.idNumber ? "ID number" : "email address",
            }
          }
        }

        const product = await tx.loanProduct.findUnique({
          where: { id: data.productId, tenantId: tenant.id },
        })
        if (!product || !product.active) return { kind: "product_unavailable" as const }
        if (resolveTermDays(data.appliedTermDays, product) === null) {
          return {
            kind: "term_out_of_range" as const,
            min: product.minTermDays,
            max: product.maxTermDays,
            name: product.name,
          }
        }
        if (amountCents < product.minAmount || amountCents > product.maxAmount) {
          return {
            kind: "amount_out_of_range" as const,
            min: product.minAmount,
            max: product.maxAmount,
            name: product.name,
          }
        }

        // 1. Create client. The CRM intake captures a single scalar
        // `monthlyExpenses` — the per-category breakdown wasn't asked for at
        // lead-conversion time. To preserve the new invariant ("Client.
        // monthlyExpenses must equal sum(ClientExpenseBreakdown fields)"),
        // park the whole captured total into the `other` bucket and zero the
        // other eight. Staff can re-categorise via the client edit screen
        // afterwards. The pre-transaction MLE gate uses the captured monthly
        // income as the conservative basis because gross income is not
        // available on the lead-conversion form.
        //
        // No POPIA umbrella is captured at lead-convert (`popiaConsentGiven`
        // defaults to `false`), and therefore no granular `ClientConsent`
        // row is written. Consent must be re-captured via the client edit
        // screen before the application can pass `runBureauCheck` —
        // intentional, see `app/api/applications/[id]/review/route.ts`.
        if (!client) {
          client = await tx.client.create({
            data: {
              tenantId: tenant.id,
              reference: generateReference("CLT"),
              idNumber: data.idNumber,
              firstName: data.firstName,
              lastName: data.lastName,
              email: data.email,
              phone: data.phone,
              employmentStatus: data.employmentStatus || null,
              employerName: data.employerName || null,
              monthlyIncome: incomeCents,
              monthlyExpenses: expensesCents,
              referredFromId: leadId,
              expenseBreakdown: {
                create: {
                  housing: 0, transport: 0, food: 0, education: 0, insurance: 0,
                  clothing: 0, entertainment: 0, medical: 0,
                  other: expensesCents,
                },
              },
            },
          })
        }

        // 1b. Promote/reuse the Lead Contact instead of creating a second
        // Contact that collides on its already-owned email and phone.
        const contactPromotion = await resolveContactForLeadConversion(tx, {
          tenantId: tenant.id,
          leadId,
          clientId: client.id,
          firstName: client.firstName,
          lastName: client.lastName,
          email: client.email,
          phone: client.phone,
          whatsapp: client.whatsapp,
          source: "MANUAL",
          reuseExistingClientContact: recoveryMode,
        })
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: guard.user.id ?? null,
            userEmail: guard.user.email ?? null,
            action: contactPromotion.resolution === "REUSED_CLIENT_CONTACT"
              ? AuditAction.CONTACT_REUSED_FOR_LEAD_CONVERSION
              : AuditAction.CONTACT_PROMOTED_LEAD_TO_CLIENT,
            entity: "Contact",
            entityId: contactPromotion.contact.id,
            oldValue: contactPromotion.previous ?? Prisma.JsonNull,
            newValue: {
              leadId: contactPromotion.contact.leadId,
              conversionLeadId: leadId,
              clientId: client.id,
              status: contactPromotion.contact.status,
              primaryEmail: contactPromotion.contact.primaryEmail,
              primaryPhone: contactPromotion.contact.primaryPhone,
              primaryWaJid: contactPromotion.contact.primaryWaJid,
              created: contactPromotion.created,
              resolution: contactPromotion.resolution,
            },
          },
        })

        const evidenceExists = await lockNewApplicationSubmissionEvidence(tx, {
          tenantId: tenant.id,
          clientId: client.id,
          productId: product.id,
        })
        if (!evidenceExists) throw new Error("Application evidence is no longer available")

        // The initial product read gives a friendly validation failure before
        // doing more work. This second read is authoritative: it occurs after
        // the product row lock and feeds the snapshot committed below.
        const lockedProduct = await tx.loanProduct.findUnique({
          where: { id: data.productId, tenantId: tenant.id },
        })
        if (!lockedProduct || !lockedProduct.active) {
          throw new Error("Selected loan product is unavailable")
        }
        const appliedTermDays = resolveTermDays(data.appliedTermDays, lockedProduct)
        if (appliedTermDays === null) {
          throw new Error("Applied term is outside the selected loan product's bounds")
        }
        if (amountCents < lockedProduct.minAmount || amountCents > lockedProduct.maxAmount) {
          throw new Error("Applied amount is outside the selected loan product's bounds")
        }

        const snapshotClient = await tx.client.findUnique({
          where: { id: client.id, tenantId: tenant.id },
          include: { debtObligations: true, expenseBreakdown: true },
        })
        if (!snapshotClient) throw new Error("Client disappeared before application creation")
        const submissionSnapshot = createSubmissionAffordabilitySnapshot({
          capturedAt: now,
          capturedById: guard.user.id ?? null,
          client: snapshotClient,
          applicationDebts: [],
          clientDebts: snapshotClient.debtObligations,
          application: {
            appliedAmount: amountCents,
            appliedTermDays,
            productId: lockedProduct.id,
            initiationFeePayment: "DEFERRED",
          },
          product: {
            interestRatePm: lockedProduct.interestRatePm,
            interestModel: lockedProduct.interestModel,
            initiationFeeModel: lockedProduct.initiationFeeModel,
            initiationFeePct: lockedProduct.initiationFeePct,
            initiationFeeMax: lockedProduct.initiationFeeMax,
            monthlyServiceFee: lockedProduct.monthlyServiceFee,
            productType: lockedProduct.productType,
          },
        })

        // 2. Create application
        const application = await tx.loanApplication.create({
          data: {
            tenantId: tenant.id,
            reference: generateReference("APP"),
            clientId: client.id,
            productId: lockedProduct.id,
            appliedAmount: amountCents,
            appliedTermDays,
            purpose: data.purpose || null,
            loanPurposeCategory: data.loanPurposeCategory || null,
            agreementType: classifyAgreementType(amountCents),
            existingDebtObligations: [],
            totalExistingDebt: 0,
            netDisposableIncome: submissionSnapshot.outcome.netDisposableIncomeCents,
            affordabilityNDI: submissionSnapshot.outcome.ndiAfterLoanCents,
            affordabilityResult: withAffordabilitySnapshot(
              null,
              submissionSnapshot,
            ) as unknown as Prisma.InputJsonValue,
            status: "SUBMITTED",
            submittedAt: now,
            clientAffordabilityDeclaredAt: now,
            recklessLendingAssessed: true,
            recklessLendingAssessedAt: now,
            recklessLendingAssessedById: guard.user.id ?? "admin",
          },
        })

        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: guard.user.id ?? "admin",
            userEmail: guard.user.email,
            action: "APPLICATION_SUBMITTED_BY_STAFF",
            entity: "LoanApplication",
            entityId: application.id,
            newValue: {
              reference: application.reference,
              source: "crm_lead_conversion",
              leadId,
              clientId: client.id,
              productId: lockedProduct.id,
              appliedAmount: amountCents,
              appliedTermDays,
              snapshotSchemaVersion: AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
              decisionFingerprint: submissionSnapshot.decisionFingerprint,
            },
          },
        })
        if (!recoveryMode) {
          await tx.auditLog.create({
            data: {
              tenantId: tenant.id,
              userId: guard.user.id ?? "admin",
              userEmail: guard.user.email,
              action: AuditAction.CLIENT_CREATED,
              entity: "Client",
              entityId: client.id,
              newValue: { leadId, applicationReference: application.reference },
            },
          })
        }

        // 3. Mark lead as converted
        await tx.lead.update({
          where: { id: leadId, tenantId: tenant.id },
          data: {
            status: "CONVERTED",
            ...(!recoveryMode ? { statusChangedAt: new Date() } : {}),
            convertedToClientId: client.id,
            convertedToApplicationId: application.id,
            conversionRecoveryRequired: false,
          },
        })

        // 4. Add conversion activity to lead
        await tx.crmActivity.create({
          data: {
            leadId,
            tenantId: tenant.id,
            createdById: guard.user.id ?? "admin",
            type: "NOTE",
            subject: recoveryMode ? "Lead conversion resumed" : "Lead converted to client",
            notes: recoveryMode
              ? `Created replacement application ${application.reference} against existing client ${client.reference}. Reason: ${recoveryReason}`
              : `Client record created: ${client.firstName} ${client.lastName} (${client.reference}). Application ${application.reference} submitted.`,
          },
        })

        // Fail closed on conversion evidence: the lead/client/application and
        // all audit rows commit or roll back together.
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: guard.user.id ?? null,
            userEmail: guard.user.email ?? null,
            action: recoveryMode
              ? AuditAction.LEAD_CONVERSION_RECOVERED
              : AuditAction.LEAD_CONVERTED,
            entity: "Lead",
            entityId: leadId,
            oldValue: {
              status: lockedLead.status,
              convertedToClientId: lockedLead.convertedToClientId,
              convertedToApplicationId: lockedLead.convertedToApplicationId,
              conversionRecoveryRequired: lockedLead.conversionRecoveryRequired,
            },
            newValue: {
              status: "CONVERTED",
              convertedToClientId: client.id,
              convertedToApplicationId: application.id,
              applicationReference: application.reference,
              conversionRecoveryRequired: false,
              ...(recoveryMode
                ? { recoveryReason, method: "created_replacement_application" }
                : {}),
            },
          },
        })

        return recoveryMode
          ? { kind: "recovered_created" as const, client, application }
          : { kind: "created" as const, client, application }
      })

      if (result.kind === "not_found") {
        return NextResponse.json({ error: "Lead not found" }, { status: 404 })
      }
      if (result.kind === "stranded") {
        return NextResponse.json(
          { error: "Lead conversion is incomplete. Reset it before retrying." },
          { status: 409 },
        )
      }
      if (result.kind === "recovery_reason_required") {
        return NextResponse.json(
          { error: "A recovery reason of at least 10 characters is required." },
          { status: 422 },
        )
      }
      if (result.kind === "recovery_without_linked_client") {
        return NextResponse.json(
          { error: "This lead has no linked client, so there is no application to recover. Convert it without selecting an application." },
          { status: 422 },
        )
      }
      if (result.kind === "recovery_application_selection_required") {
        return NextResponse.json(
          {
            error: "Select the exact audited application before completing recovery.",
            candidates: result.candidates,
          },
          { status: 409 },
        )
      }
      if (result.kind === "recovery_profile_mismatch") {
        return NextResponse.json(
          { error: "The recovery form must use the linked client's stored identity and affordability profile." },
          { status: 409 },
        )
      }
      if (
        result.kind === "invalid_client_link"
        || result.kind === "invalid_application_link"
        || result.kind === "invalid_recovery_application"
      ) {
        return NextResponse.json(
          { error: "Lead conversion has an invalid cross-record link. Repair it before retrying." },
          { status: 409 },
        )
      }
      if (result.kind === "client_blocked") {
        return NextResponse.json(
          {
            error: result.reason === "DECEASED"
              ? "This lead is linked to a client recorded as deceased. A new credit agreement cannot be opened."
              : "This lead is linked to a blacklisted client. A new credit agreement cannot be opened.",
          },
          { status: 422 },
        )
      }
      if (result.kind === "client_conflict") {
        return NextResponse.json(
          { error: `A client with this ${result.conflict} already exists.` },
          { status: 409 },
        )
      }
      if (result.kind === "product_unavailable") {
        return NextResponse.json(
          { error: "Selected loan product is unavailable" },
          { status: 422 },
        )
      }
      if (result.kind === "term_out_of_range") {
        return NextResponse.json(
          { error: `Term must be between ${result.min} and ${result.max} days for ${result.name}.` },
          { status: 422 },
        )
      }
      if (result.kind === "amount_out_of_range") {
        return NextResponse.json(
          { error: `Amount must be between R${(result.min / 100).toLocaleString()} and R${(result.max / 100).toLocaleString()} for ${result.name}.` },
          { status: 422 },
        )
      }
      if (result.kind === "already_converted") {
        return NextResponse.json({
          clientId: result.clientId,
          applicationId: result.application?.id ?? null,
          applicationReference: result.application?.reference ?? null,
          alreadyConverted: true,
        })
      }
      if (result.kind === "recovered_existing") {
        return NextResponse.json({
          clientId: result.clientId,
          applicationId: result.application.id,
          applicationReference: result.application.reference,
          recovered: true,
          alreadyConverted: true,
        })
      }

      return NextResponse.json({
        clientId: result.client.id,
        applicationId: result.application.id,
        applicationReference: result.application.reference,
        recovered: result.kind === "recovered_created",
        alreadyConverted: false,
      })
    } catch (err) {
      if (err instanceof ContactPromotionConflictError) {
        return NextResponse.json(
          {
            error: "The lead and client directory records cannot be promoted automatically. Resolve the Contact merge or identity collision, then retry.",
            reason: err.reason,
          },
          { status: 409 },
        )
      }
      console.error("Convert lead error:", err)
      return NextResponse.json({ error: "Failed to convert lead" }, { status: 500 })
    }
  })
}
