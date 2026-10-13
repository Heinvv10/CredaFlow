"use server"

import { prisma } from "@/lib/prisma"
import { auth } from "@/lib/auth"
import { requireMinRole } from "@/lib/auth-guards"
import { logAudit, AuditAction } from "@/lib/audit"
import { getDefaultTenantId } from "@/lib/tenant"
import { isAssignableStaff } from "@/lib/crm/staff"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { ActivityType, LeadStatus } from "@prisma/client"

const VALID_LEAD_STATUS = new Set<string>(Object.values(LeadStatus))
const VALID_ACTIVITY_TYPE = new Set<string>(Object.values(ActivityType))

export async function generateCrossSellOpportunities() {
  const session = await auth()
  if (!session?.user) throw new Error("Unauthorized")

  const tenantId = await getDefaultTenantId()

  const activeLoans = await prisma.loan.findMany({
    where: { tenantId, status: "ACTIVE" },
    select: { clientId: true },
    distinct: ["clientId"],
  })

  // Funeral cover is offered to natural persons; entity borrowers are skipped.
  const clientIds = activeLoans.flatMap((l) => (l.clientId === null ? [] : [l.clientId]))

  const existing = await prisma.crossSellOpportunity.findMany({
    where: {
      tenantId,
      clientId: { in: clientIds },
      type: "FUNERAL_COVER",
    },
    select: { clientId: true },
  })

  const existingClientIds = new Set(existing.map((o) => o.clientId))
  const newClientIds = clientIds.filter((id) => !existingClientIds.has(id))

  if (newClientIds.length === 0) return { created: 0 }

  await prisma.crossSellOpportunity.createMany({
    data: newClientIds.map((clientId) => ({
      tenantId,
      clientId,
      type: "FUNERAL_COVER" as const,
      status: "PENDING" as const,
    })),
    skipDuplicates: true,
  })

  await logAudit({
    tenantId,
    userId: session.user.id,
    userEmail: session.user.email ?? undefined,
    action: AuditAction.CROSS_SELL_OPPORTUNITIES_GENERATED,
    entity: "CrossSellOpportunity",
    newValue: { type: "FUNERAL_COVER", created: newClientIds.length },
  })

  revalidatePath("/crm/opportunities")
  return { created: newClientIds.length }
}

// Server actions mask thrown error messages behind a generic digest in
// production builds, so a validation failure the UI wants to display inline
// (e.g. "Cannot change status of a converted lead") must come back as a
// typed result instead of a throw — the digest is unreadable to the caller.
// Genuinely unexpected failures (auth, unhandled DB errors) still throw.
type UpdateLeadStatusResult =
  | { ok: true; lead: Awaited<ReturnType<typeof prisma.lead.update>> }
  | { ok: false; error: string }

export async function updateLeadStatus(leadId: string, status: string): Promise<UpdateLeadStatusResult> {
  const session = await auth()
  if (!session?.user) throw new Error("Unauthorized")

  if (!VALID_LEAD_STATUS.has(status)) {
    return { ok: false, error: "Invalid status" }
  }
  if (status === "CONVERTED") {
    return { ok: false, error: "Leads can only be converted via the convert flow, not a direct status update." }
  }
  // LOST requires a lostReason (POPIA/NCA: why a credit lead was dropped is a
  // recorded fact) — force the dedicated lost route/modal, never a bare status.
  if (status === "LOST") {
    return { ok: false, error: "Marking a lead LOST needs a reason — use the Mark-lost flow." }
  }

  const tenantId = await getDefaultTenantId()

  const txResult = await prisma.$transaction(async (tx) => {
    const existing = await tx.lead.findFirst({
      where: { id: leadId, tenantId },
      select: { status: true },
    })
    if (!existing) return { ok: false as const, error: "Lead not found" }
    if (existing.status === "CONVERTED") {
      return { ok: false as const, error: "Cannot change status of a converted lead" }
    }

    const updated = await tx.lead.update({
      where: { id: leadId, tenantId },
      data: {
        status: status as LeadStatus,
        // Only a real change restarts the days-in-stage clock.
        ...(existing.status !== status && { statusChangedAt: new Date() }),
      },
    })

    return { ok: true as const, lead: updated, oldStatus: existing.status }
  })

  if (!txResult.ok) return txResult

  const { lead, oldStatus } = txResult

  await logAudit({
    tenantId,
    userId: session.user.id,
    userEmail: session.user.email ?? undefined,
    action: AuditAction.LEAD_STATUS_CHANGED,
    entity: "Lead",
    entityId: leadId,
    oldValue: { status: oldStatus },
    newValue: { status: lead.status },
  })

  revalidatePath("/crm/leads")
  revalidatePath(`/crm/leads/${leadId}`)
  return { ok: true, lead }
}

type ReassignLeadResult =
  | { ok: true; assignedToId: string | null }
  | { ok: false; error: string }

/**
 * Reassigns (or unassigns) a lead's owner.
 *
 * The assignee is re-checked against the tenant's own active staff at write
 * time rather than trusted from the client: `Lead.assignedToId` is an
 * unconstrained String (no FK), so an arbitrary id — another tenant's user, a
 * deactivated one — would otherwise persist happily and surface as a
 * permanently "Unknown user" owner.
 */
