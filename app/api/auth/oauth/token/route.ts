import { handleTokenRequest } from "@/lib/lender-api/oauth/endpoint"

// OAuth2 client-credentials token endpoint for /api/v1 (lib/lender-api/oauth).
export async function POST(req: Request) {
  return handleTokenRequest(req)
}
