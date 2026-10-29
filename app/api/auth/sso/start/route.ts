import { handleSsoStart } from "@/lib/sso/flow"

// Leave for the lender's identity provider (OIDC or SAML), per lib/sso/flow.ts.
export async function GET(req: Request) {
  return handleSsoStart(req)
}
