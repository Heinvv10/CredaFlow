import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"
import { readJsonObject } from "../../../../request-body"
import { parseBandInput, overlapWhere, overlapDetail, type BandInput } from "../../../band-input"
import { lockRateTable } from "../../../rate-table-lock"

const IMMUTABLE =
  "Bands can only be changed on a DRAFT rate table. Create a new version instead."

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; bandId: string }> }
) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    const { id, bandId } = await params

    return await withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const table = await prisma.insuranceRateTable.findFirst({
        where: { id, tenantId: tenant.id },
        select: { id: true, status: true },
      })
      if (!table) return NextResponse.json({ error: "Not found" }, { status: 404 })
      if (table.status !== "DRAFT") {
        return NextResponse.json({ error: IMMUTABLE }, { status: 409 })
      }

      const parsedBody = await readJsonObject(req)
      if (!parsedBody.ok) {
        return NextResponse.json({ error: parsedBody.error }, { status: 422 })
      }
      const body = parsedBody.body

      // Everything below runs in ONE transaction behind a FOR UPDATE lock on
      // the parent table, for the same reason the POST path does: an overlap
      // check that is a separate autocommit statement from the update it
      // guards proves nothing about the table at the instant the update lands,
      // and the unique index only rejects an EXACT tuple duplicate. Widening a
      // band's range concurrently with a sibling insert is exactly the case it
      // misses. The lock also re-verifies the parent is STILL DRAFT.
      let result
      try {
        result = await prisma.$transaction(async (tx) => {
          const locked = await lockRateTable(tx, { id, tenantId: tenant.id })
          if (!locked) return { kind: "gone" } as const
          if (locked.status !== "DRAFT") return { kind: "immutable" } as const

          const existing = await tx.insuranceRateBand.findFirst({
            where: { id: bandId, rateTableId: id },
          })
          if (!existing) return { kind: "noBand" } as const

          // Validate the MERGED band, not just the supplied keys: a PATCH that
          // sends only maxAge can still invert the range or collide with a sibling.
          const base: BandInput = {
            lifeType: existing.lifeType,
            minAge: existing.minAge,
            maxAge: existing.maxAge,
            sumAssured: Number(existing.sumAssured),
            premiumAmount: Number(existing.premiumAmount),
          }
          const parsed = parseBandInput(body, base)
          if (!parsed.ok) return { kind: "invalid", error: parsed.error } as const
          const band = parsed.value

          // Basis from the locked row: it decides which bands collide, so
          // reading it outside the lock would apply a rule the stored row may
          // no longer be under.
          const overlapping = await tx.insuranceRateBand.findFirst({
            where: overlapWhere(id, locked.basis, band, bandId),
            select: { id: true, minAge: true, maxAge: true },
          })
          if (overlapping) return { kind: "overlap", basis: locked.basis, band, overlapping } as const

          const updated = await tx.insuranceRateBand.update({ where: { id: bandId }, data: band })
          return { kind: "updated", base, updated } as const
        })
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          return NextResponse.json({ error: "That band already exists" }, { status: 409 })
        }
        throw err
      }

      if (result.kind === "gone") return NextResponse.json({ error: "Not found" }, { status: 404 })
      if (result.kind === "immutable") {
        return NextResponse.json({ error: IMMUTABLE }, { status: 409 })
      }
      if (result.kind === "noBand") {
        return NextResponse.json({ error: "Band not found" }, { status: 404 })
      }
      if (result.kind === "invalid") {
        return NextResponse.json({ error: result.error }, { status: 422 })
      }
      if (result.kind === "overlap") {
        const { basis, band, overlapping } = result
        return NextResponse.json(
          {
            error: `This band overlaps an existing band (ages ${overlapping.minAge}-${overlapping.maxAge}) already covering ${overlapDetail(basis, band)}`,
          },
          { status: 409 }
        )
      }
      const { base, updated } = result

      await logAudit({
        tenantId: tenant.id,
        userId: guard.user?.id,
        userEmail: guard.user?.email,
        action: AuditAction.INSURANCE_RATE_BAND_UPDATED,
        entity: "InsuranceRateBand",
        entityId: bandId,
        oldValue: base,
        // The PERSISTED row, not the merged input.
        newValue: updated,
      })

      return NextResponse.json(updated)
    })
  } catch (error) {
    console.error("Failed to update rate band:", error)
    return NextResponse.json({ error: "Failed to update rate band" }, { status: 500 })
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; bandId: string }> }
) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    const { id, bandId } = await params

    return await withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const table = await prisma.insuranceRateTable.findFirst({
        where: { id, tenantId: tenant.id },
        select: { id: true, status: true },
      })
      if (!table) return NextResponse.json({ error: "Not found" }, { status: 404 })
      if (table.status !== "DRAFT") {
        return NextResponse.json({ error: IMMUTABLE }, { status: 409 })
      }

      // Same lock as the other band writes. Removing a band from a table that
      // has just gone ACTIVE would punch a hole in a live rate card — an age
      // that priced yesterday would stop resolving today — so the DRAFT status
      // is re-read under the lock rather than trusted from the read above.
      const result = await prisma.$transaction(async (tx) => {
        const locked = await lockRateTable(tx, { id, tenantId: tenant.id })
        if (!locked) return { kind: "gone" } as const
        if (locked.status !== "DRAFT") return { kind: "immutable" } as const

        const existing = await tx.insuranceRateBand.findFirst({
          where: { id: bandId, rateTableId: id },
        })
        if (!existing) return { kind: "noBand" } as const

        await tx.insuranceRateBand.delete({ where: { id: bandId } })
        return { kind: "deleted", existing } as const
      })

      if (result.kind === "gone") return NextResponse.json({ error: "Not found" }, { status: 404 })
      if (result.kind === "immutable") {
        return NextResponse.json({ error: IMMUTABLE }, { status: 409 })
      }
      if (result.kind === "noBand") {
        return NextResponse.json({ error: "Band not found" }, { status: 404 })
      }
      const { existing } = result

      await logAudit({
        tenantId: tenant.id,
        userId: guard.user?.id,
        userEmail: guard.user?.email,
        action: AuditAction.INSURANCE_RATE_BAND_DELETED,
        entity: "InsuranceRateBand",
        entityId: bandId,
        oldValue: {
          rateTableId: id,
          lifeType: existing.lifeType,
          minAge: existing.minAge,
          maxAge: existing.maxAge,
          sumAssured: Number(existing.sumAssured),
          premiumAmount: Number(existing.premiumAmount),
        },
      })

      return NextResponse.json({ ok: true })
    })
  } catch (error) {
    console.error("Failed to delete rate band:", error)
    return NextResponse.json({ error: "Failed to delete rate band" }, { status: 500 })
  }
}
