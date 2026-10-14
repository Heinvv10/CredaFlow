import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { withPortalEntity } from "@/lib/asset-finance/portal-route"
import { isCreditLifeElection } from "@/lib/insurance/credit-life-election"
import { recordAssetCreditLifeElection } from "@/lib/asset-finance/nca-credit-life"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withPortalEntity(req, null, async ({ tenantId, client }) => {
    const body = await req.json().catch(() => null) as { election?: unknown } | null
    if (!isCreditLifeElection(body?.election)) return NextResponse.json({ error: "Choose ACCEPTED or DECLINED" }, { status: 400 })
    const election = body.election
    const result = await prisma.$transaction((tx) => recordAssetCreditLifeElection(tx, {
      tenantId, clientId: client.clientId, clientEmail: client.email, dealId: id, election,
    }))
    switch (result.kind) {
      case "not_found": return NextResponse.json({ error: "Not found" }, { status: 404 })
      case "not_open": return NextResponse.json({ error: "The credit-life election is no longer open" }, { status: 409 })
      case "offer_required": return NextResponse.json({ error: "Credit life cannot be accepted because no eligible offer is configured" }, { status: 422 })
      case "entity_decline_required": return NextResponse.json({ error: "Credit life is offered to the entity representative but bundled natural-person cover cannot be accepted for an entity borrower" }, { status: 422 })
      case "recorded": return NextResponse.json(result)
    }
  })
}
