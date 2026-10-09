import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const notes = await prisma.loanNote.findMany({ where: { loanId: id, tenantId: tenant.id }, orderBy: { createdAt: "desc" } })
    return NextResponse.json(notes)
  })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("COLLECTIONS_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = await req.json()
    const note = await prisma.loanNote.create({
      data: {
        tenantId: tenant.id,
        loanId: id,
        type: body.type ?? "contact",
        note: body.note,
        createdBy: guard.user.email ?? "system",
      },
    })
    return NextResponse.json(note, { status: 201 })
  })
}
