import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { apiError, withApiKey } from "@/lib/lender-api/handler"
import { hasScope } from "@/lib/lender-api/scopes"
import { applicationSelect, toApiApplication } from "@/lib/lender-api/serializers"

type Params = { params: Promise<{ id: string }> }

export async function GET(req: Request, { params }: Params) {
  return withApiKey(req, "applications:read", async (caller) => {
    const { id } = await params
    const application = await prisma.loanApplication.findFirst({ where: { id, tenantId: caller.tenantId }, select: applicationSelect })
    if (!application) return apiError(404, "not_found", "No such application.")
    return NextResponse.json(toApiApplication(application, { pii: hasScope(caller.scopes, "pii:read") }))
  })
}
