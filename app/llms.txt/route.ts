import { findLenderIdentity } from "@/lib/config/identity"
import { getResolvedTenantId } from "@/lib/tenant"
import { getTenantPublicProductsServer } from "@/lib/public-loan-products-server"
import { siteUrl } from "@/lib/seo/metadata"

// Rendered per request: the page prints the request tenant's own identity,
// which a build-time prerender has no tenant to read.
export const dynamic = "force-dynamic"

// Built per request from the tenant's own identity and products; there is no
// constant fallback. Unconfigured, it says so rather than describe anyone.
export async function GET() {
  const identity = await findLenderIdentity(await getResolvedTenantId())
  if (!identity) {
    return new Response("Not configured.\n", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } })
  }
  const products = await getTenantPublicProductsServer()
  const base = siteUrl()

  const body = `# ${identity.tradingName}

> ${identity.brandTagline ?? `${identity.legalName}, a South African credit provider.`}

## Public pages

- Home: ${base}/
- Insurance: ${base}/site/products/insurance
- Loan calculators: ${base}/site/calculators
- Eligibility check: ${base}/site/qualify
- Apply online: ${base}/site/apply
- Contact and complaints: ${base}/site/contact
- Privacy and POPIA: ${base}/site/privacy
- Terms and conditions: ${base}/site/terms
- Regulatory information: ${base}/site/regulatory-information

## Entity facts

- Brand: ${identity.tradingName}
- Legal name: ${identity.legalName}
- NCR registration: ${identity.ncrNumber}
- FSP number: ${identity.fspNumber}
- Country: South Africa
${identity.headOfficeCity ? `- Head office: ${identity.headOfficeCity}\n` : ""}${products.length > 0 ? `- Credit products: ${products.map((p) => p.label).join(", ")}\n` : ""}- Contact: ${identity.publicEmail}
`

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600, s-maxage=86400",
    },
  })
}
