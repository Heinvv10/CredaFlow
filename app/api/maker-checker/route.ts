import { NextRequest, NextResponse } from "next/server"
import type { ChangeRequestStatus } from "@prisma/client"
import { requireApiRole } from "@/lib/auth-guards"
import { changeRequestErrorResponse, maySeeKind, presentChangeRequest } from "@/lib/maker-checker/http"
import { createDraft, listChangeRequests } from "@/lib/maker-checker/service"
import { withTenantContext } from "@/lib/tenant"

const STATUSES: readonly string[] = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "WITHDRAWN"]

/** Change requests the caller may make or approve; ?kind= and ?status= narrow them. */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const status = req.nextUrl.searchParams.get("status")
    if (status && !STATUSES.includes(status)) return NextResponse.json({ error: "Unknown status" }, { status: 400 })
    const rows = await listChangeRequests(tenant.id, {
      kind: req.nextUrl.searchParams.get("kind") ?? undefined,
      status: (status as ChangeRequestStatus | null) ?? undefined,
    })
    const visible = rows.filter((row) => maySeeKind(guard.user.role, row.kind))
    return NextResponse.json({ requests: visible.map((row) => presentChangeRequest(row, guard.user.id, guard.user.role)) })
  })
}

/** Drafts a change: { kind, title, payload }. The maker is the caller. */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const body = (await req.json().catch(() => null)) as { kind?: unknown; title?: unknown; payload?: unknown } | null
    if (!body || typeof body.kind !== "string" || typeof body.title !== "string") {
      return NextResponse.json({ error: "Expected { kind, title, payload }" }, { status: 400 })
    }
    try {
      const row = await createDraft({ tenantId: tenant.id, actor: guard.user, kind: body.kind, title: body.title, payload: body.payload })
      return NextResponse.json({ request: presentChangeRequest(row, guard.user.id, guard.user.role) }, { status: 201 })
    } catch (error) {
      return changeRequestErrorResponse(error)
    }
  })
}
