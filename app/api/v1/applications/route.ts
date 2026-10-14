import { NextResponse } from "next/server"
import type { AppStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { apiError, withApiKey } from "@/lib/lender-api/handler"
import { optionalEnumParam, optionalIdParam, pageOf, pageQuery, parsePageParams } from "@/lib/lender-api/pagination"
import { applicationSelect, toApiApplication } from "@/lib/lender-api/serializers"
import { createDraftApplication, parseCreateApplication } from "@/lib/lender-api/create-application"

const APPLICATION_STATUSES: readonly AppStatus[] = [
  "DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "DECLINED", "DISBURSED", "CANCELLED",
]

export async function GET(req: Request) {
  return withApiKey(req, "applications:read", async (caller) => {
    const url = new URL(req.url)
    const page = parsePageParams(url)
    if (page instanceof Response) return page
    const status = optionalEnumParam(url, "status", APPLICATION_STATUSES)
    if (status instanceof Response) return status
    const clientId = optionalIdParam(url, "clientId")
    if (clientId instanceof Response) return clientId
    const rows = await prisma.loanApplication.findMany({
      where: { tenantId: caller.tenantId, ...(status ? { status } : {}), ...(clientId ? { clientId } : {}) },
      select: applicationSelect,
      ...pageQuery(page),
    })
    return NextResponse.json(pageOf(rows, page, toApiApplication))
  })
}

export async function POST(req: Request) {
  return withApiKey(req, "applications:write", async (caller) => {
    const body: unknown = await req.json().catch(() => undefined)
    if (body === undefined) return apiError(400, "invalid_body", "Send a JSON body.")
    const input = parseCreateApplication(body)
    if ("status" in input) return NextResponse.json(input.body, { status: input.status })
    const outcome = await createDraftApplication(caller, input)
    return NextResponse.json(outcome.body, { status: outcome.status })
  })
}
