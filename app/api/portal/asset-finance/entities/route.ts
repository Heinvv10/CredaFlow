import { NextRequest, NextResponse } from "next/server"
import { withPortalEntity } from "@/lib/asset-finance/portal-route"
import { loadPortalEntities } from "@/lib/asset-finance/portal-entities"

/** The entities the signed-in client may act for: the portal's entity switcher. */
export async function GET(req: NextRequest) {
  return withPortalEntity(req, null, async ({ tenantId, client }) =>
    NextResponse.json(await loadPortalEntities(tenantId, client.clientId)),
  )
}
