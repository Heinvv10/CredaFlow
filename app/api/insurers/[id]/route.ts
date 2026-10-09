import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("READONLY")
    if (guard.error) return guard.error

    return withTenantContext(req, async () => {
      const { id } = await params

      const insurer = await prisma.insurer.findUnique({ where: { id } })
      if (!insurer) return NextResponse.json({ error: "Insurer not found" }, { status: 404 })

      return NextResponse.json(insurer)
    })
  } catch (error) {
    console.error("Failed to get insurer:", error)
    return NextResponse.json({ error: "Failed to get insurer" }, { status: 500 })
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("ADMIN")
    if (guard.error) return guard.error

    return withTenantContext(req, async () => {
      const { id } = await params
      const body = await req.json() as {
        name?: string
        fspNumber?: string
        contactName?: string
        contactEmail?: string
        contactPhone?: string
        apiEndpoint?: string
        active?: boolean
      }

      const updateData: Record<string, unknown> = {}
      if (body.name !== undefined) updateData.name = body.name
      if (body.fspNumber !== undefined) updateData.fspNumber = body.fspNumber
      if (body.contactName !== undefined) updateData.contactName = body.contactName
      if (body.contactEmail !== undefined) updateData.contactEmail = body.contactEmail
      if (body.contactPhone !== undefined) updateData.contactPhone = body.contactPhone
      if (body.apiEndpoint !== undefined) updateData.apiEndpoint = body.apiEndpoint
      if (body.active !== undefined) updateData.active = body.active

      const insurer = await prisma.insurer.update({
        where: { id },
        data: updateData,
      })

      return NextResponse.json(insurer)
    })
  } catch (error) {
    console.error("Failed to update insurer:", error)
    return NextResponse.json({ error: "Failed to update insurer" }, { status: 500 })
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("ADMIN")
    if (guard.error) return guard.error

    return withTenantContext(req, async () => {
      const { id } = await params

      await prisma.insurer.delete({ where: { id } })

      return NextResponse.json({ ok: true })
    })
  } catch (error) {
    console.error("Failed to delete insurer:", error)
    return NextResponse.json({ error: "Failed to delete insurer" }, { status: 500 })
  }
}
