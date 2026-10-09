import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"

export async function GET(req: NextRequest) {
  try {
    const guard = await requireApiRole("READONLY")
    if (guard.error) return guard.error

    return withTenantContext(req, async (tenant) => {
      const insurers = await prisma.insurer.findMany({
        where: { tenantId: tenant.id },
        orderBy: { name: "asc" },
      })

      return NextResponse.json(insurers)
    })
  } catch (error) {
    console.error("Failed to list insurers:", error)
    return NextResponse.json({ error: "Failed to list insurers" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const guard = await requireApiRole("ADMIN")
    if (guard.error) return guard.error

    return withTenantContext(req, async (tenant) => {
      const body = await req.json() as {
        name: string
        fspNumber?: string
        contactName?: string
        contactEmail?: string
        contactPhone?: string
        apiEndpoint?: string
        active?: boolean
      }

      if (!body.name) {
        return NextResponse.json({ error: "name is required" }, { status: 400 })
      }

      const insurer = await prisma.insurer.create({
        data: {
          tenantId: tenant.id,
          name: body.name,
          fspNumber: body.fspNumber ?? null,
          contactName: body.contactName ?? null,
          contactEmail: body.contactEmail ?? null,
          contactPhone: body.contactPhone ?? null,
          apiEndpoint: body.apiEndpoint ?? null,
          active: body.active ?? true,
        },
      })

      return NextResponse.json(insurer, { status: 201 })
    })
  } catch (error) {
    console.error("Failed to create insurer:", error)
    return NextResponse.json({ error: "Failed to create insurer" }, { status: 500 })
  }
}
