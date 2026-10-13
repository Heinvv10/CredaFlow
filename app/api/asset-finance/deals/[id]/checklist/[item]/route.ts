import { NextRequest, NextResponse } from "next/server"
import { withPayoutStaff } from "@/lib/asset-finance/payout-route"
import { CHECKLIST_KINDS } from "@/lib/asset-finance/payout-checklist"
import { confirmChecklistItem, type ConfirmInput } from "@/lib/asset-finance/payout-checklist-store"
import { loadPayoutPanel } from "@/lib/asset-finance/payout-view"

type Params = { params: Promise<{ id: string; item: string }> }

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== "string" || value.length > max) return undefined
  return value.trim() === "" ? null : value.trim()
}

function parseConfirm(body: unknown): ConfirmInput | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "Expected a JSON object"
  const record = body as Record<string, unknown>
  const evidenceDocumentId = optionalText(record.evidenceDocumentId, 64)
  const attestedSerial = optionalText(record.attestedSerial, 64)
  const note = optionalText(record.note, 500)
  if (evidenceDocumentId === undefined) return "evidenceDocumentId must be a document id"
  if (attestedSerial === undefined) return "attestedSerial must be text of at most 64 characters"
  if (note === undefined) return "note must be text of at most 500 characters"
  return { evidenceDocumentId, attestedSerial, note }
}

/**
 * Confirms one payout checklist item of a CONTRACTED deal
 * (manage_asset_finance). Body: `{ evidenceDocumentId?, attestedSerial?, note? }`.
 * Every item but the signing ones names a staff-uploaded document of the deal
 * of the item's type; SUPPLIER_INVOICE_MATCHES_ASSET also needs the serial or
 * VIN typed off the invoice, compared with the asset. Refusals are audited
 * (409/422); the database refuses the same (guardPayoutChecklistItem).
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { id, item } = await params
  return withPayoutStaff(req, { dealId: id, permission: "manage_asset_finance" }, async ({ tenantId, user, refuse }) => {
    const kind = CHECKLIST_KINDS.find((k) => k === item)
    if (!kind) return NextResponse.json({ error: "Unknown checklist item" }, { status: 404 })
    const input = parseConfirm(await req.json().catch(() => null))
    if (typeof input === "string") return NextResponse.json({ error: input }, { status: 400 })
    const result = await confirmChecklistItem({ tenantId, userId: user.id, userEmail: user.email }, id, kind, input)
    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Deal or checklist item not found" }, { status: 404 })
      case "not_contracted":
        return NextResponse.json({ error: `The checklist is worked only on a CONTRACTED deal; this one is ${result.status}` }, { status: 409 })
      case "already_confirmed":
        return NextResponse.json({ error: "This item is already confirmed; a confirmed item never changes" }, { status: 409 })
      case "refused":
        return refuse(result.reason, 422, result.error, { item: kind })
      case "confirmed":
        return NextResponse.json(await loadPayoutPanel(tenantId, id))
    }
  })
}
