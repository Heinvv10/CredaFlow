import { prisma } from "@/lib/prisma"
import type { AssignableStaff } from "@/lib/crm/lead-assignment"

// Server-only by construction: this module pulls in prisma, so it must never
// be imported from a client component. The owner picker imports its types and
// resolver from lib/crm/lead-assignment (prisma-free) instead.

/**
 * Staff eligible to own a lead in this tenant.
 *
 * `User` is deliberately NOT in TENANT_SCOPED_MODELS (lib/tenant-scope.ts), so
 * the tenantId filter here is manual and load-bearing — without it the picker
 * offers (and assignment accepts) another tenant's staff.
 */
export async function listAssignableStaff(tenantId: string): Promise<AssignableStaff[]> {
  return prisma.user.findMany({
    where: { tenantId, active: true },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
  })
}

/** The single owner of a lead, when that owner is still assignable. */
export async function findAssignableStaff(
  tenantId: string,
  userId: string
): Promise<AssignableStaff | null> {
  return prisma.user.findFirst({
    where: { id: userId, tenantId, active: true },
    select: { id: true, name: true, email: true },
  })
}

type UserFinder = {
  findFirst(args: {
    where: { id: string; tenantId: string; active: boolean }
    select: { id: true }
  }): Promise<{ id: string } | null>
}

/**
 * Whether `userId` may be written to `Lead.assignedToId` for this tenant.
 *
 * `Lead.assignedToId` has no FK and `Lead`/`User` are both absent from
 * TENANT_SCOPED_MODELS, so the database will store any string a caller sends —
 * another tenant's user, a deactivated one, arbitrary text. This check is the
 * only thing that stops it, which is why it lives here rather than inline:
 * every write path (the reassign action and both /api/crm/leads routes) has to
 * apply the same rule or the strictest one is just a door beside an open
 * window.
 *
 * Takes the `user` delegate rather than the client so it composes with a
 * transaction (`tx.user`) as well as the root client.
 */
export async function isAssignableStaff(
  users: UserFinder,
  a: { tenantId: string; userId: string }
): Promise<boolean> {
  const match = await users.findFirst({
    where: { id: a.userId, tenantId: a.tenantId, active: true },
    select: { id: true },
  })
  return match !== null
}
