// Server-side orchestration for the returning-applicant notice.
//
// Server-only by construction (pulls prisma). The decisions it applies are in
// lib/crm/lead-duplicate-notice.ts and the match rule is in
// lib/crm/lead-identity.ts — both prisma-free, both unit-tested without a DB.
//
// CONTRACT: this function never throws and never mutates a Lead. It runs inside
// a consumer's loan application; a matcher bug, a dead SMTP host or a lock
// timeout must degrade to "no notice sent", never to a failed application. The
// caller is not expected to handle errors because there are none to handle.
//
// It also must not change the applicant-visible response in any way. The apply
// route deliberately hides whether we recognise someone (PR #412 enumeration
// safety) — a branch here that altered timing-visible behaviour or response
// shape would leak the same fact by another route.

import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { sendEmail } from "@/lib/email/service"
import { findPriorOpenLeads, type LeadIdentityFields } from "@/lib/crm/lead-identity"
import {
  duplicateNoticeChannelKey,
  throttleWindowStart,
  selectNoticeRecipients,
  buildDuplicateNotice,
  type PriorLeadSummary,
} from "@/lib/crm/lead-duplicate-notice"

/** Same bound and rationale as DEDUP_SCAN_LIMIT: phones are stored as typed, so
 *  matching is a bounded scan rather than an index lookup. */
export const NOTICE_SCAN_LIMIT = 5000

export type NotifyDeps = {
  leads: {
    findMany: (args: {
      where: { tenantId: string; id?: { not: string } }
      select: Record<string, true>
      take: number
    }) => Promise<Array<LeadIdentityFields & PriorLeadSummary>>
  }
  throttle: {
    create: (args: { data: { tenantId: string; channelKey: string; windowStart: Date } }) => Promise<unknown>
    delete: (args: {
      where: { tenantId_channelKey_windowStart: { tenantId: string; channelKey: string; windowStart: Date } }
    }) => Promise<unknown>
  }
  notify: (a: {
    tenantId: string
    userId: string
    title: string
    body: string
    entityId: string
  }) => Promise<unknown>
  email: (a: { tenantId: string; userId: string; title: string; html: string }) => Promise<unknown>
  now: () => number
}

export type NotifyResult = {
  matched: number
  notified: number
  skippedByThrottle: number
}

/**
 * Tell the owning agent(s) that `newLead`'s person already has an open lead.
 *
 * The tenant filter is applied here and is not optional: `Lead` is absent from
 * TENANT_SCOPED_MODELS, so nothing upstream injects one, and without it this
 * would point an agent at another tenant's consumer.
 */
export async function notifyPriorLeadDuplicates(
  newLead: Pick<LeadIdentityFields, "id" | "firstName" | "lastName" | "phone">,
  tenantId: string,
  deps: NotifyDeps,
): Promise<NotifyResult> {
  const empty: NotifyResult = { matched: 0, notified: 0, skippedByThrottle: 0 }

  const candidates = await deps.leads.findMany({
    where: { tenantId, id: { not: newLead.id } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phone: true,
      status: true,
      assignedToId: true,
      convertedToClientId: true,
      convertedToApplicationId: true,
      conversionRecoveryRequired: true,
    },
    take: NOTICE_SCAN_LIMIT,
  })

  const priors = findPriorOpenLeads(newLead, candidates)
  if (priors.length === 0) return empty

  const recipients = selectNoticeRecipients(priors)
  if (recipients.length === 0) return { ...empty, matched: priors.length }

  const applicantName = [newLead.firstName ?? "", newLead.lastName ?? ""].join(" ").trim()
  const windowStart = throttleWindowStart(deps.now())

  let notified = 0
  let skippedByThrottle = 0

  for (const recipient of recipients) {
    // One notice names one lead — the agent needs somewhere to click, and the
    // throttle is per prior lead, so the first of theirs is the anchor.
    const anchorId = recipient.leadIds[0]
    const anchor = priors.find((p) => p.id === anchorId)
    if (!anchor) continue

    const channelKey = duplicateNoticeChannelKey(anchorId)

    // Claim BEFORE sending. The unique constraint on
    // (tenantId, channelKey, windowStart) means exactly one concurrent request
    // wins the insert; the losers get P2002 and skip. A findFirst-then-send
    // would be the check-then-act race PR #414 removed.
    try {
      await deps.throttle.create({ data: { tenantId, channelKey, windowStart } })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        skippedByThrottle += 1
        continue
      }
      throw err
    }

    const notice = buildDuplicateNotice({
      applicantName,
      priorLeadCount: recipient.leadIds.length,
      priorStatus: anchor.status,
    })

    // The bell is the PRIMARY channel and the thing the throttle counts. It is
    // attempted first and alone inside the releasing catch: if it fails,
    // nothing was delivered, so the claim must go back or a transient outage
    // silences this agent for the rest of the window.
    try {
      await deps.notify({
        tenantId,
        userId: recipient.userId,
        title: notice.title,
        body: notice.body,
        entityId: anchorId,
      })
    } catch (bellErr) {
      await deps.throttle
        .delete({ where: { tenantId_channelKey_windowStart: { tenantId, channelKey, windowStart } } })
        .catch(() => undefined)
      throw bellErr
    }

    notified += 1

    // Email is best-effort WITHIN the best-effort notice, and deliberately does
    // NOT release the claim. Releasing it here was a real defect: the bell item
    // has already been written and cannot be un-written, so freeing the window
    // let the next genuine submission insert a SECOND bell item for the same
    // prior lead — a transient SMTP blip defeating the one-notice-per-window
    // guarantee the throttle exists to provide. A missed email is the smaller
    // harm than a duplicated alert.
    try {
      await deps.email({ tenantId, userId: recipient.userId, title: notice.title, html: notice.html })
    } catch (emailErr) {
      console.error("[lead-duplicate-notice] email failed after bell delivered", {
        leadId: anchorId,
        error: emailErr instanceof Error ? emailErr.message : String(emailErr),
      })
    }
  }

  return { matched: priors.length, notified, skippedByThrottle }
}

