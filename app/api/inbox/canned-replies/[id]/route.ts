import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { updateCannedReply, deleteCannedReply } from "@/lib/inbox/canned-replies"

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const { id } = await ctx.params
  const body = (await req.json()) as { title?: string; body?: string }
  return withTenantContext(req, async (tenant) => {
    const res = await updateCannedReply({ tenantId: tenant.id, id, title: body.title, body: body.body, actorUserId: guard.user.id, actorEmail: guard.user.email })
    if (!res.ok) return NextResponse.json({ error: "not found" }, { status: 404 })
    return NextResponse.json({ ok: true })
  })
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const { id } = await ctx.params
  return withTenantContext(req, async (tenant) => {
    const res = await deleteCannedReply({ tenantId: tenant.id, id, actorUserId: guard.user.id, actorEmail: guard.user.email })
    if (!res.ok) return NextResponse.json({ error: "not found" }, { status: 404 })
    return NextResponse.json({ ok: true })
  })
}
