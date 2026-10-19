import { prisma } from "@/lib/prisma"
import Link from "next/link"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { formatZAR } from "@/lib/utils"
import { loadHeadlines, type Headline } from "@/lib/insurance/headline-premium"
import { getStaffTenantId } from "@/lib/session-tenant"
import { requireMinRole } from "@/lib/auth-guards"

const TYPE_LABELS: Record<string, string> = {
  FUNERAL_COVER: "Funeral Cover", CREDIT_LIFE: "Credit Life", LIFE_INSURANCE: "Life Insurance",
  SHORT_TERM_MOTOR: "Motor", SHORT_TERM_HOME: "Home", SHORT_TERM_CONTENTS: "Contents", BUSINESS_INSURANCE: "Business"
}

function QuoteHint({ headline }: { headline: Headline | undefined }) {
  if (headline?.kind === "from") {
    return (
      <p className="text-[10px] font-normal text-gray-400">
        Quotes from {formatZAR(headline.premiumCents)} (main member, {formatZAR(headline.coverCents)})
      </p>
    )
  }
  if (headline?.kind === "quote") return <p className="text-[10px] font-normal text-gray-400">Price on quote</p>
  return null
}

export default async function InsuranceProductsPage() {
  // Mirror the loan-products gate: product mutations are ADMIN.
  await requireMinRole("ADMIN")
  // The session's tenant, as the [id] edit page reads it: a local
  // header-reading variant (no status check, silent tenant-slug default) could
  // list one tenant's products and then 404 on opening one.
  const tenantId = await getStaffTenantId()
  const products = await prisma.insuranceProduct.findMany({
    where: { tenantId },
    orderBy: { name: "asc" },
  })
  const headlines = await loadHeadlines(prisma, tenantId, products.map((p) => p.id))

  return (
    <div className="p-6 lg:p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <Breadcrumbs
            className="mb-1"
            items={[
              { label: "Settings", href: "/settings" },
              { label: "Products", href: "/settings/products" },
              { label: "Insurance products" },
            ]}
          />
          <h1 className="text-2xl font-bold text-[#1b1d24]">Insurance Products</h1>
          <p className="text-sm text-gray-500 mt-1">{products.length} product{products.length !== 1 ? "s" : ""} configured</p>
        </div>
        <Link href="/settings/products/insurance/new"
          className="px-4 py-2 bg-[#4F46E5] text-white text-sm font-semibold rounded-lg hover:bg-[#4338CA]">
          + New Product
        </Link>
      </div>

      <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              <th className="px-5 py-3 text-left">Code</th>
              <th className="px-5 py-3 text-left">Name</th>
              <th className="px-5 py-3 text-left">Type</th>
              <th className="px-5 py-3 text-right">Premium/mo</th>
              <th className="px-5 py-3 text-right">Sum Assured</th>
              <th className="px-5 py-3 text-center">Commission</th>
              <th className="px-5 py-3 text-center">Status</th>
              <th className="px-5 py-3 text-center">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {products.map(p => (
              <tr key={p.id} className={`hover:bg-gray-50 ${!p.active ? "opacity-50" : ""}`}>
                <td className="px-5 py-3 font-mono text-xs text-[#4F46E5]">{p.code}</td>
                <td className="px-5 py-3 font-semibold text-[#1b1d24]">{p.name}</td>
                <td className="px-5 py-3 text-gray-600">{TYPE_LABELS[p.type] || p.type}</td>
                <td className="px-5 py-3 text-right tabular-nums">{formatZAR(Number(p.premiumAmount) * 100)}
                  <QuoteHint headline={headlines.get(p.id)} />
                </td>
                <td className="px-5 py-3 text-right tabular-nums">{formatZAR(Number(p.sumAssured) * 100)}</td>
                <td className="px-5 py-3 text-center">{(Number(p.commissionRate) * 100).toFixed(1)}%</td>
                <td className="px-5 py-3 text-center">
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${p.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                    {p.active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-5 py-3 text-center">
                  <Link href={`/settings/products/insurance/${p.id}`}
                    className="text-[#4F46E5] hover:underline text-xs font-medium">Edit</Link>
                </td>
              </tr>
            ))}
            {products.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center py-12 text-gray-400">
                  No insurance products yet.{" "}
                  <Link href="/settings/products/insurance/new" className="text-[#4F46E5] hover:underline">Create the first one →</Link>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
