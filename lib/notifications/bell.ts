import { prisma } from "@/lib/prisma"

// Server-only: imports prisma. The bell component takes its data as props /
// from the API — it must not import this module.
//
// ── Why this file is `bell.ts` and not `index.ts` ─────────────────────────
// `lib/notifications.ts` (the customer notification engine, `triggerNotification`)
// already exists and is imported by ~10 modules as "@/lib/notifications". A
// sibling `lib/notifications/index.ts` does NOT win that specifier — the .ts
// file shadows the directory — so `import { createNotification } from
// "@/lib/notifications"` silently resolves to the OTHER module and fails with
// "has no exported member". Naming the file explicitly means every import is
// "@/lib/notifications/bell": unambiguous, and the natural-looking bare path
// can never quietly bind to the wrong module.
//
// `Notification` is in TENANT_SCOPED_MODELS, so every call here passes an
// explicit tenantId: that satisfies the rewriter both inside a request (ALS
// frame present) and from the reminder cron (no frame — an explicit tenantId
// is then the ONLY thing that stops a missing-context throw).

// `Notification.type` is a String column, not a Prisma enum, so adding a
// member here needs no migration.
export type NotificationType = "TASK_DUE" | "LICENCE_EXPIRY" | "COMMS_MENTION" | "LEAD_DUPLICATE" | "CHAT_HANDOFF" | "BUREAU_HELD" | "LOAN_REPRICED" | "REFERENCE_RATE_NO_EFFECT" | "REFERENCE_RATE_FEED_PENDING" | "LEASE_EXPIRY_NOTICE" | "LEGAL_MATTER_NEXT_STEP" | "RECOVERY_DEADLINE_PASSED" | "RECOVERY_FINAL_NOTICE_DUE"

export type BellNotification = {
  id: string
  type: string
  title: string
  body: string | null
  entityType: string | null
  entityId: string | null
  readAt: Date | null
  createdAt: Date
}

const BELL_SELECT = {
  id: true,
  type: true,
  title: true,
  body: true,
  entityType: true,
  entityId: true,
  readAt: true,
  createdAt: true,
} as const

/** Most recent bell items for a user, newest first. */
export async function listNotifications(a: {
  tenantId: string
  userId: string
  limit?: number
}): Promise<BellNotification[]> {
  return prisma.notification.findMany({
    where: { tenantId: a.tenantId, userId: a.userId },
    select: BELL_SELECT,
    orderBy: { createdAt: "desc" },
    take: Math.min(a.limit ?? 20, 50),
  })
}

/** Unread count for the bell badge. Backed by the (userId, readAt) index. */
export async function unreadNotificationCount(a: {
  tenantId: string
  userId: string
}): Promise<number> {
  return prisma.notification.count({
    where: { tenantId: a.tenantId, userId: a.userId, readAt: null },
  })
}

/**
 * Mark notifications read.
 *
 * `updateMany` scoped by userId as well as tenantId — the id list arrives from
 * the client, so without the userId predicate one staff member could mark
 * another's items read. Returns the count actually written so a caller can
 * tell a no-op from a success.
 *
 * `ids` omitted means "mark all mine read". `ids: []` means "mark none" and
 * returns without querying — the distinction matters because an empty array
 * spread into the where clause contributes no predicate, so a caller passing
 * a filtered-to-empty list would silently escalate to marking EVERY item read.
 */
export async function markNotificationsRead(a: {
  tenantId: string
  userId: string
  ids?: string[]
  now?: Date
}): Promise<number> {
  if (a.ids !== undefined && a.ids.length === 0) return 0
  const res = await prisma.notification.updateMany({
    where: {
      tenantId: a.tenantId,
      userId: a.userId,
      readAt: null,
      ...(a.ids ? { id: { in: a.ids } } : {}),
    },
    data: { readAt: a.now ?? new Date() },
  })
  return res.count
}

/**
 * The `notification` delegate this module needs.
 *
 * Declared structurally, like UserFinder in lib/crm/staff.ts, so a caller can
 * pass a transaction client (`tx.notification`) instead of the root one. The
 * reminder cron needs exactly that: its throttle claim and its bell item must
 * commit together or not at all.
 *
 * REQUIRED, deliberately — not defaulted to `prisma.notification`. With a
 * default, the cron dropping its `tx.notification` argument would compile
 * cleanly, pass every test, and silently write the bell OUTSIDE the
 * transaction: the claim would commit alone and permanently silence that
 * task's reminder. Making the caller name its client means that mistake is a
 * type error instead of a comment nobody re-reads.
 */
type NotificationCreator = {
  create(args: {
    data: {
      tenantId: string
      userId: string
      type: string
      title: string
      body: string | null
      entityType: string | null
      entityId: string | null
    }
    select: { id: true }
  }): Promise<{ id: string }>
}

/**
 * Create a bell item.
 *
 * Not audited via lib/audit.ts on purpose: this is a UI inbox row, not a
 * state-changing user action. The action that *caused* it (task created, task
 * due) is what carries the audit trail.
 */
export async function createNotification(
  a: {
    tenantId: string
    userId: string
    type: NotificationType
    title: string
    body?: string
    entityType?: string
    entityId?: string
  },
  notifications: NotificationCreator
): Promise<{ id: string }> {
  return notifications.create({
    data: {
      tenantId: a.tenantId,
      userId: a.userId,
      type: a.type,
      title: a.title,
      body: a.body ?? null,
      entityType: a.entityType ?? null,
      entityId: a.entityId ?? null,
    },
    select: { id: true },
  })
}
