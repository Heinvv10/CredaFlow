import { createHash } from "node:crypto"
import { NextResponse, type NextRequest } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAudit } from "@/lib/audit"
import { recordedCallerIp } from "@/lib/rate-limit"
import { sendEmail } from "@/lib/email/service"
import { getLenderIdentity } from "@/lib/config/identity"
import { readFile } from "@/lib/storage"
import { escapeHtml } from "@/lib/utils"
import { maskDestination } from "@/lib/compliance/pasq-link-token.server"
import { isAgreementDeliveryNewSendEnabled } from "@/lib/messaging/flags"
import { normaliseEmail } from "@/lib/contact/identity"
import {
  deliverViaMessaging,
  resolveMessagingTarget,
  type RouteDeliveryOutcome,
} from "@/lib/messaging/route-delivery"
import { EntityBorrowerError, hasClientBorrower } from "@/lib/borrower"
import { DEALER_CONTACT_UNVERIFIED, dealerContactUnverified } from "@/lib/clients/dealer-contact"

type RouteCtx = { params: Promise<{ id: string }> }

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Emails the client their copy of the credit agreement (NCA s.93(1): the
 * consumer must receive a copy of the document they signed). Available once
 * the provider has countersigned — before that there is no concluded
 * agreement to deliver.
 *
 * Many clients have no portal access; email is the delivery channel of
 * record for them. The destination is ALWAYS the address on the client
 * record — never a per-send override — and the bytes are digest-checked
 * against the countersigned document before they leave.
 *
 * Role floor: CREDIT_OFFICER, deliberately below the LOAN_ADMIN countersign
 * floor — delivering an already-concluded agreement is not signing, and an
 * officer can already download the same PDF from the agreement panel. Every
 * send is audited.
 */
