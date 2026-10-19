import { NextRequest } from "next/server"
import { withDealer } from "@/lib/dealer/guards"
import { serveDealerDocument } from "@/lib/dealer/documents"

type Params = { params: Promise<{ id: string; docId: string }> }

/** One document this dealer's users uploaded on its own deal; the access is logged first (DocumentAccessLog, accessor 'dealer'). */
export async function GET(req: NextRequest, { params }: Params) {
  return withDealer(req, {}, async (actor) => {
    const { id, docId } = await params
    return serveDealerDocument(req, actor, id, docId)
  })
}
