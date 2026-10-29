import { handleSamlAcs } from "@/lib/sso/flow"

// The SAML assertion consumer service: <NEXTAUTH_URL>/api/auth/sso/saml/acs. The
// identity provider POSTs here cross-site, so proxy.ts exempts it from the
// same-origin write gate; the signed assertion and the browser's flow cookie
// authenticate it (lib/sso/saml.ts).
export async function POST(req: Request) {
  return handleSamlAcs(req)
}
