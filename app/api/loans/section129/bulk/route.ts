import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { sendEmail } from "@/lib/email/service"
import { sendMessage } from "@/lib/messaging/send"
import { providerFailureOutcome } from "@/lib/messaging/providers"
import { readKnownAcceptedDispatchEvidence } from "@/lib/messaging/known-dispatch-evidence"
import { isSection129NewSendEnabled } from "@/lib/messaging/flags"
import { lookupContactByChannelValue, normaliseEmail } from "@/lib/contact/identity"
import { section129Html, section129Text } from "@/lib/email/templates/section129"
import { buildSection129Attachments } from "@/lib/email/section129-attachments"
import { loanSettlementFigures, section129NoticeAmounts } from "@/lib/loan/charges-summary"
import { lenderIdentityOrRefusal } from "@/lib/config/identity-response"
import { getLenderLogo } from "@/lib/config/lender-logo"
import { formatZAR } from "@/lib/utils"
import {
  isSection129Eligible,
  COLLECTIONS_ELIGIBLE_STATUSES,
  SECTION129_MIN_DAYS_IN_ARREARS,
} from "@/lib/collections/section129-eligibility"
import {
  dispatchSection129UnderEligibilityLock,
  finaliseSection129Issuance,
  markSection129KnownNotSent,
  markSection129ReconciliationRequired,
  reserveSection129Issuance,
  section129NoticeDateLabel,
  Section129DispatchUncertainError,
  Section129IssuanceConflictError,
} from "@/lib/collections/section129-artifact"

