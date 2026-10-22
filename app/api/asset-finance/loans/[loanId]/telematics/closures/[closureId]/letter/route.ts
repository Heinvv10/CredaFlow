import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { readFile } from "@/lib/storage"
import { logDocumentAccess } from "@/lib/document-auth"
import { withTelematicsStaff } from "@/lib/telematics/route"

type Params = { params: Promise<{ loanId: string; closureId: string }> }

/**
 * The stored "tracking stopped" letter of a closed loan's tracker (work_telematics_alerts: the tracker work queue).
 * Each view is on the document access register (POPIA), written before the bytes are read.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { loanId, closureId } = await params
  return withTelematicsStaff(req, "work_telematics_alerts", async (actor) => {
    const closure = await prisma.trackerClosure.findFirst({
      where: { id: closureId, loanId, tenantId: actor.tenantId }, select: { letterStoragePath: true, loan: { select: { reference: true } } },
    })
    if (!closure?.letterStoragePath) return NextResponse.json({ error: "Letter not found" }, { status: 404 })
    await logDocumentAccess(prisma, { documentId: closureId, accessorType: "staff", accessorId: actor.userId, action: "view", req })
    const bytes = await readFile(closure.letterStoragePath)
    return new NextResponse(new Uint8Array(bytes), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="tracking-stopped-${closure.loan.reference}.pdf"`, "Cache-Control": "no-store" },
    })
  })
}
