import { NextResponse } from "next/server"
import { buildOpenApiDocument } from "@/lib/lender-api/openapi"

// Public: the contract carries no lender data.
export async function GET() {
  return NextResponse.json(buildOpenApiDocument(), { headers: { "Cache-Control": "public, max-age=300" } })
}