type BulkSection129Result = {
  loanId: string
  reference: string
  outcome: "SENT" | "SKIPPED" | "FAILED" | "RECOVERY_REQUIRED" | "RECONCILIATION_REQUIRED"
  issuanceId?: string
  error?: string
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("COLLECTIONS_OFFICER")
  if (guard.error) return guard.error
  const actor = guard.user!

  return withTenantContext(req, async (tenant) => {
    // Every notice prints the tenant's own NCR registration; refuse the whole
    // batch before any work when it is missing or invalid (audit F-11).
    const lender = await lenderIdentityOrRefusal(tenant.id)
    if (lender.refusal) return lender.refusal
    const logo = await getLenderLogo(tenant.id)

    const loans = await prisma.loan.findMany({
      where: {
        tenantId: tenant.id,
        status: { in: [...COLLECTIONS_ELIGIBLE_STATUSES] },
        daysInArrears: { gte: SECTION129_MIN_DAYS_IN_ARREARS },
        arrearsAmount: { gt: 0 },
        outstandingPrincipal: { gt: 0 },
      },
      include: { client: true, repaymentSchedule: { orderBy: { dueDate: "asc" } } },
    })

    const eligible = loans.filter(isSection129Eligible)
    const noticeDateValue = new Date()
    const noticeDate = section129NoticeDateLabel(noticeDateValue)
    let sent = 0
    let failed = 0
    let skipped = loans.length - eligible.length
    const failures: string[] = []
    const results: BulkSection129Result[] = []
    const newSend = isSection129NewSendEnabled()

    const template = newSend
      ? await prisma.messageTemplate.findFirst({
          where: {
            tenantId: tenant.id,
            key: "section129_email",
            channel: "EMAIL",
            active: true,
          },
        })
      : null
    if (newSend && !template) {
      return NextResponse.json(
        { ok: false, error: "section129_email MessageTemplate not found or inactive — create the tenant's own template / re-enable the row before flipping MESSAGING_NEW_SEND_S129" },
        { status: 500 },
      )
    }
    if (newSend && template && template.statutoryOverride !== true) {
      return NextResponse.json(
        { ok: false, error: "section129_email MessageTemplate has statutoryOverride=false — refusing to dispatch a Section 129 notice without the statutory bypass" },
        { status: 500 },
      )
    }

    for (const loan of eligible) {
      const clientName = `${loan.client.firstName} ${loan.client.lastName}`
      // While default charges are live the notice states arrears plus charges,
      // and the amount owing today as the total outstanding obligation.
      let figures
      try {
        figures = await loanSettlementFigures(prisma, loan, noticeDateValue)
      } catch (error) {
        // One loan's figures must not stop the batch; it is reported and skipped
        // before anything is reserved or sent.
        failed++
        const message = `Amount calculation failed: ${error instanceof Error ? error.message : String(error)}`
        failures.push(`${loan.reference}: ${message}`)
        results.push({ loanId: loan.id, reference: loan.reference, outcome: "FAILED", error: message })
        continue
      }
      const noticeAmounts = section129NoticeAmounts(loan, figures)
      const emailVars = {
        clientName,
        loanReference: loan.reference,
        daysInArrears: String(loan.daysInArrears),
        arrearsAmountFormatted: formatZAR(noticeAmounts.arrearsAmount),
        outstandingBalanceFormatted: formatZAR(noticeAmounts.totalOutstanding ?? noticeAmounts.outstandingPrincipal),
        noticeDate,
      }

      let attachments
      let reservation
      try {
        attachments = await buildSection129Attachments({
          lender: lender.identity,
          logo,
          client: {
            firstName: loan.client.firstName,
            lastName: loan.client.lastName,
            idNumber: loan.client.idNumber,
            addressLine1: loan.client.addressLine1 ?? undefined,
            city: loan.client.city ?? undefined,
          },
          loan: {
            reference: loan.reference,
            ...noticeAmounts,
            daysInArrears: loan.daysInArrears,
          },
          noticeDate: noticeDateValue,
        })
        const pdfAttachment = attachments.find((attachment) => attachment.contentType === "application/pdf")
        reservation = await reserveSection129Issuance({
          tenantId: tenant.id,
          loanId: loan.id,
          loanReference: loan.reference,
          clientName,
          clientEmail: loan.client.email,
          clientFirstName: loan.client.firstName,
          clientLastName: loan.client.lastName,
          clientIdNumber: loan.client.idNumber,
          clientAddressLine1: loan.client.addressLine1,
          clientCity: loan.client.city,
          ...noticeAmounts,
          daysInArrears: loan.daysInArrears,
          noticeDate,
          pdf: pdfAttachment?.content as Buffer,
          createdById: actor.id,
          createdByEmail: actor.email,
          bulk: true,
        })
      } catch (error) {
        if (error instanceof Section129IssuanceConflictError) {
          skipped++
          failures.push(`${loan.reference}: ${error.message}`)
          results.push({
            loanId: loan.id,
            reference: loan.reference,
            outcome: error.lifecycle === "RECONCILIATION_REQUIRED" || error.lifecycle === "DISPATCHING"
              ? "RECONCILIATION_REQUIRED"
              : "SKIPPED",
            issuanceId: error.issuanceId ?? undefined,
            error: error.message,
          })
        } else {
          failed++
          const message = `PDF generation/reservation failed: ${error instanceof Error ? error.message : String(error)}`
          failures.push(`${loan.reference}: ${message}`)
          results.push({ loanId: loan.id, reference: loan.reference, outcome: "FAILED", error: message })
        }
        continue
      }

      let result: {
        ok: boolean
        messageId?: string
        providerEvidenceReference?: string
        providerPersistenceWarning?: string
        emergencyEvidenceAuditPersisted?: boolean
        acceptedAt?: Date
        error?: string
        providerOutcome?: "ACCEPTED" | "DEFINITELY_REJECTED" | "AMBIGUOUS"
      }
      let providerInvoked = false

      if (newSend && template) {
        const emailNormalised = normaliseEmail(loan.client.email)
        const contact = await lookupContactByChannelValue(prisma, {
          tenantId: tenant.id,
          channel: "EMAIL",
          value: emailNormalised,
        })
        if (!contact) {
          result = { ok: false, error: `no Contact row for ${loan.client.email}` }
        } else {
          try {
            const dispatch = await dispatchSection129UnderEligibilityLock({
              reservation,
              tenantId: tenant.id,
              loanId: loan.id,
              actorId: actor.id,
              actorEmail: actor.email,
              dispatch: (markProviderInvocation) => sendMessage({
                contactId: contact.id,
                channel: "EMAIL",
                template,
                vars: emailVars,
                toValue: emailNormalised,
                category: "section129",
                loanId: loan.id,
                createdById: actor.id,
                attachments,
                automaticRetry: false,
                onProviderDispatchStart: markProviderInvocation,
              }),
            })
            if (dispatch.kind === "INELIGIBLE") {
              skipped++
              failures.push(`${loan.reference}: ${dispatch.error.message}`)
              results.push({ loanId: loan.id, reference: loan.reference, outcome: "SKIPPED", issuanceId: reservation.issuanceId, error: dispatch.error.message })
              continue
            }
            if (dispatch.kind === "SNAPSHOT_CHANGED") {
              skipped++
              failures.push(`${loan.reference}: ${dispatch.error.message}`)
              results.push({ loanId: loan.id, reference: loan.reference, outcome: "SKIPPED", issuanceId: reservation.issuanceId, error: dispatch.error.message })
              continue
            }
            providerInvoked = dispatch.providerInvoked
            if (dispatch.kind === "PROVIDER_THREW") {
              const knownAcceptance = readKnownAcceptedDispatchEvidence(dispatch.error)
              result = knownAcceptance
                ? {
                    ok: true,
                    messageId: knownAcceptance.providerMessageId,
                    providerEvidenceReference: knownAcceptance.providerEvidenceReference,
                    providerPersistenceWarning: knownAcceptance.persistenceWarning,
                    emergencyEvidenceAuditPersisted: knownAcceptance.emergencyAuditPersisted,
                    acceptedAt: knownAcceptance.acceptedAt,
                    providerOutcome: "ACCEPTED",
                  }
                : {
                    ok: false,
                    error: dispatch.error.message,
                    providerOutcome: providerFailureOutcome(dispatch.error),
                  }
            } else {
              result = {
                ok: true,
                messageId: dispatch.value.dispatchProviderMessageId
                  ?? dispatch.value.providerMessageId
                  ?? undefined,
                providerEvidenceReference: dispatch.value.dispatchEvidenceReference ?? undefined,
                acceptedAt: dispatch.value.dispatchProviderAcceptedAt
                  ?? dispatch.value.sentAt
                  ?? undefined,
                providerOutcome: "ACCEPTED",
              }
            }
          } catch (error) {
            if (error instanceof Section129DispatchUncertainError) {
              failed++
              failures.push(`${loan.reference}: ${error.message}`)
              results.push({ loanId: loan.id, reference: loan.reference, outcome: "RECONCILIATION_REQUIRED", issuanceId: reservation.issuanceId, error: error.message })
              continue
            }
            result = { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        }
      } else {
        try {
          const dispatch = await dispatchSection129UnderEligibilityLock({
            reservation,
            tenantId: tenant.id,
            loanId: loan.id,
            actorId: actor.id,
            actorEmail: actor.email,
            dispatch: (markProviderInvocation) => sendEmail({
                tenantId: tenant.id,
                to: loan.client.email,
                toName: clientName,
                subject: `Section 129 Notice — Account ${loan.reference}`,
                html: section129Html({
                  clientName,
                  loanReference: loan.reference,
                  arrearsAmount: noticeAmounts.arrearsAmount,
                  outstandingBalance: noticeAmounts.totalOutstanding ?? noticeAmounts.outstandingPrincipal,
                  daysInArrears: loan.daysInArrears,
                  noticeDate,
                  lender: lender.identity,
                }),
                text: section129Text({
                  clientName,
                  loanReference: loan.reference,
                  arrearsAmount: noticeAmounts.arrearsAmount,
                  outstandingBalance: noticeAmounts.totalOutstanding ?? noticeAmounts.outstandingPrincipal,
                  daysInArrears: loan.daysInArrears,
                  noticeDate,
                  lender: lender.identity,
                }),
                category: "section129",
                referenceId: loan.id,
                attachments,
                onProviderDispatchStart: markProviderInvocation,
              }),
          })
          if (dispatch.kind === "INELIGIBLE") {
            skipped++
            failures.push(`${loan.reference}: ${dispatch.error.message}`)
            results.push({ loanId: loan.id, reference: loan.reference, outcome: "SKIPPED", issuanceId: reservation.issuanceId, error: dispatch.error.message })
            continue
          }
          if (dispatch.kind === "SNAPSHOT_CHANGED") {
            skipped++
            failures.push(`${loan.reference}: ${dispatch.error.message}`)
            results.push({ loanId: loan.id, reference: loan.reference, outcome: "SKIPPED", issuanceId: reservation.issuanceId, error: dispatch.error.message })
            continue
          }
          providerInvoked = dispatch.providerInvoked
          result = dispatch.kind === "PROVIDER_THREW"
            ? { ok: false, error: dispatch.error.message }
            : {
                ...dispatch.value,
                providerPersistenceWarning: dispatch.value.emailLogPersistenceError
                  ? `EmailLog persistence failed after provider acceptance: ${dispatch.value.emailLogPersistenceError}`
                  : undefined,
              }
        } catch (error) {
          if (error instanceof Section129DispatchUncertainError) {
            failed++
            failures.push(`${loan.reference}: ${error.message}`)
            results.push({ loanId: loan.id, reference: loan.reference, outcome: "RECONCILIATION_REQUIRED", issuanceId: reservation.issuanceId, error: error.message })
            continue
          }
          result = { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }

      if (!result.ok) {
        const reconciliationRequired = providerInvoked
          && result.providerOutcome !== "DEFINITELY_REJECTED"
        failed++
        failures.push(`${loan.reference}: ${result.error ?? "dispatch failed"}${reconciliationRequired ? " (reconciliation required; do not retry)" : ""}`)
        if (reconciliationRequired) {
          await markSection129ReconciliationRequired({
            reservation,
            tenantId: tenant.id,
            loanId: loan.id,
            actorId: actor.id,
            actorEmail: actor.email,
            reason: result.error ?? "Provider outcome unknown",
          }).catch(() => {
            // DISPATCHING remains idempotency-locked and stale recovery will
            // promote it. Continue the batch without making this retryable.
          })
        } else {
          try {
            await markSection129KnownNotSent({
              reservation,
              tenantId: tenant.id,
              loanId: loan.id,
              actorId: actor.id,
              actorEmail: actor.email,
              reason: result.error ?? "Provider was not invoked",
            })
          } catch (cleanupError) {
            const cleanupMessage = `provider not invoked, but private artifact cleanup failed; admin recovery required: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
            failures[failures.length - 1] = `${loan.reference}: ${cleanupMessage}`
            results.push({
              loanId: loan.id,
              reference: loan.reference,
              outcome: "RECOVERY_REQUIRED",
              issuanceId: reservation.issuanceId,
              error: cleanupMessage,
            })
            continue
          }
        }
        results.push({
          loanId: loan.id,
          reference: loan.reference,
          outcome: reconciliationRequired ? "RECONCILIATION_REQUIRED" : "FAILED",
          issuanceId: reservation.issuanceId,
          error: result.error ?? "dispatch failed",
        })
        continue
      }

      if (!result.acceptedAt) {
        failed++
        const error = "Provider accepted notice without a persisted acceptance timestamp"
        failures.push(`${loan.reference}: ${error} (reconciliation required; do not retry)`)
        await markSection129ReconciliationRequired({
          reservation,
          tenantId: tenant.id,
          loanId: loan.id,
          actorId: actor.id,
          actorEmail: actor.email,
          reason: error,
          ...(result.messageId ? { providerMessageId: result.messageId } : {}),
          ...(result.providerEvidenceReference
            ? { providerEvidenceReference: result.providerEvidenceReference }
            : {}),
          ...(result.providerPersistenceWarning
            ? { providerPersistenceWarning: result.providerPersistenceWarning }
            : {}),
          ...(result.emergencyEvidenceAuditPersisted !== undefined
            ? { emergencyEvidenceAuditPersisted: result.emergencyEvidenceAuditPersisted }
            : {}),
        }).catch(() => {
          // The active key remains non-retryable even if the promotion fails.
        })
        results.push({
          loanId: loan.id,
          reference: loan.reference,
          outcome: "RECONCILIATION_REQUIRED",
          issuanceId: reservation.issuanceId,
          error,
        })
        continue
      }

      try {
        await finaliseSection129Issuance({
          reservation,
          tenantId: tenant.id,
          loanId: loan.id,
          issuedById: actor.id,
          issuedByEmail: actor.email,
          emailMessageId: result.messageId,
          ...(result.providerEvidenceReference
            ? { providerEvidenceReference: result.providerEvidenceReference }
            : {}),
          ...(result.providerPersistenceWarning
            ? { providerPersistenceWarning: result.providerPersistenceWarning }
            : {}),
          ...(result.emergencyEvidenceAuditPersisted !== undefined
            ? { emergencyEvidenceAuditPersisted: result.emergencyEvidenceAuditPersisted }
            : {}),
          issuedAt: result.acceptedAt,
        })
      } catch (error) {
        failed++
        failures.push(`${loan.reference}: provider accepted notice but finalisation failed (reconciliation required; do not retry)`)
        await markSection129ReconciliationRequired({
          reservation,
          tenantId: tenant.id,
          loanId: loan.id,
          actorId: actor.id,
          actorEmail: actor.email,
          reason: `Provider accepted dispatch but finalisation failed: ${error instanceof Error ? error.message : String(error)}`,
          ...(result.messageId ? { providerMessageId: result.messageId } : {}),
          ...(result.providerEvidenceReference
            ? { providerEvidenceReference: result.providerEvidenceReference }
            : {}),
          providerAcceptedAt: result.acceptedAt,
          ...(result.providerPersistenceWarning
            ? { providerPersistenceWarning: result.providerPersistenceWarning }
            : {}),
          ...(result.emergencyEvidenceAuditPersisted !== undefined
            ? { emergencyEvidenceAuditPersisted: result.emergencyEvidenceAuditPersisted }
            : {}),
        }).catch(() => {
          // Preserve the non-retryable result even during a DB incident.
        })
        results.push({ loanId: loan.id, reference: loan.reference, outcome: "RECONCILIATION_REQUIRED", issuanceId: reservation.issuanceId, error: "Provider accepted notice but finalisation failed" })
        continue
      }

      sent++
      results.push({ loanId: loan.id, reference: loan.reference, outcome: "SENT", issuanceId: reservation.issuanceId })
    }

    return NextResponse.json({
      ok: failed === 0 && results.every((result) => !["RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED"].includes(result.outcome)),
      sent,
      failed,
      skipped,
      reconciliationRequired: results.filter((result) => result.outcome === "RECONCILIATION_REQUIRED").length,
      recoveryRequired: results.filter((result) => result.outcome === "RECOVERY_REQUIRED").length,
      failures,
      results,
    })
  })
}
