import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { sendSection129Email, section129SentMessage } from "@/lib/collections/section129-email"
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
import { triggerNotification } from "@/lib/notifications"
import { logAudit } from "@/lib/audit"
import {
  evaluateCollectionsEligibility,
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
import { SECTION129_BORROWER_INCLUDE, section129Addressee } from "@/lib/collections/section129-addressee"

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("COLLECTIONS_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { loanId } = await req.json()
    if (!loanId) return NextResponse.json({ error: "loanId required" }, { status: 400 })

    const loan = await prisma.loan.findUnique({
      where: { id: loanId, tenantId: tenant.id },
      include: { ...SECTION129_BORROWER_INCLUDE, repaymentSchedule: { orderBy: { dueDate: "asc" } } },
    })
    if (!loan) return NextResponse.json({ error: "Loan not found" }, { status: 404 })

    // The PDF endpoint uses this exact predicate too. A statutory default
    // document must never be renderable for a state the dispatch route refuses.
    // It refuses a NON_NCA agreement first: the regime is the primary rule.
    const eligibility = evaluateCollectionsEligibility(loan, "SECTION_129")
    if (!eligibility.eligible) {
      return NextResponse.json(
        { error: `Cannot issue a Section 129 default notice: ${eligibility.reason}.` },
        { status: 422 }
      )
    }
    const addressee = section129Addressee(loan)
    if (!addressee) return NextResponse.json({ error: "The borrower has no active authorised contact for statutory delivery" }, { status: 409 })

    // The notice prints the tenant's own NCR registration; refuse before any
    // work when it is missing or invalid.
    const lender = await lenderIdentityOrRefusal(tenant.id)
    if (lender.refusal) return lender.refusal
    const logo = await getLenderLogo(tenant.id)

    const noticeDateValue = new Date()
    const noticeDate = section129NoticeDateLabel(noticeDateValue)
    // While default charges are live the notice states arrears plus charges,
    // and the amount owing today as the total outstanding obligation.
    const figures = await loanSettlementFigures(prisma, loan, noticeDateValue)
    const noticeAmounts = section129NoticeAmounts(loan, figures)

    const clientName = addressee.displayName

    // Mirrors app/api/loans/section129/bulk/route.ts EXACTLY: same flag, same
    // template resolution + hard-fail-on-misconfig semantics, same legacy
    // fallback when the flag is off. Single source of statutory-send logic
    // between the two routes so they can't silently diverge.
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

    const attachments = await buildSection129Attachments({
      lender: lender.identity,
      logo,
      client: {
        firstName: addressee.firstName,
        lastName: addressee.lastName,
        idNumber: addressee.identityNumber,
        identityLabel: addressee.identityLabel,
        addressLine1: addressee.addressLine1 ?? undefined,
        city: addressee.city ?? undefined,
      },
      loan: {
        reference: loan.reference,
        ...noticeAmounts,
        daysInArrears: loan.daysInArrears,
      },
      noticeDate: noticeDateValue,
    })
    const pdfAttachment = attachments.find((attachment) => attachment.contentType === "application/pdf")
    let reservation
    try {
      reservation = await reserveSection129Issuance({
        tenantId: tenant.id,
        loanId: loan.id,
        loanReference: loan.reference,
        clientName,
        clientEmail: addressee.email,
        clientFirstName: addressee.firstName,
        clientLastName: addressee.lastName,
        clientIdNumber: addressee.identityNumber,
        clientAddressLine1: addressee.addressLine1,
        clientCity: addressee.city,
        ...noticeAmounts,
        daysInArrears: loan.daysInArrears,
        noticeDate,
        pdf: pdfAttachment?.content as Buffer,
        createdById: guard.user.id,
        createdByEmail: guard.user.email,
      })
    } catch (error) {
      if (error instanceof Section129IssuanceConflictError) {
        return NextResponse.json(
          {
            ok: false,
            error: error.message,
            issuanceId: error.issuanceId,
            lifecycle: error.lifecycle,
            reconciliationRequired: error.lifecycle === "RECONCILIATION_REQUIRED" || error.lifecycle === "DISPATCHING",
          },
          { status: 409 },
        )
      }
      await logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: "SECTION_129_ISSUANCE_RESERVATION_FAILED",
        entity: "Loan",
        entityId: loan.id,
        newValue: { error: error instanceof Error ? error.message : String(error) },
      })
      return NextResponse.json(
        { ok: false, error: "Section 129 issuance could not be durably reserved; notice was not sent." },
        { status: 500 },
      )
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
      // New path: sendMessage() via the Phase 9 S2 pipeline.
      const emailNormalised = normaliseEmail(addressee.email)
      const contact = await lookupContactByChannelValue(prisma, {
        tenantId: tenant.id,
        channel: "EMAIL",
        value: emailNormalised,
      })
      if (!contact) {
        // Data drift: Client without a Contact row. Same as the bulk route —
        // don't silently drop a statutory obligation, surface the gap.
        result = { ok: false, error: `no Contact row for ${addressee.email}` }
      } else {
        try {
          const dispatch = await dispatchSection129UnderEligibilityLock({
            reservation,
            tenantId: tenant.id,
            loanId: loan.id,
            actorId: guard.user.id,
            actorEmail: guard.user.email,
            dispatch: (markProviderInvocation) => sendMessage({
              contactId: contact.id,
              channel: "EMAIL",
              template,
              vars: {
                clientName,
                loanReference: loan.reference,
                daysInArrears: String(loan.daysInArrears),
                arrearsAmountFormatted: formatZAR(noticeAmounts.arrearsAmount),
                outstandingBalanceFormatted: formatZAR(noticeAmounts.totalOutstanding ?? noticeAmounts.outstandingPrincipal),
                noticeDate,
              },
              toValue: emailNormalised,
              category: "section129",
              loanId: loan.id,
              createdById: guard.user.id,
              attachments,
              automaticRetry: false,
              onProviderDispatchStart: markProviderInvocation,
            }),
          })
          if (dispatch.kind === "INELIGIBLE") {
            return NextResponse.json({ ok: false, error: dispatch.error.message }, { status: 422 })
          }
          if (dispatch.kind === "SNAPSHOT_CHANGED") {
            return NextResponse.json({ ok: false, error: dispatch.error.message }, { status: 409 })
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
        } catch (err) {
          if (err instanceof Section129DispatchUncertainError) {
            return NextResponse.json({
              ok: false,
              providerOutcome: "AMBIGUOUS",
              dispatchState: "DELIVERY_UNCERTAIN",
              reconciliationRequired: true,
              issuanceId: reservation.issuanceId,
              error: err.message,
            }, { status: 202 })
          }
          result = { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
    } else {
      // Legacy path: direct sendEmail(). Kept until the new path
      // has legal sign-off.
      const emailData = {
        clientName,
        loanReference: loan.reference,
        arrearsAmount: noticeAmounts.arrearsAmount,
        outstandingBalance: noticeAmounts.totalOutstanding ?? noticeAmounts.outstandingPrincipal,
        daysInArrears: loan.daysInArrears,
        noticeDate,
        lender: lender.identity,
      }

      try {
        const dispatch = await dispatchSection129UnderEligibilityLock({
          reservation,
          tenantId: tenant.id,
          loanId: loan.id,
          actorId: guard.user.id,
          actorEmail: guard.user.email,
          dispatch: (markProviderInvocation) => sendSection129Email({
              tenantId: tenant.id,
              to: addressee.email,
              toName: clientName,
              subject: `Section 129 Notice — Account ${loan.reference}`,
              html: section129Html(emailData),
              text: section129Text(emailData),
              category: "section129",
              referenceId: loan.id,
              attachments,
              onProviderDispatchStart: markProviderInvocation,
            }),
        })
        if (dispatch.kind === "INELIGIBLE") {
          return NextResponse.json({ ok: false, error: dispatch.error.message }, { status: 422 })
        }
        if (dispatch.kind === "SNAPSHOT_CHANGED") {
          return NextResponse.json({ ok: false, error: dispatch.error.message }, { status: 409 })
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
          return NextResponse.json({
            ok: false,
            providerOutcome: "AMBIGUOUS",
            dispatchState: "DELIVERY_UNCERTAIN",
            reconciliationRequired: true,
            issuanceId: reservation.issuanceId,
            error: error.message,
          }, { status: 202 })
        }
        result = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    if (!result.ok) {
      const reconciliationRequired = providerInvoked
        && result.providerOutcome !== "DEFINITELY_REJECTED"
      if (reconciliationRequired) {
        await markSection129ReconciliationRequired({
          reservation,
          tenantId: tenant.id,
          loanId: loan.id,
          actorId: guard.user.id,
          actorEmail: guard.user.email,
          reason: result.error ?? "Provider dispatch failed with an unknown outcome",
        }).catch(() => {
          // The active idempotency key remains locked in DISPATCHING. Report
          // uncertainty even if the database cannot promote it immediately;
          // the stale-reservation recovery will promote it once DB access is
          // restored. Never turn this into a retryable generic 500.
        })
      } else {
        try {
          await markSection129KnownNotSent({
            reservation,
            tenantId: tenant.id,
            loanId: loan.id,
            actorId: guard.user.id,
            actorEmail: guard.user.email,
            reason: result.error ?? "Dispatch did not reach the provider",
          })
        } catch (cleanupError) {
          return NextResponse.json(
            {
              ok: false,
              error: `The provider was not invoked, but the private artifact could not be deleted and released: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
              issuanceId: reservation.issuanceId,
              lifecycle: reservation.recordData.lifecycle,
              recoveryRequired: true,
            },
            { status: 503 },
          )
        }
      }
      return NextResponse.json(
        {
          ok: false,
          error: result.error ?? "Failed to send",
          issuanceId: reservation.issuanceId,
          reconciliationRequired,
          ...(result.providerOutcome ? { providerOutcome: result.providerOutcome } : {}),
          dispatchState: reconciliationRequired ? "DELIVERY_UNCERTAIN" : "KNOWN_NOT_SENT",
        },
        { status: reconciliationRequired ? 502 : 422 },
      )
    }

    if (!result.acceptedAt) {
      await markSection129ReconciliationRequired({
        reservation,
        tenantId: tenant.id,
        loanId: loan.id,
        actorId: guard.user.id,
        actorEmail: guard.user.email,
        reason: "Provider accepted dispatch without a persisted acceptance timestamp",
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
      return NextResponse.json(
        {
          ok: false,
          providerAccepted: true,
          providerOutcome: "ACCEPTED",
          dispatchState: "LEGAL_RECORD_RECONCILIATION_REQUIRED",
          reconciliationRequired: true,
          issuanceId: reservation.issuanceId,
          error: "The provider accepted the notice, but its acceptance time was not recorded. Do not retry; reconcile this issuance.",
        },
        { status: 202 },
      )
    }

    try {
      await finaliseSection129Issuance({
        reservation,
        tenantId: tenant.id,
        loanId: loan.id,
        issuedById: guard.user.id,
        issuedByEmail: guard.user.email,
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
      await markSection129ReconciliationRequired({
        reservation,
        tenantId: tenant.id,
        loanId: loan.id,
        actorId: guard.user.id,
        actorEmail: guard.user.email,
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
        // Keep the response non-retryable even if the reconciliation-state
        // write is part of the same database failure as finalisation.
      })
      return NextResponse.json(
        {
          ok: false,
          providerAccepted: true,
          providerOutcome: "ACCEPTED",
          dispatchState: "LEGAL_RECORD_RECONCILIATION_REQUIRED",
          reconciliationRequired: true,
          issuanceId: reservation.issuanceId,
          error: "The provider accepted the notice, but the legal record could not be finalised. Do not retry; reconcile this issuance.",
        },
        { status: 202 },
      )
    }

    // A simulated notice went nowhere: no borrower notification follows it.
    if (!result.simulated) {
      triggerNotification({
        tenantId: tenant.id,
        event: "section129_sent",
        loanId,
        data: { reference: loan.reference },
      }).catch(() => {})
    }

    return NextResponse.json({
      ok: true,
      message: section129SentMessage(addressee.email, result.simulated === true),
      ...(result.simulated ? { simulated: true } : {}),
      messageId: result.messageId,
      issuanceId: reservation.issuanceId,
      providerAccepted: true,
      providerOutcome: "ACCEPTED",
      dispatchState: "ISSUED",
    })
  })
}
