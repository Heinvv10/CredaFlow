import { handleOidcCallback } from "@/lib/sso/flow"

// The OIDC redirect URI: <NEXTAUTH_URL>/api/auth/sso/oidc/callback.
export async function GET(req: Request) {
  return handleOidcCallback(req)
}
