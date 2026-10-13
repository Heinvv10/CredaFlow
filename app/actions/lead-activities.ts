"use server"

import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireMinRole } from "@/lib/auth-guards"
import { logAudit, AuditAction } from "@/lib/audit"
import { getDefaultTenantId } from "@/lib/tenant"
import { revalidatePath } from "next/cache"

// Lead activity-feed actions. Separate module: app/actions/crm.ts is already
// over the 300-line cap. Typed results, not throws — production masks a thrown
// message behind a digest, and the UI shows these inline.

const MAX_PINNED_PER_LEAD = 3

type ToggleActivityPinnedResult = { ok: true } | { ok: false; error: string }

export async function toggleLeadActivityPinned(
  activityId: string,
  pinned: boolean
): Promise<ToggleActivityPinnedResult> {
  const user = await requireMinRole("CREDIT_OFFICER")

  const tenantId = await getDefaultTenantId()

  let result
  try {
    result = await prisma.$transaction(
      async (tx) => {
        // Manual tenantId filter — CrmActivity is queried directly, and the id
        // alone must never cross tenants.
        const activity = await tx.crmActivity.findFirst({
          where: { id: activityId, tenantId },
          select: { id: true, leadId: true, pinned: true },
        })
        if (!activity) return { ok: false as const, error: "Activity not found" }
        // Client-scoped activities have leadId null; without this guard the
        // cap-count's `leadId: null` predicate would pool EVERY such row in
        // the tenant into one shared bucket.
        if (!activity.leadId) return { ok: false as const, error: "Only lead activities can be pinned." }
        if (activity.pinned === pinned) {
          return { ok: true as const, leadId: activity.leadId, changed: false, wasPinned: activity.pinned }
        }

        if (pinned) {
          const pinnedCount = await tx.crmActivity.count({
            where: { tenantId, leadId: activity.leadId, pinned: true },
          })
          if (pinnedCount >= MAX_PINNED_PER_LEAD) {
            return { ok: false as const, error: `Up to ${MAX_PINNED_PER_LEAD} items can be pinned.` }
          }
        }

        await tx.crmActivity.update({ where: { id: activity.id }, data: { pinned } })
        return { ok: true as const, leadId: activity.leadId, changed: true, wasPinned: activity.pinned }
      },
      // Serializable so two concurrent pins can't both pass the count check
      // and overshoot the cap (READ COMMITTED would let them).
      { isolationLevel: "Serializable" }
    )
  } catch (err) {
    // Serialization failure (Postgres 40001 / Prisma P2034) is the expected
    // cost of the isolation level when two pins race — a typed result, not a
    // masked digest.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034") {
      return { ok: false, error: "Another change landed at the same time — try again." }
    }
    throw err
  }
  if (!result.ok) return result

  // A no-op toggle writes nothing, so it must not appear in the audit trail.
  if (result.changed) {
    await logAudit({
      tenantId,
      userId: user.id,
      userEmail: user.email,
      action: AuditAction.LEAD_ACTIVITY_PIN_TOGGLED,
      entity: "CrmActivity",
      entityId: activityId,
      oldValue: { pinned: result.wasPinned },
      newValue: { pinned },
    })
    revalidatePath(`/crm/leads/${result.leadId}`)
  }
  return { ok: true }
}
