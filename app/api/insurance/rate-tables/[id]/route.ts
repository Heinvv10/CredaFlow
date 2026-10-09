import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { RateBasis } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"
import { firstCollision } from "@/lib/insurance/rating/band-match"
import { readJsonObject } from "../../request-body"
import { lockRateTable } from "../rate-table-lock"

const RATE_BASES = Object.values(RateBasis) as string[]

/**
 * Once a rate table leaves DRAFT it is frozen. An ACTIVE table is what
 * in-force policies were priced from and a RETIRED one is the historical
 * record of that price; editing either would silently restate what a client
 * was sold. A rate change is a NEW version — see the activate route, which
 * retires the previous one in the same transaction.
 */
const IMMUTABLE = "Only a DRAFT rate table can be modified. Create a new version instead."

/**
 * The status read before a write is a courtesy — a friendly rejection that
 * costs nothing. It is NOT the guard. Between that read and the write, a
 * concurrent activate can take the same table ACTIVE, and an unconditional
 * `update({ where: { id } })` would then silently restate the rate an in-force
 * policy was sold at; the DELETE equivalent would destroy an ACTIVE card and,
 * via `InsuranceRateBand.rateTable onDelete: Cascade`, every priced band with
 * it.
 *
 * So every write repeats the whole predicate — id, tenant AND status — inside
 * its own WHERE clause and checks how many rows it actually matched. That is
 * one atomic statement in Postgres: it either finds a row that is still DRAFT
 * and owned by this tenant, or it changes nothing and returns 0. Same shape as
 * the retire route.
 */
