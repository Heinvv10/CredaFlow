import { NextRequest, NextResponse } from "next/server"
import type { ChangeRequestStatus } from "@prisma/client"
import { requireApiRole } from "@/lib/auth-guards"
import { candidateKinds, changeRequestErrorResponse, maySeeRow, presentChangeRequest } from "@/lib/maker-checker/http"
import { createDraft, listChangeRequests } from "@/lib/maker-checker/service"
import { withTenantContext } from "@/lib/tenant"

const STATUSES: readonly string[] = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "WITHDRAWN"]

/** Change requests the caller may make or approve, newest first; ?kind=, ?status=, ?limit= and ?cursor= (the last id of the previous page). */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const status = req.nextUrl.searchParams.get("status")
    if (status && !STATUSES.includes(status)) return NextResponse.json({ error: "Unknown status" }, { status: 400 })
    const kind = req.nextUrl.searchParams.get("kind")
    const kinds = candidateKinds(guard.user.role).filter((k) => !kind || k === kind)
    const limit = Number(req.nextUrl.searchParams.get("limit") ?? "")
    const { rows, nextCursor } = await listChangeRequests(tenant.id, {
      kinds,
      status: status ? [status as ChangeRequestStatus] : undefined,
      limit: Number.isInteger(limit) && limit > 0 ? limit : undefined,
      cursor: req.nextUrl.searchParams.get("cursor") ?? undefined,
    })
    const visible = rows.filter((row) => maySeeRow(guard.user.role, row))
    return NextResponse.json({ requests: visible.map((row) => presentChangeRequest(row, guard.user.id, guard.user.role)), nextCursor })
  })
}

/** Drafts a change: { kind, title, payload }. The maker is the caller. */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
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
