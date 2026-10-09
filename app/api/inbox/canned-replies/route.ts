import { NextRequest, NextResponse } from "next/server"
import { requireCommsAgent } from "@/lib/inbox/authz"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { listCannedReplies, createCannedReply } from "@/lib/inbox/canned-replies"

export async function GET(req: NextRequest) {
  const guard = await requireCommsAgent()
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => NextResponse.json(await listCannedReplies(tenant.id)))
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const body = (await req.json()) as { title?: string; body?: string }
  const title = (body.title ?? "").trim()
  const text = (body.body ?? "").trim()
  if (title === "" || text === "") return NextResponse.json({ error: "title and body are required" }, { status: 400 })
  return withTenantContext(req, async (tenant) =>
    NextResponse.json(await createCannedReply({ tenantId: tenant.id, title, body: text, createdById: guard.user.id, actorEmail: guard.user.email })),
  )
}
