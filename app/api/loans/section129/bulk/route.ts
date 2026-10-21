import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { sendSection129Email, simulatesSection129 } from "@/lib/collections/section129-email"
import { sendMessage } from "@/lib/messaging/send"
import { providerFailureOutcome } from "@/lib/messaging/providers"
import { readKnownAcceptedDispatchEvidence } from "@/lib/messaging/known-dispatch-evidence"
import { isSection129NewSendEnabled } from "@/lib/messaging/flags"
import { normaliseEmail } from "@/lib/contact/identity"
import { CONTACT_NOT_RECIPIENTS, lookupRecipientContact } from "@/lib/contact/recipient"
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
import { hasClientBorrower } from "@/lib/borrower"
import { clientIdsUnderDebtReview } from "@/lib/collections/client-holds"

type BulkSection129Result = {
  loanId: string
  reference: string
  outcome: "SENT" | "SKIPPED" | "FAILED" | "RECOVERY_REQUIRED" | "RECONCILIATION_REQUIRED"
  issuanceId?: string
  error?: string
  /** Recorded as simulated (not sent): a demo stack's .invalid mailbox. */
  simulated?: true
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("COLLECTIONS_OFFICER")
  if (guard.error) return guard.error
  // act_on_collections: the COLLECTIONS_OFFICER ladder minus INSURANCE_OFFICER.
  if (!canDo(guard.user.role, "act_on_collections")) {
    return NextResponse.json({ error: "Your role cannot act on collections." }, { status: 403 })
  }
  const actor = guard.user!

  return withTenantContext(req, async (tenant) => {
    // Every notice prints the tenant's own NCR registration; refuse the whole
    // batch before any work when it is missing or invalid.
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

    // Eligibility refuses a NON_NCA agreement (the regime decides Section 129).
    // The notice itself is a consumer document addressed to a natural person
    // (the Client's name, ID number and address), so an NCA loan to an entity
    // borrower, which has no Client, is skipped too. Both count in `skipped`.
    const consumerLoans = loans.filter(isSection129Eligible).filter(hasClientBorrower)
    // Debt review (NCA s.86) is consumer-wide: a notice on ANY of the client's
    // loans blocks Section 129 on all of them. Reported per loan, never silent.
    const underReview = await clientIdsUnderDebtReview({
      tenantId: tenant.id,
      clientIds: [...new Set(consumerLoans.map((loan) => loan.client.id))],
    })
    const eligible = consumerLoans.filter((loan) => !underReview.has(loan.client.id))
    const noticeDateValue = new Date()
    const noticeDate = section129NoticeDateLabel(noticeDateValue)
    let sent = 0
    let failed = 0
    let skipped = loans.length - eligible.length
    const failures: string[] = []
    const results: BulkSection129Result[] = consumerLoans
      .filter((loan) => underReview.has(loan.client.id))
      .map((loan) => ({
        loanId: loan.id,
        reference: loan.reference,
        outcome: "SKIPPED" as const,
        error: "The client is under debt review (NCA s.86); a Section 129 notice cannot be issued until the notice is cleared",
      }))
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
      // The total outstanding obligation is the amount owing today
      // (section129NoticeAmounts); while default charges are live the arrears
      // include them.
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
        outstandingBalanceFormatted: formatZAR(noticeAmounts.totalOutstanding),
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
          // Only the email transport below simulates; the messaging pipeline never does.
          simulated: !(newSend && template) && await simulatesSection129(tenant.id, loan.client.email),
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
        /** Demo stack, .invalid mailbox: recorded, never sent (lib/collections/section129-email.ts). */
        simulated?: true
      }
      let providerInvoked = false

      if (newSend && template) {
        const emailNormalised = normaliseEmail(loan.client.email)
        // The client's OWN Contact (lib/contact/recipient.ts).
        const recipient = await lookupRecipientContact(prisma, {
          tenantId: tenant.id,
          channel: "EMAIL",
          value: emailNormalised,
          ownerClientId: loan.client.id,
        })
        if (!recipient.ok) {
          result = { ok: false, error: recipient.reason === "NO_CONTACT" ? `no Contact row for ${loan.client.email}` : CONTACT_NOT_RECIPIENTS }
        } else {
          const contact = recipient.contact
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
          // The decision recorded at reservation, never re-taken at send time.
          const simulate = reservation.recordData.simulated === true
          const dispatch = await dispatchSection129UnderEligibilityLock({
            reservation,
            tenantId: tenant.id,
            loanId: loan.id,
            actorId: actor.id,
            actorEmail: actor.email,
            dispatch: (markProviderInvocation) => sendSection129Email({
                tenantId: tenant.id,
                to: loan.client.email,
                toName: clientName,
                subject: `Section 129 Notice — Account ${loan.reference}`,
                html: section129Html({
                  clientName,
                  loanReference: loan.reference,
                  arrearsAmount: noticeAmounts.arrearsAmount,
                  outstandingBalance: noticeAmounts.totalOutstanding,
                  daysInArrears: loan.daysInArrears,
                  noticeDate,
                  lender: lender.identity,
                }),
                text: section129Text({
                  clientName,
                  loanReference: loan.reference,
                  arrearsAmount: noticeAmounts.arrearsAmount,
                  outstandingBalance: noticeAmounts.totalOutstanding,
                  daysInArrears: loan.daysInArrears,
                  noticeDate,
                  lender: lender.identity,
                }),
                category: "section129",
                referenceId: loan.id,
                attachments,
                onProviderDispatchStart: markProviderInvocation,
              }, simulate),
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
          ...(result.simulated ? { simulated: true } : {}),
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
          ...(result.simulated ? { simulated: true } : {}),
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
          ...(result.simulated ? { simulated: true } : {}),
        }).catch(() => {
          // Preserve the non-retryable result even during a DB failure.
        })
        results.push({ loanId: loan.id, reference: loan.reference, outcome: "RECONCILIATION_REQUIRED", issuanceId: reservation.issuanceId, error: "Provider accepted notice but finalisation failed" })
        continue
      }

      sent++
      results.push({
        loanId: loan.id, reference: loan.reference, outcome: "SENT", issuanceId: reservation.issuanceId,
        ...(result.simulated ? { simulated: true } : {}),
      })
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
