import Link from "next/link"
import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { requireMinRole } from "@/lib/auth-guards"
import { hasMinRole } from "@/lib/permissions"
import { resolveFeatureFlags } from "@/lib/tenant"
import { getStaffTenantId } from "@/lib/session-tenant"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"

/**
 * What the two configuration screens (rates, eligibility) both need before they
 * can render: the gate, the tenant, the product, and whether the IMS API they
 * talk to is switched on at all.
 *
 * THE ROLE GATE MATCHES THE API, not the product-edit page above it. The eight
 * routes these screens call are `requireApiRole("READONLY")` to read and
 * `requireApiRole("INSURANCE_OFFICER")` to write; gating the page at ADMIN
 * would lock out exactly the role whose job this is, and gating it lower than
 * the API would hand a user a form that 403s on save. `canWrite` carries the
 * write half down to the client component, which hides the controls the server
 * would refuse.
 */
export async function loadInsuranceConfigContext(id: string) {
  const user = await requireMinRole("READONLY")
  const tenantId = await getStaffTenantId()

  const [product, config] = await Promise.all([
    prisma.insuranceProduct.findFirst({
      where: { id, tenantId },
      select: { id: true, name: true, code: true, type: true },
    }),
    prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: { featureCrm: true, featureIms: true },
    }),
  ])
  if (!product) notFound()

  return {
    product,
    canWrite: hasMinRole(user.role, "INSURANCE_OFFICER"),
    featureIms: resolveFeatureFlags(config).featureIms,
  }
}

export function ConfigPageFrame({
  product,
  section,
  featureIms,
  children,
}: {
  product: { id: string; name: string; code: string }
  section: string
  featureIms: boolean
  children: React.ReactNode
}) {
  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div>
        <Breadcrumbs
          className="mb-1"
          items={[
            { label: "Settings", href: "/settings" },
            { label: "Products", href: "/settings/products" },
            { label: "Insurance products", href: "/settings/products/insurance" },
            { label: product.name, href: `/settings/products/insurance/${product.id}` },
            { label: section },
          ]}
        />
        <h1 className="text-2xl font-bold text-[#1b1d24]">{`${section} — ${product.name}`}</h1>
        <p className="text-sm text-gray-500 mt-1">{product.code}</p>
      </div>

      {/*
        Not a redirect. This page is reachable with the flag off ON PURPOSE, the
        same way Settings → Insurance Module is: it is where the configuration
        that makes the module worth switching on gets entered, and a redirect
        would leave an operator with no way to see why nothing loads. Every
        route it calls answers 404 while the flag is off, so the reason is
        stated here rather than surfacing as eight unexplained failures.
      */}
      {!featureIms && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">The insurance module is switched off for this tenant.</p>
          <p className="mt-1">
            {"Nothing on this screen can load or save while it is off — the insurance API answers 404. Switch it on under "}
            <Link href="/settings/insurance" className="underline font-medium">
              Settings → Insurance Module
            </Link>
            {"."}
          </p>
        </div>
      )}

      {children}
    </div>
  )
}
