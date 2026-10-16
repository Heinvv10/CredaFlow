import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { readJson } from "@/lib/accounting/route-helpers"
import { pushBatchToIsaFlow, resolveIsaFlowPush } from "@/lib/accounting/isaflow/push"
import { checkIsaFlowPush } from "@/lib/accounting/isaflow/retry"

// Push a closed month to IsaFlow as a draft journal ({ action: "push" }; a
// FAILED push is read back first, then resent under its key), read back a push
// with no answer ({ action: "check" }: a SENDING claim older than 10 minutes
// goes to review, a push in review is looked for in IsaFlow and resent only if
// absent), or record what a person found ({ action: "resolve", outcome:
// "pushed" | "not_pushed", journalId?, note }). ADMIN, and a session that
// verified a TOTP code whatever the lender's 2FA policy: this writes to the
// lender's general ledger.

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  if (guard.user.totpVerified !== true) {
    return NextResponse.json(
      { error: "Sign in with two-factor authentication to push journals to IsaFlow. Enable it under Settings → Security, then sign out and back in." },
      { status: 403 },
    )
  }
  const { id } = await params
  return withTenantContext(req, async (tenant) => {
    const read = await readJson(req)
    if (!read.ok) return read.response
    const body = (read.body ?? {}) as Record<string, unknown>
    const actor = { id: guard.user.id, email: guard.user.email }
    const answer = (out: { ok: boolean; httpStatus?: number }) => (out.ok ? NextResponse.json(out) : NextResponse.json(out, { status: out.httpStatus }))

    if (body.action === "push") return answer(await pushBatchToIsaFlow(prisma, { tenantId: tenant.id, batchId: id, actor }))
    if (body.action === "check") return answer(await checkIsaFlowPush(prisma, { tenantId: tenant.id, batchId: id, actor }))
    if (body.action === "resolve") {
      const note = typeof body.note === "string" ? body.note.trim() : ""
      const outcome = body.outcome
      const journalId = typeof body.journalId === "string" && body.journalId.trim() ? body.journalId.trim().slice(0, 64) : null
      if ((outcome !== "pushed" && outcome !== "not_pushed") || note.length < 5) {
        return NextResponse.json({ error: "outcome (pushed | not_pushed) and a note of at least 5 characters are required" }, { status: 400 })
      }
      if (outcome === "pushed" && !journalId) return NextResponse.json({ error: "Give the IsaFlow journal id you found" }, { status: 400 })
      const ok = await resolveIsaFlowPush(prisma, { tenantId: tenant.id, batchId: id, outcome, journalId, note: note.slice(0, 1000), actor })
      return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "No push of this batch is awaiting review" }, { status: 409 })
    }
    return NextResponse.json({ error: "action must be push, check or resolve" }, { status: 400 })
  })
}
