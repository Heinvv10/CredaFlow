import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { logAudit } from "@/lib/audit"
import { WA_TEMPLATES } from "@/lib/whatsapp"
import { findLenderIdentity } from "@/lib/config/identity"
import {
  KnownDispatchPersistenceError,
  knownDispatchEvidenceFromError,
  MessageReconciliationRequiredError,
  sendMessage,
  SendBlockedError,
  type KnownDispatchEvidence,
} from "@/lib/messaging/send"
import { getOrCreateAgentMessageTemplate } from "@/lib/messaging/agent-message-template"
import { messageDeliveryOutcome } from "@/lib/messaging/delivery-outcome"
import { formatZAR } from "@/lib/utils"
import { withTenantContext } from "@/lib/tenant"
import { evaluateCollectionsEligibility } from "@/lib/collections/section129-eligibility"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { collectionsStageRank } from "@/lib/collections/stages"
import { chargesOutstandingAt } from "@/lib/loan/charges-replay"

const VALID_STAGES = [
  "SOFT_REMINDER",
  "FORMAL_REMINDER",
  "SECTION_129_SENT",
  "PAYMENT_ARRANGEMENT",
  "ATTORNEY_REFERRED",
  "WRITTEN_OFF",
] as const

type Stage = typeof VALID_STAGES[number]

interface StageBody {
  stage: Stage
  notes?: string
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("COLLECTIONS_OFFICER")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const { id } = await params
      const body: StageBody = await req.json()

      if (!body.stage || !VALID_STAGES.includes(body.stage)) {
        return NextResponse.json({ error: "Invalid stage" }, { status: 422 })
      }

      // SECTION_129_SENT is only ever true because a real legal notice went
      // out. That can only happen via POST /api/loans/section129, which
      // updates this stage itself on success — reject any attempt to set it
      // directly so the stage tracker can't drift from the actual notice.
      if (body.stage === "SECTION_129_SENT") {
        return NextResponse.json(
          { error: "Section 129 stage is set automatically when the notice is issued via the S.129 Notice action — it cannot be set directly." },
          { status: 400 }
        )
      }
      if (body.stage === "PAYMENT_ARRANGEMENT" || body.stage === "ATTORNEY_REFERRED") {
        return NextResponse.json(
          { error: `${body.stage === "PAYMENT_ARRANGEMENT" ? "Payment arrangement" : "Attorney referral"} stages are set only by their dedicated audited action.` },
          { status: 400 },
        )
      }
      if (body.stage === "WRITTEN_OFF") {
        return NextResponse.json(
          { error: "Written-off status is set only by the dual-control write-off approval action." },
          { status: 400 },
        )
      }

      // The reminder below quotes arrears + default charges outstanding (0
      // while the flag is off). Read before any write, so a failure here
      // leaves the stage untouched rather than moved with no reminder sent.
      const charges = await chargesOutstandingAt(prisma, { tenantId: tenant.id, loanId: id }, new Date())

