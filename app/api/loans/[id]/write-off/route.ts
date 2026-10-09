import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { logAudit, AuditAction } from "@/lib/audit"
import { withTenantContext } from "@/lib/tenant"

interface WriteOffBody {
  action: "request" | "approve" | "reject"
  reason?: string
  confirm?: boolean
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("LOAN_ADMIN")
    if (guard.error) return guard.error

    return withTenantContext(req, async (tenant) => {
      const { id } = await ctx.params
      const body: WriteOffBody = await req.json()

      const loan = await prisma.loan.findUnique({
        where: { id, tenantId: tenant.id },
        select: {
          id: true,
          status: true,
          outstandingPrincipal: true,
          reference: true,
          writeOffRequestedById: true,
          writeOffReason: true,
          writeOffRequestedAt: true,
          daysInArrears: true,
        },
      })

      if (!loan) return NextResponse.json({ error: "Loan not found" }, { status: 404 })

      // ── Step 1: Request write-off ───────────────────────────────────────────
      if (body.action === "request") {
        if (!body.reason?.trim()) {
          return NextResponse.json({ error: "Write-off reason required" }, { status: 422 })
        }
        if (loan.status === "WRITTEN_OFF" || loan.status === "PENDING_WRITE_OFF") {
          return NextResponse.json({ error: "Write-off already in progress" }, { status: 409 })
        }

        // Guard against the read-then-write race: a concurrent request (or
        // an approve/reject racing a second request) could move status
        // between the findUnique above and this write.
        const result = await prisma.loan.updateMany({
          where: { id, tenantId: tenant.id, status: { notIn: ["WRITTEN_OFF", "PENDING_WRITE_OFF"] } },
          data: {
            status: "PENDING_WRITE_OFF",
            writeOffReason: body.reason,
            writeOffRequestedById: guard.user.id,
            writeOffRequestedAt: new Date(),
          },
        })
        if (result.count === 0) {
          return NextResponse.json({ error: "Write-off already in progress" }, { status: 409 })
        }

        await logAudit({
          tenantId: tenant.id,
          action: AuditAction.LOAN_STATUS_CHANGED,
          entity: "Loan",
          entityId: id,
          userId: guard.user.id,
          newValue: { step: "requested", reason: body.reason, requestedBy: guard.user.email },
        }).catch((e) => console.error("Audit log failed (write-off request):", e))

        return NextResponse.json({ ok: true, id, status: "PENDING_WRITE_OFF" })
      }

      // ── Step 2: Approve write-off ───────────────────────────────────────────
      if (body.action === "approve") {
        if (!body.confirm) {
          return NextResponse.json({ error: "Confirmation required" }, { status: 422 })
        }
        if (loan.status !== "PENDING_WRITE_OFF") {
          return NextResponse.json(
            { error: "Loan is not pending write-off approval" },
            { status: 409 }
          )
        }
        if (loan.writeOffRequestedById === guard.user.id) {
          return NextResponse.json(
            { error: "The approver must be a different officer than the requester" },
            { status: 422 }
          )
        }

        // Guard against the read-then-write race: a concurrent approve or
        // reject on the same loan could both pass the status check above.
        // `updateMany` with `status: "PENDING_WRITE_OFF"` in the where
        // clause atomically refuses the write if the row has already moved
        // — only the first caller succeeds, and only a real success logs.
        // Pinning `writeOffRequestedAt` too stops this landing on a
        // *different* write-off episode than the one just validated/audited
        // above (a reject followed by a fresh request, both racing this
        // approve).
        const result = await prisma.loan.updateMany({
          where: { id, tenantId: tenant.id, status: "PENDING_WRITE_OFF", writeOffRequestedAt: loan.writeOffRequestedAt },
          data: {
            status: "WRITTEN_OFF",
            collectionsStage: "WRITTEN_OFF",
            collectionsStageUpdatedAt: new Date(),
            writeOffApprovedById: guard.user.id,
            writeOffAt: new Date(),
          },
        })
        if (result.count === 0) {
          return NextResponse.json(
            { error: "Loan status changed before the write-off could be approved; refresh and try again." },
            { status: 409 }
          )
        }

        await logAudit({
          tenantId: tenant.id,
          action: AuditAction.LOAN_STATUS_CHANGED,
          entity: "Loan",
          entityId: id,
          userId: guard.user.id,
          newValue: {
            step: "approved",
            previousOutstanding: loan.outstandingPrincipal,
            reason: loan.writeOffReason,
            approvedBy: guard.user.email,
          },
        }).catch((e) => console.error("Audit log failed (write-off approve):", e))

        return NextResponse.json({ ok: true, id, status: "WRITTEN_OFF" })
      }

      // ── Step 2b: Reject write-off ────────────────────────────────────────────
      if (body.action === "reject") {
        if (!body.reason?.trim()) {
          return NextResponse.json({ error: "Rejection reason required" }, { status: 422 })
        }
        if (loan.status !== "PENDING_WRITE_OFF") {
          return NextResponse.json(
            { error: "Loan is not pending write-off approval" },
            { status: 409 }
          )
        }
        if (loan.writeOffRequestedById === guard.user.id) {
          return NextResponse.json(
            { error: "The approver must be a different officer than the requester" },
            { status: 422 }
          )
        }

        // Same atomic guard (including the episode pin) as approve above — see comment there.
        const revertStatus = loan.daysInArrears >= 90 ? "DEFAULTED" : "ACTIVE"
        const result = await prisma.loan.updateMany({
          where: { id, tenantId: tenant.id, status: "PENDING_WRITE_OFF", writeOffRequestedAt: loan.writeOffRequestedAt },
          data: {
            status: revertStatus,
            writeOffReason: null,
            writeOffRequestedById: null,
            writeOffRequestedAt: null,
          },
        })
        if (result.count === 0) {
          return NextResponse.json(
            { error: "Loan status changed before the write-off could be rejected; refresh and try again." },
            { status: 409 }
          )
        }

        await logAudit({
          tenantId: tenant.id,
          action: AuditAction.LOAN_STATUS_CHANGED,
          entity: "Loan",
          entityId: id,
          userId: guard.user.id,
          newValue: {
            step: "rejected",
            reason: body.reason,
            rejectedBy: guard.user.email,
            originalReason: loan.writeOffReason,
          },
        }).catch((e) => console.error("Audit log failed (write-off reject):", e))

        return NextResponse.json({ ok: true, id, status: revertStatus })
      }

      return NextResponse.json({ error: "Invalid action" }, { status: 400 })
    })
  } catch (err) {
    console.error("Write-off failed:", err)
    return NextResponse.json({ error: "Failed to process write-off" }, { status: 500 })
  }
}
