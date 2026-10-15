import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { readJson, totpWriteRefusal } from "@/lib/accounting/route-helpers"
import { markStalePush, pushBatchToXero, resolveXeroPush } from "@/lib/accounting/xero/push"

// Push a closed month to Xero ({ action: "push" }), or resolve a push whose
// outcome was unknown after checking Xero ({ action: "resolve", outcome:
// "pushed" | "not_pushed", manualJournalId?, note }), or move a push stuck
// SENDING for 10 minutes to review ({ action: "check" }). ADMIN; TOTP when required.

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const { id } = await params
  return withTenantContext(req, async (tenant) => {
    const refusal = await totpWriteRefusal(tenant.id, guard.user, "push journals to Xero")
    if (refusal) return refusal
    const read = await readJson(req)
    if (!read.ok) return read.response
    const body = (read.body ?? {}) as Record<string, unknown>
    const actor = { id: guard.user.id, email: guard.user.email }

    if (body.action === "push") {
      const out = await pushBatchToXero(prisma, { tenantId: tenant.id, batchId: id, actor })
      return out.ok ? NextResponse.json(out) : NextResponse.json(out, { status: out.httpStatus })
    }
    if (body.action === "check") {
      const moved = await markStalePush(prisma, { tenantId: tenant.id, batchId: id, actor })
      return NextResponse.json({ ok: true, movedToReview: moved })
    }
    if (body.action === "resolve") {
      const note = typeof body.note === "string" ? body.note.trim() : ""
      const outcome = body.outcome
      const manualJournalId = typeof body.manualJournalId === "string" && body.manualJournalId.trim() ? body.manualJournalId.trim().slice(0, 64) : null
      if ((outcome !== "pushed" && outcome !== "not_pushed") || note.length < 5) {
        return NextResponse.json({ error: "outcome (pushed | not_pushed) and a note of at least 5 characters are required" }, { status: 400 })
      }
      if (outcome === "pushed" && !manualJournalId) {
        return NextResponse.json({ error: "Give the Xero manual journal id you found" }, { status: 400 })
      }
      const ok = await resolveXeroPush(prisma, { tenantId: tenant.id, batchId: id, outcome, manualJournalId, note: note.slice(0, 1000), actor })
      return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "No push of this batch is awaiting review" }, { status: 409 })
    }
    return NextResponse.json({ error: "action must be push, check or resolve" }, { status: 400 })
  })
}