/**
 * Best-effort entry point for the public creation routes.
 *
 * Swallows everything. This is the ONLY function the routes should call: it is
 * what guarantees a consumer's application cannot fail because a notification
 * did not send.
 */
export async function notifyPriorLeadDuplicatesBestEffort(
  newLead: Pick<LeadIdentityFields, "id" | "firstName" | "lastName" | "phone">,
  tenantId: string,
  deps?: NotifyDeps,
): Promise<void> {
  // Resolved INSIDE the try, not as a default parameter value. A default
  // parameter is evaluated during parameter binding, before the function body
  // runs — so a defaultDeps() that ever became fallible would throw straight
  // past this catch and break the never-fails-the-caller contract, with no
  // test covering it because every test passes deps explicitly.
  try {
    await notifyPriorLeadDuplicates(newLead, tenantId, deps ?? defaultDeps())
  } catch (err) {
    console.error("[lead-duplicate-notice] suppressed", {
      leadId: newLead.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

function defaultDeps(): NotifyDeps {
  return {
    leads: prisma.lead as unknown as NotifyDeps["leads"],
    throttle: prisma.notificationThrottle as unknown as NotifyDeps["throttle"],
    // The explicit `tenantId` here is LOAD-BEARING, not redundant. Notification
    // IS in TENANT_SCOPED_MODELS, and this now runs deferred, after the
    // response — outside the request's AsyncLocalStorage tenant frame. With no
    // ALS frame, lib/tenant-scope.ts allows a create only when data.tenantId is
    // supplied and throws `missing-context` otherwise, so dropping it on the
    // assumption that the scope injects it would make every notice fail
    // silently (the best-effort wrapper swallows it) while all tests, which
    // supply their own deps, stayed green. Passing it explicitly is also
    // correct if the frame DOES survive: it equals the frame's tenant, so the
    // cross-tenant-mismatch branch cannot fire.
    notify: async (a) =>
      prisma.notification.create({
        data: {
          tenantId: a.tenantId,
          userId: a.userId,
          type: "LEAD_DUPLICATE",
          title: a.title,
          body: a.body,
          entityType: "Lead",
          entityId: a.entityId,
        },
      }),
    email: async (a) => {
      const user = await prisma.user.findUnique({
        where: { id: a.userId },
        select: { email: true, name: true },
      })
      // A staff account with no address is not an error worth failing on, and
      // must not release the throttle claim — the bell item already landed.
      if (!user?.email) return undefined
      return sendEmail({
        tenantId: a.tenantId,
        to: user.email,
        toName: user.name ?? undefined,
        // CR/LF stripped: the subject embeds an applicant-supplied name from a
        // public form, and a header value carrying a newline is the classic
        // header-injection vector. Stripped at this seam rather than trusting
        // the transport to sanitise it.
        subject: a.title.replace(/[\r\n]+/g, " "),
        html: a.html,
        category: "lead-duplicate-notice",
      })
    },
    now: () => Date.now(),
  }
}
