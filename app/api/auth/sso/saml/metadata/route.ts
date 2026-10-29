import { handleSamlMetadata } from "@/lib/sso/flow"

// SAML service provider metadata for the lender's identity team to import.
export async function GET(req: Request) {
  return handleSamlMetadata(req)
}
