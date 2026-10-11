import Link from "next/link"
import type { PrismaClient } from "@prisma/client"
import { requireMinRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { getResolvedTenantId } from "@/lib/tenant"
import { canSellProduct } from "@/lib/insurance/product-readiness"
import { ImsModuleToggle } from "@/components/settings/ImsModuleToggle"
import { Header } from "@/components/layout/Header"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

// Deliberately NOT under app/(dashboard)/insurance/layout.tsx: that layout
// redirects when featureIms is off, and this page is how the flag gets turned
// on in the first place.

export const metadata = {
  title: "Insurance Module — Settings",
}

// Reads correctly whether or not anything is sellable. The previous wording —
// "see why its products are not yet sellable" — presupposed failure, so it was
// wrong on exactly the screen an operator reaches once configuration is done.
const SUBTITLE =
  "Switch the insurance (IMS) module on or off, and check whether each product is ready to sell."

const TYPE_LABELS: Record<string, string> = {
  FUNERAL_COVER: "Funeral Cover",
  LIFE_INSURANCE: "Life Insurance",
}

export default async function InsuranceModuleSettingsPage() {
  // Same gate as the credit-policy screen: a tenant-wide feature switch is ADMIN.
  await requireMinRole("ADMIN")
  const tenantId = await getResolvedTenantId()

  const [config, products] = await Promise.all([
    prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: { featureIms: true },
    }),
    prisma.insuranceProduct.findMany({
      where: { tenantId, type: { in: ["FUNERAL_COVER", "LIFE_INSURANCE"] } },
      orderBy: { name: "asc" },
      select: { id: true, code: true, name: true, type: true, active: true },
    }),
  ])

  // One instant for the whole screen, so two products are never screened
  // against different "now"s.
  const at = new Date()
  // `prisma` is a $extends client; its generic delegate signatures are not
  // assignable to the plain `PrismaClient` delegates the readiness reader is
  // typed against. Runtime shape is identical — this is a variance cast only.
  const readinessReader = prisma as unknown as PrismaClient
  const readiness = await Promise.all(
    products.map(async (product) => ({
      product,
      result: await canSellProduct(readinessReader, { tenantId, productId: product.id, at }),
    })),
  )
  const sellableCount = readiness.filter((r) => r.result.sellable).length

  return (
    <>
      <Header
        title="Insurance Module"
        subtitle={SUBTITLE}
        breadcrumbs={[
          { label: "Settings", href: "/settings" },
          { label: "Insurance Module" },
        ]}
      />
      <div className="p-4 lg:p-8 max-w-4xl space-y-6">
        <ImsModuleToggle featureIms={config?.featureIms ?? false} />

        <Card>
          <CardHeader>
            <CardTitle>Product readiness</CardTitle>
            <CardDescription>
              {/*
                The space after </strong> is an explicit {" "} expression, not a
                literal space. A literal one is dropped by the JSX transform here
                and the sentence renders as "does notmake anything sellable" —
                observed in a real browser even though the source read
                `</strong> make` with the space present. Nothing in the test suite catches it: the component
                tests assert on text extracted from the rendered tree, which
                normalises whitespace away.
              */}
              Switching the module on does <strong>not</strong>{" "}
              make anything sellable. Every quote
              and sale is checked separately against the product&apos;s configuration, and that check
              fails until real insurer terms — a rate table in force with rates in it, and the
              mandatory eligibility rules — have been captured for the product.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {products.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No funeral or life products are configured for this tenant, so there is nothing to
                sell. Add them under Settings → Products → Insurance products.
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  {sellableCount} of {products.length} product{products.length === 1 ? "" : "s"} can
                  currently be sold.
                </p>
                <ul className="space-y-3">
                  {readiness.map(({ product, result }) => (
                    <li key={product.id} className="rounded-md border p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold">{product.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {product.code} · {TYPE_LABELS[product.type] ?? product.type}
                            {product.active ? "" : " · inactive"}
                          </p>
                        </div>
                        <span
                          className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                            result.sellable
                              ? "bg-green-100 text-green-700"
                              : "bg-amber-100 text-amber-800"
                          }`}
                        >
                          {result.sellable ? "Sellable" : "Not sellable"}
                        </span>
                      </div>
                      {result.reasons.length > 0 && (
                        <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground space-y-1">
                          {result.reasons.map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      )}
                      {/* Every reason above is fixed on one of these two screens. */}
                      <div className="mt-2 flex gap-4 text-xs">
                        <Link
                          href={`/settings/products/insurance/${product.id}/rates`}
                          className="text-[#4F46E5] hover:underline font-medium"
                        >
                          Rate card
                        </Link>
                        <Link
                          href={`/settings/products/insurance/${product.id}/eligibility`}
                          className="text-[#4F46E5] hover:underline font-medium"
                        >
                          Eligibility rules
                        </Link>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
