import { prisma } from "@/lib/prisma"
import { findDuplicateLeads, applyCandidateCap, type LeadDuplicate } from "@/lib/crm/lead-dedup"

// Server-only by construction: this module pulls in prisma, so it must never
// be imported from a client component. The match rule and its types live in
// lib/crm/lead-dedup.ts (prisma-free) — import from there instead.

/**
 * How many of the tenant's leads one detection pass reads.
 *
 * Detection is a scan, not an index lookup, and that is a deliberate trade.
 * `Lead` stores phones as typed ("+27821234567" and "0821234567" are the same
 * number written twice) with no normalised column to index, so the only exact
 * filter would be a SQL expression that re-implements `normalisePhone` — a
 * second definition of "the same phone" that could drift from the one the
 * contact directory uses. A narrower filter (last-N-digits `contains`) is not
 * a guaranteed superset of the match rule, so it would silently miss real
 * duplicates, which is the one failure a dedup feature must not have.
 *
 * The bound is what keeps that scan honest on a table nobody is watching grow.
 * The cap is not expected to bind at current volumes, and
 * `truncated` says so out loud rather than letting an undercount read as
 * "no duplicates".
 */
export const DEDUP_SCAN_LIMIT = 5000

export type DedupCandidateLead = {
  id: string
  firstName: string
  lastName: string
  email: string | null
  phone: string
  status: string
  source: string
  createdAt: Date
}

/**
 * The slice of the `lead` delegate this needs. Written out structurally (as
 * `UserFinder` is in lib/crm/staff.ts) so `tenantId` is a MANDATORY field on
 * both queries — a future caller cannot compile a lookup that drops it.
 */
export type LeadFinder = {
  findFirst(args: {
    where: { id: string; tenantId: string }
    select: { id: true; email: true; phone: true }
  }): Promise<{ id: string; email: string | null; phone: string } | null>
  findMany(args: {
    where: { tenantId: string; id: { not: string } }
    select: {
      id: true
      firstName: true
      lastName: true
      email: true
      phone: true
      status: true
      source: true
      createdAt: true
    }
    orderBy: { createdAt: "desc" }
    take: number
  }): Promise<DedupCandidateLead[]>
}

export type LeadDuplicateReport = {
  duplicates: LeadDuplicate<DedupCandidateLead>[]
  /** Leads compared against the subject (excludes the subject itself). */
  scanned: number
  /** The scan hit DEDUP_SCAN_LIMIT — `duplicates` may be an undercount. */
  truncated: boolean
}

/**
 * Possible duplicates of `leadId` within `tenantId`.
 *
 * The `tenantId` filter is manual and load-bearing: `Lead` is absent from
 * TENANT_SCOPED_MODELS (lib/tenant-scope.ts), so nothing injects it for us and
 * dropping it would show one tenant another tenant's leads — with names, phone
 * numbers and email addresses on screen. Read-only, but a POPIA breach all the
 * same.
 *
 * Newest-first so that if the cap ever binds, the leads dropped are the oldest
 * — the ones least likely to be a live duplicate of a lead being worked now.
 *
 * Takes the `lead` delegate rather than reaching for the client directly, the
 * same way `isAssignableStaff` does. That is what makes the two silent halves
 * of this function testable: the manual `tenantId` filter (nothing injects it —
 * `Lead` is absent from TENANT_SCOPED_MODELS) and the `+ 1` over-fetch. Both
 * are correct here and both fail invisibly — dropping the `+ 1` would pin
 * `truncated` to false forever with every test still green.
 */
export async function findLeadDuplicates(
  leads: LeadFinder,
  leadId: string,
  tenantId: string
): Promise<LeadDuplicateReport> {
  const subject = await leads.findFirst({
    where: { id: leadId, tenantId },
    select: { id: true, email: true, phone: true },
  })
  if (!subject) return { duplicates: [], scanned: 0, truncated: false }

  // limit + 1 so a full page is distinguishable from a page that merely
  // filled the cap exactly — see applyCandidateCap, which owns that boundary.
  const rows = await leads.findMany({
    where: { tenantId, id: { not: leadId } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      status: true,
      source: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: DEDUP_SCAN_LIMIT + 1,
  })

  const { candidates, truncated } = applyCandidateCap(rows, DEDUP_SCAN_LIMIT)

  return {
    duplicates: findDuplicateLeads(subject, candidates),
    scanned: candidates.length,
    truncated,
  }
}

/** `findLeadDuplicates` against the real client. */
export function findLeadDuplicatesForTenant(
  leadId: string,
  tenantId: string
): Promise<LeadDuplicateReport> {
  return findLeadDuplicates(prisma.lead, leadId, tenantId)
}
