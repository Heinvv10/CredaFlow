import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { apiError, withApiKey } from "@/lib/lender-api/handler"
import { hasScope } from "@/lib/lender-api/scopes"
import { clientSelect, toApiClient } from "@/lib/lender-api/serializers"

type Params = { params: Promise<{ id: string }> }

export async function GET(req: Request, { params }: Params) {
  return withApiKey(req, "clients:read", async (caller) => {
    const { id } = await params
    const client = await prisma.client.findFirst({ where: { id, tenantId: caller.tenantId }, select: clientSelect })
    if (!client) return apiError(404, "not_found", "No such client.")
    return NextResponse.json(toApiClient(client, { pii: hasScope(caller.scopes, "pii:read") }))
  })
}