      // Lock, re-read and update in one transaction. This makes the stage
      // monotonic even when a reminder races Section 129 finalisation, an
      // arrangement, an attorney referral, or write-off approval.
      const transition = await prisma.$transaction(async (tx) => {
        await lockLoanForUpdate(tx, id)
        const loan = await tx.loan.findUnique({
          where: { id, tenantId: tenant.id },
          include: {
            client: { select: { id: true, firstName: true, lastName: true, phone: true, whatsapp: true } },
          },
        })
        if (!loan) return { kind: "NOT_FOUND" as const }

        const collectionsEligibility = evaluateCollectionsEligibility(loan, "DUNNING")
        if (!collectionsEligibility.eligible) {
          return { kind: "INELIGIBLE" as const, reason: collectionsEligibility.reason }
        }

        const currentRank = collectionsStageRank(loan.collectionsStage)
        const requestedRank = collectionsStageRank(body.stage)
        if (currentRank >= requestedRank) {
          return { kind: "NON_MONOTONIC" as const, currentStage: loan.collectionsStage }
        }

        const updated = await tx.loan.update({
          where: { id, tenantId: tenant.id },
          data: {
            collectionsStage: body.stage,
            collectionsStageUpdatedAt: new Date(),
            ...(body.notes ? { collectionsNotes: body.notes } : {}),
          },
        })

        // The stage transition and its audit evidence are one atomic unit.
        // Reminder delivery happens after commit and has its own outcome event.
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            action: "COLLECTIONS_STAGE_UPDATED",
            entity: "Loan",
            entityId: id,
            oldValue: { stage: loan.collectionsStage },
            newValue: {
              stage: body.stage,
              ...(body.notes ? { notes: body.notes } : {}),
            },
          },
        })

        return { kind: "UPDATED" as const, loan, updated }
      })

      if (transition.kind === "NOT_FOUND") {
        return NextResponse.json({ error: "Loan not found" }, { status: 404 })
      }
      if (transition.kind === "INELIGIBLE") {
        return NextResponse.json(
          { error: `Cannot apply a collections stage: ${transition.reason}.` },
          { status: 422 }
        )
      }
      if (transition.kind === "NON_MONOTONIC") {
        return NextResponse.json(
          { error: `Cannot move collections stage from ${transition.currentStage} to ${body.stage}.` },
          { status: 409 },
        )
      }

      const { loan, updated } = transition

      // Auto-send WA on certain stage transitions. Rerouted through
      // sendMessage() (previously fire-and-forget with errors swallowed) —
      // awaited so the outcome can be recorded truthfully in the audit
      // entry below rather than silently claiming nothing about it.
      const client = loan.client
      const phone = client.whatsapp ?? client.phone
      const amount = formatZAR(loan.arrearsAmount + charges)

      let waReminderResult: string | undefined
      let waKnownDispatchEvidence: KnownDispatchEvidence | undefined
      if (body.stage === "SOFT_REMINDER" || body.stage === "FORMAL_REMINDER") {
        // The 7-day message quotes the lender's collections number; with no
        // configured identity it is not sent rather than quoting a placeholder.
        const lender = loan.daysInArrears >= 7 ? await findLenderIdentity(tenant.id) : null
        const msg = loan.daysInArrears >= 7
          ? lender && WA_TEMPLATES.payment_overdue_7d(client.firstName, amount, loan.reference, lender.collectionsPhone)
          : WA_TEMPLATES.payment_overdue_1d(client.firstName, amount, loan.reference)

        const contact = await prisma.contact.findFirst({ where: { tenantId: tenant.id, clientId: client.id } })
        const toValue = contact?.primaryWaJid ?? contact?.primaryPhone ?? phone

        if (!msg) {
          waReminderResult = "lender_identity_not_configured"
          console.error(`[collections-stage] auto-WA skipped for loan ${id}: lender identity not configured`)
        } else if (!contact || !toValue) {
          waReminderResult = "no_contact"
          console.error(`[collections-stage] auto-WA skipped for loan ${id}: no comms Contact / destination on file`)
        } else {
          const template = await getOrCreateAgentMessageTemplate(tenant.id, "WHATSAPP")
          try {
            const sendResult = await sendMessage({
              contactId: contact.id,
              channel: "WHATSAPP",
              template,
              vars: { body: msg },
              toValue,
              createdById: guard.user.id,
              category: "collections_stage_reminder",
              loanId: id,
              idempotencyKey: `collections-stage:${id}:${body.stage}:WHATSAPP`,
            })
            waReminderResult = messageDeliveryOutcome(sendResult.status)
          } catch (err) {
            if (err instanceof SendBlockedError) {
              waReminderResult = `blocked:${err.reason}`
              console.error(`[collections-stage] auto-WA blocked for loan ${id}: ${err.reason}`)
            } else if (err instanceof KnownDispatchPersistenceError) {
              waKnownDispatchEvidence = knownDispatchEvidenceFromError(err)
              waReminderResult = `reconciliation_required:${err.messageRecord.id}`
              console.error(`[collections-stage] auto-WA known provider evidence requires reconciliation for loan ${id}; automatic replay blocked`)
            } else if (err instanceof MessageReconciliationRequiredError) {
              waReminderResult = `reconciliation_required:${err.messageRecord.id}`
              console.error(`[collections-stage] auto-WA outcome requires reconciliation for loan ${id}; automatic replay blocked`)
            } else {
              waReminderResult = "failed"
              console.error(`[collections-stage] auto-WA failed for loan ${id}:`, err)
            }
          }
        }
      }

      await logAudit({
        tenantId: tenant.id,
        action: "COLLECTIONS_STAGE_REMINDER_OUTCOME",
        entity: "Loan",
        entityId: id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        newValue: {
          stage: body.stage,
          outcome: waReminderResult,
          ...(waKnownDispatchEvidence ? { knownDispatchEvidence: waKnownDispatchEvidence } : {}),
        },
      })

      return NextResponse.json(updated)
    })
  } catch {
    return NextResponse.json({ error: "Failed to update stage" }, { status: 500 })
  }
}
