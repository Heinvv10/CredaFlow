// Lead ownership: how a stored owner id renders.
//
// `Lead.assignedToId` is a bare `String?` with no `@relation` to User, so an
// owner id can outlive the user it points at (deactivated, moved tenant,
// deleted). Resolution is therefore a real lookup with a real miss case —
// kept here so the picker, the detail header, and any future list column can
// never disagree about what an unresolvable owner means.
//
// Deliberately free of `prisma`: the owner picker is a client component, so
// anything it imports is bundled for the browser. The staff query lives in
// lib/crm/staff.ts (server-only) for that reason — keep it that way.

export type AssignableStaff = { id: string; name: string | null; email: string }

export type LeadOwner =
  | { state: "unassigned"; label: string; staff: null }
  | { state: "assigned"; label: string; staff: AssignableStaff }
  | { state: "unknown"; label: string; staff: null }

/**
 * Renders a stored `assignedToId` against the tenant's assignable staff.
 *
 * A dangling id resolves to "unknown", never to "unassigned" — the lead does
 * have an owner recorded, and collapsing that into "Unassigned" would tell an
 * agent the lead is free to take when the audit trail says otherwise.
 */
export function resolveLeadOwner(
  assignedToId: string | null | undefined,
  staff: AssignableStaff[]
): LeadOwner {
  if (!assignedToId) return { state: "unassigned", label: "Unassigned", staff: null }

  const match = staff.find((s) => s.id === assignedToId)
  if (!match) return { state: "unknown", label: "Unknown user (no longer active)", staff: null }

  return { state: "assigned", label: match.name ?? match.email, staff: match }
}
