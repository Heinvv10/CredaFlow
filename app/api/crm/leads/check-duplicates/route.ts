import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { findPriorOpenLeads, type LeadIdentityFields } from "@/lib/crm/lead-identity"
import { NOTICE_SCAN_LIMIT } from "@/lib/crm/lead-duplicate-notify"

// Read-only duplicate check for the staff lead form.
//
// The public creation paths notify the owning agent after the fact; a staff
// member typing a lead is present, so they get told BEFORE they save instead.
// Notifying them about a duplicate they are in the middle of creating would be
// the notification people learn to dismiss.
//
// Same matcher as the automatic notice (phone + name) so the form and the bell
// cannot disagree about what "the same person" means.
//
// CREDIT_OFFICER, matching the POST that creates a lead: this returns other
// consumers' names and pipeline positions, so it must not be readable by anyone
// who could not already create and view leads.
export async function POST(req: Request) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req as never, async (tenant) => {
    try {
      const body = await req.json()
      const firstName = typeof body?.firstName === "string" ? body.firstName : ""
      const lastName = typeof body?.lastName === "string" ? body.lastName : ""
      const phone = typeof body?.phone === "string" ? body.phone : ""

      const candidates = (await prisma.lead.findMany({
        where: { tenantId: tenant.id },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          phone: true,
          status: true,
          convertedToClientId: true,
          convertedToApplicationId: true,
          conversionRecoveryRequired: true,
        },
        take: NOTICE_SCAN_LIMIT,
      })) as LeadIdentityFields[]

      // `id: ""` never collides with a cuid, so nothing is excluded — the lead
      // being typed does not exist yet.
      const matches = findPriorOpenLeads({ id: "", firstName, lastName, phone }, candidates)

      return NextResponse.json({
        duplicates: matches.map((m) => ({
          id: m.id,
          name: `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim(),
          status: m.status,
        })),
      })
    } catch (error) {
      // A failed check must never block lead capture — the form treats any
      // non-200 as "no known duplicates" and lets the staff member save.
      console.error("[crm/leads/check-duplicates] Error:", error)
      return NextResponse.json({ duplicates: [] })
    }
  })
}
