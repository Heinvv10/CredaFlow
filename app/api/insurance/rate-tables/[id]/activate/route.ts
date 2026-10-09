import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"
import { lockProductForActivation, lockRateTable } from "../../rate-table-lock"

/**
 * Thrown when the transaction is about to commit a product with anything other
 * than exactly one ACTIVE rate table. Rolls the whole activation back.
 */
class AmbiguousActiveTables extends Error {
  constructor(readonly count: number) {
    super(`Activation would leave ${count} ACTIVE rate tables for this product`)
    this.name = "AmbiguousActiveTables"
  }
}

/**
 * Activate a DRAFT rate table.
 *
 * The retire-and-activate pair runs inside ONE transaction because a product
 * must never have two ACTIVE tables: a quote resolving two rate cards has no
 * defined price, and one resolving none cannot sell at all. Doing it as two
 * statements would leave exactly that window open.
 *
 * The DRAFT status is re-read INSIDE the transaction and repeated in the
 * WHERE clause. The status check before the transaction is a fast, friendly
 * rejection; the one inside is the actual guard, because between the two a
 * concurrent request can have activated the same table already.
 *
 * That re-read is NOT sufficient on its own — it only guards the same table
 * being activated twice. Two DIFFERENT drafts on one product could both reach
 * ACTIVE under READ COMMITTED; see `lockProductForActivation`, which is why
 * the product row is locked first.
 *
 * TWO locks are taken, product then table, and both are needed for different
 * reasons: the product lock serialises activations against each other, and the
 * rate-table lock serialises this activation against BAND WRITES, which lock
 * that row and not the product. Holding only the first left the zero-band
 * refusal racy — see the band re-count inside the transaction. The order is
 * fixed at product→table wherever both are held; see `rate-table-lock.ts`.
 *
 * THE SINGLE-ACTIVE INVARIANT IS ENFORCED IN
 * APPLICATION CODE ONLY: the schema is frozen for this phase, so the partial
 * unique index that would make it structural is deliberately deferred. The
 * post-commit assertion below is the second line of defence — if the count is
 * ever not exactly one, the transaction rolls back rather than shipping a
 * product that cannot be quoted.
 */
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
        select: {
          id: true,
          status: true,
          productId: true,
          version: true,
          _count: { select: { bands: true } },
        },
      })
      if (!table) return NextResponse.json({ error: "Not found" }, { status: 404 })

      if (table.status !== "DRAFT") {
        return NextResponse.json(
          { error: "Only a DRAFT rate table can be activated." },
          { status: 409 }
        )
      }

      // An empty rate card prices nothing, yet it would satisfy every
      // readiness check that only asks whether an ACTIVE table exists. Refuse
      // at the door.
      if (table._count.bands === 0) {
        return NextResponse.json(
          { error: "A rate table with no bands cannot be activated — it would price nothing." },
          { status: 422 }
        )
      }

      // ONE instant for the whole activation. The predecessor's `effectiveTo`
      // and the successor's `effectiveFrom` are the SAME value, which is what
      // makes `activeRateTableFindManyArgs` resolve exactly one table at every
      // point in time: `effectiveTo` is exclusive (gt) and `effectiveFrom`
      // inclusive (lte), so the changeover leaves no gap and no overlap. Two
      // separate `new Date()` calls would leave a sliver in which the product
      // has no rate card at all.
      const now = new Date()

      let result
      try {
        result = await prisma.$transaction(async (tx) => {
          // FIRST statement: serialise every activation for this product.
          //
          // The return value is the answer to "was a lock actually taken".
          // `SELECT … FOR UPDATE` matching no row locks nothing and raises
          // nothing, so discarding it would run the whole activation with its
          // sole serialisation guard silently absent.
          const productLocked = await lockProductForActivation(tx, {
            productId: table.productId,
            tenantId: tenant.id,
          })
          if (!productLocked) return { kind: "gone" } as const

          // SECOND lock, and the order is load-bearing — product before table,
          // everywhere. Band writes serialise on the RATE TABLE row, not the
          // product row, so without this the two locks did not exclude each
          // other at all: a `DELETE .../bands/<last band>` could commit between
          // the band count and the update below, and this transaction would
          // commit an empty card as ACTIVE having already retired the live one.
          const locked = await lockRateTable(tx, { id, tenantId: tenant.id })
          if (!locked) return { kind: "gone" } as const
          if (locked.status !== "DRAFT") return { kind: "raceLost" } as const

          const fresh = await tx.insuranceRateTable.findFirst({
            where: { id, tenantId: tenant.id, status: "DRAFT" },
            select: { id: true, effectiveFrom: true, _count: { select: { bands: true } } },
          })
          // Lost the race: another request already moved this table out of DRAFT.
          if (!fresh) return { kind: "raceLost" } as const

          // The band count re-asserted UNDER THE LOCK. The identical check
          // before the transaction is a fast, friendly rejection; this one is
          // the guard, and it is the reason the table lock is held.
          if (fresh._count.bands === 0) return { kind: "empty" } as const

          const retired = await tx.insuranceRateTable.updateMany({
            where: { tenantId: tenant.id, productId: table.productId, status: "ACTIVE" },
            data: { status: "RETIRED", effectiveTo: now },
          })

          // `effectiveFrom` is stamped, not inherited. The value on the draft
          // is whatever the caller typed at create time — validated only for
          // NaN — and a future date would make this table ACTIVE but NOT in
          // force: `resolveActiveRateTable` filters `effectiveFrom <= at`, so
          // it would retire the live card and resolve nothing in its place,
          // leaving the product NOT_CONFIGURED behind a 200 and an audit row
          // saying it had been activated.
          //
          // Stamping is chosen over refusing a future-dated draft (422) because
          // activation IS the moment cover starts being priced: there is no
          // scheduler that would later pick the table up, so a future date can
          // only ever mean "not in force", never "in force from then". The
          // override is recorded in the audit trail below, so it is not silent.
          const activated = await tx.insuranceRateTable.update({
            where: { id },
            data: { status: "ACTIVE", effectiveFrom: now, effectiveTo: null },
          })

          // Still inside the transaction: prove the invariant actually holds
          // before committing. Nothing in the database enforces it.
          const activeCount = await tx.insuranceRateTable.count({
            where: { tenantId: tenant.id, productId: table.productId, status: "ACTIVE" },
          })
          if (activeCount !== 1) throw new AmbiguousActiveTables(activeCount)

          return {
            kind: "activated" as const,
            activated,
            retiredCount: retired.count,
            bandCount: fresh._count.bands,
            draftEffectiveFrom: fresh.effectiveFrom,
          }
        })
      } catch (err) {
        if (err instanceof AmbiguousActiveTables) {
          console.error("Rolled back rate table activation:", err.message)
          return NextResponse.json(
            {
              error:
                "Activation was rolled back: it would have left this product without exactly one rate card in force. Nothing was changed.",
            },
            { status: 409 }
          )
        }
        throw err
      }

      if (result.kind === "gone") {
        return NextResponse.json({ error: "Not found" }, { status: 404 })
      }
      if (result.kind === "raceLost") {
        return NextResponse.json(
          { error: "This rate table is no longer a DRAFT — it was activated concurrently." },
          { status: 409 }
        )
      }
      if (result.kind === "empty") {
        return NextResponse.json(
          { error: "A rate table with no bands cannot be activated — it would price nothing." },
          { status: 422 }
        )
      }

      await logAudit({
        tenantId: tenant.id,
        userId: guard.user?.id,
        userEmail: guard.user?.email,
        action: AuditAction.INSURANCE_RATE_TABLE_ACTIVATED,
        entity: "InsuranceRateTable",
        entityId: id,
        // The draft's own effectiveFrom is recorded so the stamp below is
        // visible as an override rather than looking like what was asked for.
        oldValue: { status: "DRAFT", effectiveFrom: result.draftEffectiveFrom },
        newValue: {
          status: "ACTIVE",
          productId: table.productId,
          version: table.version,
          bands: result.bandCount,
          effectiveFrom: now,
          retiredPriorTables: result.retiredCount,
        },
      })

      return NextResponse.json(result.activated)
    })
  } catch (error) {
    console.error("Failed to activate rate table:", error)
    return NextResponse.json({ error: "Failed to activate rate table" }, { status: 500 })
  }
}
