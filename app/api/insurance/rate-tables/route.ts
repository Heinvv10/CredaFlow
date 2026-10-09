import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { Prisma, RateBasis } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"
import { readJsonObject } from "../request-body"

const RATE_BASES = Object.values(RateBasis) as string[]

export async function GET(req: NextRequest) {
  try {
    const guard = await requireApiRole("READONLY")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const productId = req.nextUrl.searchParams.get("productId")

      const tables = await prisma.insuranceRateTable.findMany({
        where: { tenantId: tenant.id, ...(productId ? { productId } : {}) },
        orderBy: [{ productId: "asc" }, { version: "desc" }],
        include: { _count: { select: { bands: true } } },
      })

      return NextResponse.json(tables)
    })
  } catch {
    return NextResponse.json({ error: "Failed to fetch rate tables" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const parsedBody = await readJsonObject(req)
      if (!parsedBody.ok) {
        return NextResponse.json({ error: parsedBody.error }, { status: 422 })
      }
      const body = parsedBody.body

      const productId = typeof body.productId === "string" ? body.productId : null
      const name = typeof body.name === "string" ? body.name.trim() : ""
      if (!productId || !name) {
        return NextResponse.json({ error: "productId and name are required" }, { status: 422 })
      }

      const basis = body.basis === undefined ? RateBasis.AGE_BANDED : String(body.basis)
      if (!RATE_BASES.includes(basis)) {
        return NextResponse.json(
          { error: `basis must be one of ${RATE_BASES.join(", ")}` },
          { status: 422 }
        )
      }

      // Deliberately NOT routed through `parseInsuranceDateInput`, unlike the
      // quote and bind seams. This value is only ever the draft's; activation
      // restamps `effectiveFrom` with its own `now` and discards whatever is
      // stored here, so a date-only string cannot reach any pricing decision.
      const effectiveFrom = body.effectiveFrom ? new Date(String(body.effectiveFrom)) : new Date()
      if (Number.isNaN(effectiveFrom.getTime())) {
        return NextResponse.json({ error: "effectiveFrom is not a valid date" }, { status: 422 })
      }

      // Tenant-scoped lookup: a product belonging to another tenant is a 404,
      // never a 403 that would confirm the id exists.
      const product = await prisma.insuranceProduct.findFirst({
        where: { id: productId, tenantId: tenant.id },
        select: { id: true },
      })
      if (!product) {
        return NextResponse.json({ error: "Insurance product not found" }, { status: 404 })
      }

      const insurerId = typeof body.insurerId === "string" ? body.insurerId : null
      if (insurerId) {
        const insurer = await prisma.insurer.findFirst({
          where: { id: insurerId, tenantId: tenant.id },
          select: { id: true },
        })
        if (!insurer) {
          return NextResponse.json({ error: "Insurer not found" }, { status: 404 })
        }
      }

      // Version is SERVER-assigned. A client-supplied version would let a
      // caller overwrite the numbering that in-force policies are traced
      // back through; a client-supplied status would skip activation and
      // its zero-band check entirely. Both are ignored.
      const latest = await prisma.insuranceRateTable.findFirst({
        where: { tenantId: tenant.id, productId },
        orderBy: { version: "desc" },
        select: { version: true },
      })
      const version = (latest?.version ?? 0) + 1

      let table
      try {
        table = await prisma.insuranceRateTable.create({
          data: {
            tenantId: tenant.id,
            productId,
            insurerId,
            version,
            name,
            status: "DRAFT",
            basis: basis as RateBasis,
            effectiveFrom,
            createdById: guard.user?.id ?? null,
          },
        })
      } catch (err) {
        // @@unique([tenantId, productId, version]) — two concurrent creates
        // derived the same next version. Surfacing the collision is honest;
        // silently renumbering is not.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          return NextResponse.json(
            { error: "Another rate table version was created concurrently, please retry" },
            { status: 409 }
          )
        }
        throw err
      }

      await logAudit({
        tenantId: tenant.id,
        userId: guard.user?.id,
        userEmail: guard.user?.email,
        action: AuditAction.INSURANCE_RATE_TABLE_CREATED,
        entity: "InsuranceRateTable",
        entityId: table.id,
        // The PERSISTED row, not the parsed input. For a regulated rate card
        // the audit trail has to be evidence of what the database holds; the
        // two differ wherever a column rounds or defaults.
        newValue: table,
      })

      return NextResponse.json(table)
    })
  } catch (error) {
    console.error("Failed to create rate table:", error)
    return NextResponse.json({ error: "Failed to create rate table" }, { status: 500 })
  }
}