export async function reassignLead(
  leadId: string,
  assignedToId: string | null
): Promise<ReassignLeadResult> {
  const user = await requireMinRole("CREDIT_OFFICER")
  const tenantId = await getDefaultTenantId()

  // Neither Lead nor User is in TENANT_SCOPED_MODELS (lib/tenant-scope.ts),
  // so nothing auto-injects tenantId here — every filter below is manual and
  // load-bearing. Read and write share one transaction to match the
  // read-then-write shape updateLeadStatus already uses.
  const txResult = await prisma.$transaction(async (tx) => {
    const existing = await tx.lead.findFirst({
      where: { id: leadId, tenantId },
      select: { assignedToId: true },
    })
    if (!existing) return { ok: false as const, error: "Lead not found" }

    if (assignedToId && !(await isAssignableStaff(tx.user, { tenantId, userId: assignedToId }))) {
      return { ok: false as const, error: "That staff member can no longer be assigned leads" }
    }

    if (existing.assignedToId === assignedToId) {
      return { ok: true as const, changed: false, oldAssignedToId: existing.assignedToId }
    }

    // Compare-and-swap on the owner we read, for two reasons:
    //   - updateMany, not update: the lead can be deleted between the read and
    //     this write (DELETE /api/crm/leads/[id]); update() would throw an
    //     unhandled P2025 where every other branch returns a typed result.
    //   - `assignedToId: existing.assignedToId` in the predicate: the enclosing
    //     transaction is READ COMMITTED, so a concurrent reassign that commits
    //     after our read is visible to this write. Without the predicate the
    //     write would still succeed and we would then audit an oldValue that
    //     was already stale — a factually wrong audit row, which for a
    //     regulated lender is the part that actually matters.
    const written = await tx.lead.updateMany({
      where: { id: leadId, tenantId, assignedToId: existing.assignedToId },
      data: { assignedToId },
    })
    if (written.count !== 1) {
      return { ok: false as const, error: "This lead was reassigned by someone else — reload and try again" }
    }

    return { ok: true as const, changed: true, oldAssignedToId: existing.assignedToId }
  })

  if (!txResult.ok) return txResult
  if (!txResult.changed) return { ok: true, assignedToId }

  await logAudit({
    tenantId,
    userId: user.id,
    userEmail: user.email,
    action: AuditAction.LEAD_ASSIGNED,
    entity: "Lead",
    entityId: leadId,
    oldValue: { assignedToId: txResult.oldAssignedToId },
    newValue: { assignedToId },
  })

  revalidatePath("/crm/leads")
  revalidatePath("/crm/leads/queue")
  revalidatePath(`/crm/leads/${leadId}`)
  return { ok: true, assignedToId }
}

/**
 * Recovers a lead stranded in CONVERTED status with no client attached — the
 * result of a status change that bypassed the real convert transaction (e.g.
 * the kanban's generic PATCH route before it was guarded). Only migration-
 * marked rows with neither conversion link can be reset; a lead with a real
 * client or application stays protected.
 */
export async function resetStrandedConvertedLead(leadId: string) {
  const user = await requireMinRole("CREDIT_OFFICER")

  const tenantId = await getDefaultTenantId()

  await prisma.$transaction(async (tx) => {
    // Only the migration can set conversionRecoveryRequired. Clearing it in
    // the same write is required by the database state constraint and makes a
    // recovered lead a normal open pipeline row again.
    const result = await tx.lead.updateMany({
      where: {
        id: leadId,
        tenantId,
        status: "CONVERTED",
        convertedToClientId: null,
        convertedToApplicationId: null,
        conversionRecoveryRequired: true,
      },
      data: {
        status: "QUALIFIED",
        statusChangedAt: new Date(),
        conversionRecoveryRequired: false,
      },
    })
    if (result.count !== 1) {
      throw new Error("Lead is not a stranded conversion")
    }

    // Recovery state and its audit evidence commit or roll back together.
    await tx.auditLog.create({
      data: {
        tenantId,
        userId: user.id,
        userEmail: user.email,
        action: AuditAction.LEAD_STATUS_CHANGED,
        entity: "Lead",
        entityId: leadId,
        oldValue: { status: "CONVERTED", conversionRecoveryRequired: true },
        newValue: { status: "QUALIFIED", conversionRecoveryRequired: false },
      },
    })
  })

  revalidatePath("/crm/leads")
  revalidatePath(`/crm/leads/${leadId}`)
  redirect(`/crm/leads/${leadId}/convert`)
}

type AddLeadActivityResult = { ok: true } | { ok: false; error: string }

// Typed result, not throws, for the same reason updateLeadStatus documents:
// production builds mask a thrown message behind a generic digest, so a
// failure the composer wants to show inline must come back as a value.
export async function addLeadActivity(data: {
  leadId: string
  type: string
  subject: string
  notes?: string
}): Promise<AddLeadActivityResult> {
  const session = await auth()
  if (!session?.user) throw new Error("Unauthorized")

  if (!VALID_ACTIVITY_TYPE.has(data.type)) {
    return { ok: false, error: "Invalid activity type" }
  }

  const tenantId = await getDefaultTenantId()

  const activity = await prisma.$transaction(async (tx) => {
    const lead = await tx.lead.findFirst({
      where: { id: data.leadId, tenantId },
      select: { id: true },
    })
    if (!lead) return null

    return tx.crmActivity.create({
      data: {
        tenantId,
        leadId: data.leadId,
        type: data.type as ActivityType,
        subject: data.subject,
        notes: data.notes ?? null,
        createdById: session.user.id!,
        completedAt: new Date(),
      },
    })
  })
  if (!activity) {
    return { ok: false, error: "This lead no longer exists." }
  }

  await logAudit({
    tenantId,
    userId: session.user.id,
    userEmail: session.user.email ?? undefined,
    action: AuditAction.LEAD_ACTIVITY_LOGGED,
    entity: "CrmActivity",
    entityId: activity.id,
    newValue: { leadId: data.leadId, type: activity.type, subject: activity.subject },
  })

  revalidatePath(`/crm/leads/${data.leadId}`)
  return { ok: true }
}
