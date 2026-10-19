import { NextRequest, NextResponse } from "next/server"
import { deactivateDealerUser } from "@/lib/dealer/users"
import { refusalResponse, withDealerStaff } from "@/lib/dealer/staff-route"

/** Deactivates a dealer user and ends its sessions (manage_dealers). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; userId: string }> }) {
  return withDealerStaff(req, "manage_dealers", async ({ staff }) => {
    const { id, userId } = await params
    const result = await deactivateDealerUser({ kind: "staff", staff }, id, userId)
    return result.kind === "refused" ? refusalResponse(result) : NextResponse.json(result)
  })
}
