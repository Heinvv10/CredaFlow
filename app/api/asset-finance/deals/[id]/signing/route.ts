import { NextRequest, NextResponse } from "next/server"
import { sastCalendarDate } from "@/lib/date/sast"
import { withSigningStaff } from "@/lib/asset-finance/signing-route"
import { prepareDealDocuments } from "@/lib/asset-finance/signing-prepare"
import { loadStaffSigningPanel } from "@/lib/asset-finance/signing-view"

type Params = { params: Promise<{ id: string }> }

/** The deal's signer rows and their state (any staff role). */
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params
  return withSigningStaff(req, { dealId: id, manage: false }, async ({ tenantId }) => {
    const panel = await loadStaffSigningPanel(tenantId, id)
    if (!panel) return NextResponse.json({ error: "Deal not found" }, { status: 404 })
    return NextResponse.json(panel)
  })
}

/** `{ plannedStartDate?: "YYYY-MM-DD" }`; absent or null means today (SAST). */
function parsePlannedStart(body: unknown): { plannedStartDate: string } | string {
  if (body === null || body === undefined) return { plannedStartDate: sastCalendarDate(new Date()) }
  if (typeof body !== "object" || Array.isArray(body)) return "Expected a JSON object"
  const value = (body as Record<string, unknown>).plannedStartDate
  if (value === undefined || value === null || value === "") return { plannedStartDate: sastCalendarDate(new Date()) }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "plannedStartDate must be a date YYYY-MM-DD"
  return { plannedStartDate: value }
}

/**
 * Prepare an APPROVED deal's documents (manage_asset_finance;
 * lib/asset-finance/signing-prepare.ts): render and store the agreement, the
 * resolution and a suretyship per surety, create the signer rows, and fix the
 * contract terms from the chosen start date. Body:
 * `{ plannedStartDate?: "YYYY-MM-DD" }` (default today, SAST; before the
 * first instalment). 409 once anything is signed or scanned, when the deal is
 * not APPROVED, or when nobody has authority to sign; 422 when the start date
 * is not before the first instalment, the lender identity is not configured
 * or the schedule cannot be solved.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params
  return withSigningStaff(req, { dealId: id, manage: true }, async ({ tenantId, user, refuse }) => {
    const text = await req.text()
    let body: unknown = null
    try {
      body = text.trim() === "" ? null : JSON.parse(text)
    } catch {
      return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 })
    }
    const input = parsePlannedStart(body)
    if (typeof input === "string") return NextResponse.json({ error: input }, { status: 400 })
    const result = await prepareDealDocuments({ tenantId, userId: user.id, userEmail: user.email }, id, input.plannedStartDate)
    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Deal not found" }, { status: 404 })
      case "not_approved":
        return NextResponse.json({ error: `Documents are prepared for an APPROVED deal; this one is ${result.status}` }, { status: 409 })
      case "signing_started":
        return refuse("signing_started", 409, "Signing has started; the documents can no longer be prepared again")
      case "no_authority":
        return refuse(
          "no_authority", 409,
          "Nobody can sign for this entity: record its authorised signatories (or, for a company or trust, its directors or trustees)",
        )
      case "invalid_start":
        return refuse("invalid_start", 422, result.error)
      case "people_changed":
        return NextResponse.json({ error: "The entity's people changed while the documents were prepared; try again" }, { status: 409 })
      case "prepared":
        return NextResponse.json(await loadStaffSigningPanel(tenantId, id))
    }
  })
}