export async function POST(req: NextRequest, { params }: RouteCtx) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await params

    const application = await prisma.loanApplication.findUnique({
      where: { id, tenantId: tenant.id },
      select: {
        clientId: true,
        reference: true,
        agreementDocumentId: true,
        agreementDocumentSha256: true,
        agreementExecutedDocumentId: true,
        agreementExecutedDocumentSha256: true,
        agreementCountersignedAt: true,
        client: { select: { email: true, firstName: true, lastName: true, createdByDealerId: true, dealerContactVerifiedAt: true } },
      },
    })
    if (!application) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 })
    }
    // The credit agreement is a consumer NCA document; an entity borrower is refused.
    if (!hasClientBorrower(application)) {
      return NextResponse.json({ error: new EntityBorrowerError().message }, { status: 409 })
    }
    // Contact details a dealer typed may be the dealer's own: nothing goes to
    // them until a staff member verifies them (lib/clients/dealer-contact.ts).
    if (dealerContactUnverified(application.client)) {
      return NextResponse.json({ error: DEALER_CONTACT_UNVERIFIED }, { status: 409 })
    }
    if (
      !application.agreementCountersignedAt
      || !application.agreementDocumentId
      || !application.agreementDocumentSha256
    ) {
      return NextResponse.json({
        error: "The agreement can be emailed once the provider has countersigned it. Complete the signing ceremony first.",
      }, { status: 409 })
    }

    const sentTo = application.client.email
    if (!sentTo || !EMAIL_SHAPE.test(sentTo)) {
      return NextResponse.json({
        error: "The client record has no valid email address. Correct the client's contact details first — the agreement is only ever sent to the address on file.",
      }, { status: 422 })
    }

    // Deliver the EXECUTED artifact — the one that actually carries both
    // signatures. Sending `agreementDocumentId` here would mail the document
    // with the blank signature line, which is the defect this whole area
    // exists to fix: the copy delivered under NCA s93 showed no signature.
    //
    // Loans countersigned BEFORE the executed artifact existed have no such
    // document, and their consumer is still owed their statutory copy, so the
    // unsigned agreement remains the fallback rather than a hard failure.
    const deliversExecuted =
      Boolean(application.agreementExecutedDocumentId)
      && Boolean(application.agreementExecutedDocumentSha256)
    const deliveredDocumentId = deliversExecuted
      ? application.agreementExecutedDocumentId!
      : application.agreementDocumentId
    const deliveredSha256 = deliversExecuted
      ? application.agreementExecutedDocumentSha256!
      : application.agreementDocumentSha256

    // Same lifecycle constraints as every other reader of this document: the
    // digest proves content, not state — a soft-deleted (incl. POPIA-erased)
    // document must not be mailed even if its bytes still match.
    const document = await prisma.clientDocument.findFirst({
      where: {
        id: deliveredDocumentId,
        tenantId: tenant.id,
        clientId: application.clientId,
        docType: deliversExecuted ? "EXECUTED_CREDIT_AGREEMENT" : "CREDIT_AGREEMENT",
        deletedAt: null,
      },
      select: { id: true, fileName: true, storagePath: true },
    })
    if (!document?.storagePath) {
      return NextResponse.json({
        error: "The countersigned agreement document is unavailable.",
      }, { status: 422 })
    }
    let bytes: Buffer
    try {
      bytes = await readFile(document.storagePath)
    } catch {
      return NextResponse.json({
        error: "The countersigned agreement bytes are unavailable.",
      }, { status: 422 })
    }
    const digest = createHash("sha256").update(bytes).digest("hex")
    if (digest !== deliveredSha256) {
      // The strongest integrity signal this route can see — it must leave a
      // durable record even though nothing was sent.
      await logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.AGREEMENT_EMAIL_FAILED,
        entity: "LoanApplication",
        entityId: id,
        ipAddress: recordedCallerIp(req) ?? undefined,
        newValue: {
          documentId: document.id,
          deliveredExecutedArtifact: deliversExecuted,
          expectedSha256: deliveredSha256,
          actualSha256: digest,
          failure: "document_digest_mismatch",
          sent: false,
        },
      })
      return NextResponse.json({
        error: "The stored agreement no longer matches its recorded digest. Do not deliver it — investigate the document store.",
      }, { status: 409 })
    }

    const clientName = [application.client.firstName, application.client.lastName]
      .filter(Boolean).join(" ")
    const attachments = [{
      filename: document.fileName || `credit-agreement-${application.reference}.pdf`,
      content: bytes,
      contentType: "application/pdf",
    }]

    let delivery: RouteDeliveryOutcome
    if (isAgreementDeliveryNewSendEnabled()) {
      // New path: sendMessage() via the Phase 9 S2 pipeline, so the statutory
      // copy the consumer received shows on their comms timeline as proof of
      // sending rather than only in the ADMIN-only EmailLog.
      const emailNormalised = normaliseEmail(sentTo)
      const target = await resolveMessagingTarget({
        tenantId: tenant.id,
        channel: "EMAIL",
        value: emailNormalised,
        templateKey: "agreement_delivery_email",
      })
      if (!target.ok) {
        // Data drift. Nothing was sent, so the verdict is a definite
        // non-delivery — say so rather than dropping the s.93(1) obligation
        // silently. The audit row below records it either way.
        delivery = { ok: false, error: target.reason, providerOutcome: "DEFINITELY_REJECTED" }
      } else {
        delivery = await deliverViaMessaging({
          contactId: target.contact.id,
          channel: "EMAIL",
          template: target.template,
          vars: {
            applicationReference: application.reference,
            // renderTemplate does no escaping; the name is escaped here.
            greeting: clientName ? ` ${escapeHtml(clientName)}` : "",
          },
          toValue: emailNormalised,
          toName: clientName || undefined,
          category: "agreement-delivery",
          applicationId: id,
          createdById: guard.user.id,
          attachments,
          // Attachment bytes are not replayable from the Message row, so the
          // generic body-only retry cron must never re-send this.
          automaticRetry: false,
        })
      }
    } else {
      // Legacy path: direct sendEmail(). Kept until the new path has soaked.
      const identity = await getLenderIdentity(tenant.id)
      delivery = await sendEmail({
        tenantId: tenant.id,
        to: sentTo,
        toName: clientName || undefined,
        subject: `Your signed credit agreement — ${application.reference}`,
        html: [
          `<p>Good day${clientName ? ` ${escapeHtml(clientName)}` : ""},</p>`,
          `<p>Attached is your copy of the credit agreement you signed with ${escapeHtml(identity.legalName)}, countersigned by the credit provider. Please keep it for your records.</p>`,
          "<p>If anything in it looks wrong, contact your consultant before your first repayment date.</p>",
          `<p>${escapeHtml(identity.tradingName)}</p>`,
        ].join("\n"),
        text: `Attached is your copy of the signed credit agreement ${application.reference}. Please keep it for your records.`,
        category: "agreement-delivery",
        referenceId: id,
        attachments,
      })
    }

    // An ambiguous outcome (connection dropped mid-submission, provider gave
    // no verdict) means the agreement MAY have reached the consumer — the
    // POPIA disclosure record errs on the side of existing, mirroring the
    // Section 129 rule of never claiming non-delivery unless the provider
    // definitely rejected.
    const possiblyDelivered =
      delivery.ok || delivery.providerOutcome !== "DEFINITELY_REJECTED"
    if (possiblyDelivered) {
      await prisma.documentAccessLog.create({
        data: {
          documentId: document.id,
          accessorType: "staff",
          accessorId: guard.user.id,
          action: "email_to_client",
          ipAddress: recordedCallerIp(req),
          userAgent: req.headers.get("user-agent") ?? null,
        },
      })
    }

    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: delivery.ok
        ? AuditAction.AGREEMENT_EMAILED_TO_CLIENT
        : AuditAction.AGREEMENT_EMAIL_FAILED,
      entity: "LoanApplication",
      entityId: id,
      ipAddress: recordedCallerIp(req) ?? undefined,
      newValue: {
        documentId: document.id,
        // MUST be the digest of the document actually attached. Pairing the
        // executed document's id with the unsigned document's digest would
        // answer "which bytes did the consumer receive" with a digest that
        // matches the document that was NOT sent.
        documentSha256: deliveredSha256,
        deliveredExecutedArtifact: deliversExecuted,
        sentTo: maskDestination(sentTo),
        providerOutcome: delivery.providerOutcome,
        ...(delivery.ok ? {} : {
          failure: delivery.error ?? "send_failed",
          possiblyDelivered,
        }),
      },
    })

    if (!delivery.ok) {
      return NextResponse.json({
        error: possiblyDelivered
          ? "The email provider gave no delivery verdict — the agreement may or may not have reached the client. Check with the client before resending."
          : "The agreement email could not be delivered. Check the client's email address and the tenant's email settings, then try again.",
        deliveryError: delivery.error ?? "send_failed",
      }, { status: 502 })
    }
    return NextResponse.json({
      success: true,
      sentTo: maskDestination(sentTo),
    })
  })
}