const LOST_RACE = "This rate table is no longer a DRAFT — it changed while this request was in flight."

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireApiRole("READONLY")
    if (guard.error) return guard.error

    const { id } = await params

    return await withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const table = await prisma.insuranceRateTable.findFirst({
        where: { id, tenantId: tenant.id },
        include: { bands: { orderBy: [{ lifeType: "asc" }, { sumAssured: "asc" }, { minAge: "asc" }] } },
      })
      if (!table) return NextResponse.json({ error: "Not found" }, { status: 404 })

      return NextResponse.json(table)
    })
  } catch {
    return NextResponse.json({ error: "Failed to fetch rate table" }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    const { id } = await params

    return await withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const table = await prisma.insuranceRateTable.findFirst({
        where: { id, tenantId: tenant.id },
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

      // Only these fields are writable. `status` and `version` are deliberately
      // absent: status moves through the activate/retire routes (which enforce
      // the zero-band check and the single-ACTIVE invariant), and version is
      // server-assigned at creation.
      const data: {
        name?: string
        basis?: RateBasis
        effectiveFrom?: Date
        insurerId?: string | null
      } = {}

      if (body.name !== undefined) {
        const name = typeof body.name === "string" ? body.name.trim() : ""
        if (!name) return NextResponse.json({ error: "name must not be empty" }, { status: 422 })
        data.name = name
      }

      if (body.basis !== undefined) {
        const basis = String(body.basis)
        if (!RATE_BASES.includes(basis)) {
          return NextResponse.json(
            { error: `basis must be one of ${RATE_BASES.join(", ")}` },
            { status: 422 }
          )
        }
        data.basis = basis as RateBasis
      }

      if (body.effectiveFrom !== undefined) {
        const effectiveFrom = new Date(String(body.effectiveFrom))
        if (Number.isNaN(effectiveFrom.getTime())) {
          return NextResponse.json({ error: "effectiveFrom is not a valid date" }, { status: 422 })
        }
        data.effectiveFrom = effectiveFrom
      }

      if (body.insurerId !== undefined) {
        const insurerId = typeof body.insurerId === "string" ? body.insurerId : null
        if (insurerId) {
          const insurer = await prisma.insurer.findFirst({
            where: { id: insurerId, tenantId: tenant.id },
            select: { id: true },
          })
          if (!insurer) return NextResponse.json({ error: "Insurer not found" }, { status: 404 })
        }
        data.insurerId = insurerId
      }

      // A body with no writable key is not an edit. Writing it anyway bumps
      // updatedAt and files an audit row reading `newValue: {}` — a record
      // asserting a change that never happened.
      if (Object.keys(data).length === 0) {
        return NextResponse.json(
          { error: "No writable fields supplied. Send name, basis, effectiveFrom or insurerId." },
          { status: 422 }
        )
      }

      // Changing `basis` is the ONE edit on this route whose validity depends
      // on rows in another table. It re-keys every band the card already holds:
      // `bandMatchAxes` says which of (age, cover) the basis matches on, so two
      // MAIN_MEMBER 18-65 bands at different cover amounts are fine under
      // AGE_BANDED and ambiguous under PER_MILLE, which ignores a band's own
      // sumAssured. Without this check the exact state the band routes refuse
      // to configure was reachable by writing the bands first and switching the
      // basis afterwards.
      //
      // Hence the only PATCH that needs a transaction: it must exclude
      // concurrent band writers, which serialise on the rate-table row lock. It
      // takes the SAME lock, and only that one — see the ordering note in
      // `rate-table-lock.ts`.
      if (data.basis !== undefined && data.basis !== table.basis) {
        const rebased = await prisma.$transaction(async (tx) => {
          const locked = await lockRateTable(tx, { id, tenantId: tenant.id })
          if (!locked || locked.status !== "DRAFT") return { kind: "lostRace" } as const

          const bands = await tx.insuranceRateBand.findMany({
            where: { rateTableId: id },
            select: { id: true, lifeType: true, minAge: true, maxAge: true, sumAssured: true },
          })
          const collision = firstCollision(data.basis as RateBasis, bands)
          if (collision) return { kind: "collision", collision } as const

          const count = await tx.insuranceRateTable.updateMany({
            where: { id, tenantId: tenant.id, status: "DRAFT" },
            data,
          })
          return { kind: "written", count: count.count } as const
        })

        if (rebased.kind === "collision") {
          const [a, b] = rebased.collision
          return NextResponse.json(
            {
              error: `Bands ${a.id} and ${b.id} would both price the same ${a.lifeType} under ${data.basis}, so the table could not be quoted. Change or remove one before switching the basis.`,
            },
            { status: 409 }
          )
        }
        if (rebased.kind === "lostRace" || rebased.count === 0) {
          return NextResponse.json({ error: LOST_RACE }, { status: 409 })
        }
      } else {
        const written = await prisma.insuranceRateTable.updateMany({
          where: { id, tenantId: tenant.id, status: "DRAFT" },
          data,
        })
        if (written.count === 0) {
          return NextResponse.json({ error: LOST_RACE }, { status: 409 })
        }
      }

      // `updateMany` returns a count, not the row, so the persisted state is
      // re-read. The audit trail is evidence of what the database holds, and a
      // count is not evidence.
      const updated = await prisma.insuranceRateTable.findFirst({
        where: { id, tenantId: tenant.id },
      })
      if (!updated) {
        return NextResponse.json({ error: LOST_RACE }, { status: 409 })
      }

      await logAudit({
        tenantId: tenant.id,
        userId: guard.user?.id,
        userEmail: guard.user?.email,
        action: AuditAction.INSURANCE_RATE_TABLE_UPDATED,
        entity: "InsuranceRateTable",
        entityId: id,
        oldValue: {
          name: table.name,
          basis: table.basis,
          insurerId: table.insurerId,
          effectiveFrom: table.effectiveFrom,
        },
        // The persisted row, not the parsed input — the audit trail is
        // evidence of what the database holds.
        newValue: updated,
      })

      return NextResponse.json(updated)
    })
  } catch (error) {
    console.error("Failed to update rate table:", error)
    return NextResponse.json({ error: "Failed to update rate table" }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    const { id } = await params

    return await withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const table = await prisma.insuranceRateTable.findFirst({
        where: { id, tenantId: tenant.id },
      })
      if (!table) return NextResponse.json({ error: "Not found" }, { status: 404 })
      if (table.status !== "DRAFT") {
        return NextResponse.json(
          { error: "Only a DRAFT rate table can be deleted. Retire it instead." },
          { status: 409 }
        )
      }

      // Bands cascade (InsuranceRateBand.rateTable has onDelete: Cascade), so
      // this is the most destructive write on the route — hence the status is
      // repeated in the WHERE clause rather than trusted from the read above.
      const removed = await prisma.insuranceRateTable.deleteMany({
        where: { id, tenantId: tenant.id, status: "DRAFT" },
      })
      if (removed.count === 0) {
        return NextResponse.json(
          { error: "This rate table is no longer a DRAFT — it changed while this request was in flight." },
          { status: 409 }
        )
      }

      // A destruction is recorded as one. Filing it under _UPDATED left an
      // auditor filtering on action unable to tell an edit from the row
      // disappearing; the full prior row in oldValue is what it held.
      await logAudit({
        tenantId: tenant.id,
        userId: guard.user?.id,
        userEmail: guard.user?.email,
        action: AuditAction.INSURANCE_RATE_TABLE_DELETED,
        entity: "InsuranceRateTable",
        entityId: id,
        oldValue: {
          productId: table.productId,
          version: table.version,
          name: table.name,
          status: table.status,
        },
        newValue: { deleted: true },
      })

      return NextResponse.json({ ok: true })
    })
  } catch (error) {
    console.error("Failed to delete rate table:", error)
    return NextResponse.json({ error: "Failed to delete rate table" }, { status: 500 })
  }
}
