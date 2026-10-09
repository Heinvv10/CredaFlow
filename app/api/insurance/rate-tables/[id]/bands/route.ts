import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"
import { readJsonObject } from "../../../request-body"
import { parseBandInput, overlapWhere, overlapDetail } from "../../band-input"
import { lockRateTable } from "../../rate-table-lock"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireApiRole("READONLY")
    if (guard.error) return guard.error

    const { id } = await params

    return await withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      // InsuranceRateBand has no tenantId of its own — it is reached only
      // through its table, so the tenant check has to happen here.
      const table = await prisma.insuranceRateTable.findFirst({
        where: { id, tenantId: tenant.id },
        select: { id: true, status: true },
      })
      if (!table) return NextResponse.json({ error: "Not found" }, { status: 404 })

      const bands = await prisma.insuranceRateBand.findMany({
        where: { rateTableId: id },
        orderBy: [{ lifeType: "asc" }, { sumAssured: "asc" }, { minAge: "asc" }],
      })

      return NextResponse.json(bands)
    })
  } catch {
    return NextResponse.json({ error: "Failed to fetch rate bands" }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    const { id } = await params

    return await withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const table = await prisma.insuranceRateTable.findFirst({
        where: { id, tenantId: tenant.id },
        select: { id: true, status: true },
      })
      if (!table) return NextResponse.json({ error: "Not found" }, { status: 404 })

      // Adding a row to an ACTIVE table would change what in-force policies
      // were priced from. The table itself is immutable, and so are its bands.
      if (table.status !== "DRAFT") {
        return NextResponse.json(
          { error: "Bands can only be added to a DRAFT rate table. Create a new version instead." },
          { status: 409 }
        )
      }

      const parsedBody = await readJsonObject(req)
      if (!parsedBody.ok) {
        return NextResponse.json({ error: parsedBody.error }, { status: 422 })
      }
      const body = parsedBody.body

      const parsed = parseBandInput(body)
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 422 })
      const band = parsed.value

      // The overlap check and the insert run inside ONE transaction, behind a
      // FOR UPDATE lock on the parent table, because separately they do not
      // hold. Two concurrent POSTs for ages 18-30 and 25-40 at the same life
      // type and cover BOTH see no overlap — neither has committed — and both
      // then insert successfully, because
      // @@unique([rateTableId, lifeType, minAge, maxAge, sumAssured]) only
      // rejects an EXACT tuple duplicate, not an overlapping range. The result
      // prices age 27 two ways, which makes the product unquotable rather than
      // merely mispriced. Serialising the writers is what actually prevents it;
      // the unique index is a duplicate-row guard and nothing more.
      //
      // The same lock re-verifies the parent is STILL DRAFT (the status read
      // above it is a courtesy, taken outside any lock).
      let result
      try {
        result = await prisma.$transaction(async (tx) => {
          const locked = await lockRateTable(tx, { id, tenantId: tenant.id })
          if (!locked) return { kind: "gone" } as const
          if (locked.status !== "DRAFT") return { kind: "immutable" } as const

          // The BASIS comes from the locked row, not from the courtesy read
          // above: it decides which bands collide, and a concurrent PATCH of it
          // would otherwise have this check applying a rule the stored row is
          // not under.
          const overlapping = await tx.insuranceRateBand.findFirst({
            where: overlapWhere(id, locked.basis, band),
            select: { id: true, minAge: true, maxAge: true },
          })
          if (overlapping) return { kind: "overlap", basis: locked.basis, overlapping } as const

          const created = await tx.insuranceRateBand.create({
            data: { rateTableId: id, ...band },
          })
          return { kind: "created", created } as const
        })
      } catch (err) {
        // Belt and braces: with the lock held this should be unreachable, but
        // an exact-duplicate tuple is still the index's to reject.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          return NextResponse.json({ error: "That band already exists" }, { status: 409 })
        }
        throw err
      }

      if (result.kind === "gone") {
        return NextResponse.json({ error: "Not found" }, { status: 404 })
      }
      if (result.kind === "immutable") {
        return NextResponse.json(
          { error: "Bands can only be added to a DRAFT rate table. Create a new version instead." },
          { status: 409 }
        )
      }
      if (result.kind === "overlap") {
        return NextResponse.json(
          {
            error: `This band overlaps an existing band (ages ${result.overlapping.minAge}-${result.overlapping.maxAge}) already covering ${overlapDetail(result.basis, band)}`,
          },
          { status: 409 }
        )
      }
      const created = result.created

      await logAudit({
        tenantId: tenant.id,
        userId: guard.user?.id,
        userEmail: guard.user?.email,
        action: AuditAction.INSURANCE_RATE_BAND_CREATED,
        entity: "InsuranceRateBand",
        entityId: created.id,
        // The PERSISTED row, not the parsed input: the Decimal(12,2) columns
        // are what an auditor is shown as the rate actually on the card.
        newValue: created,
      })

      return NextResponse.json(created)
    })
  } catch (error) {
    console.error("Failed to create rate band:", error)
    return NextResponse.json({ error: "Failed to create rate band" }, { status: 500 })
  }
}
