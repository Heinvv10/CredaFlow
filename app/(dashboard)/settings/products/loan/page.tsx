import { prisma } from "@/lib/prisma"
import Link from "next/link"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { formatZAR } from "@/lib/utils"
import { getDefaultTenantId } from "@/lib/tenant"
import { requireMinRole } from "@/lib/auth-guards"

const TYPE_LABELS: Record<string, string> = { MICRO: "Micro", PERSONAL: "Personal", PO_FUNDING: "PO Funding" }
const MODEL_LABELS: Record<string, string> = { FLAT: "Flat", REDUCING_BALANCE: "Reducing", DAILY_ACCRUAL: "Daily" }

export default async function LoanProductsPage() {
  // Match the product-mutation API (ADMIN): the page exposes "+ New Product" /
  // "Edit" controls whose backing routes require ADMIN. Without this gate a
  // low-privilege role (e.g. COLLECTIONS_AGENT) sees interest-rate edit buttons
  // it can't action and product config it shouldn't.
  await requireMinRole("ADMIN")
  const tenantId = await getDefaultTenantId()
  const products = await prisma.loanProduct.findMany({ where: { tenantId }, orderBy: { name: "asc" } })

  return (
    <div className="p-6 lg:p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <Breadcrumbs
            className="mb-1"
            items={[
              { label: "Settings", href: "/settings" },
              { label: "Products", href: "/settings/products" },
              { label: "Loan products" },
            ]}
          />
          <h1 className="text-2xl font-bold text-[#1b1d24]">Loan Products</h1>
          <p className="text-sm text-gray-500 mt-1">{products.length} product{products.length !== 1 ? "s" : ""} configured</p>
        </div>
        <Link href="/settings/products/loan/new"
          className="px-4 py-2 bg-[#4F46E5] text-white text-sm font-semibold rounded-lg hover:bg-[#4338CA]">
          + New Product
        </Link>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              <th className="px-5 py-3 text-left">Code</th>
              <th className="px-5 py-3 text-left">Name</th>
              <th className="px-5 py-3 text-left">Type</th>
              <th className="px-5 py-3 text-right">Min</th>
              <th className="px-5 py-3 text-right">Max</th>
              <th className="px-5 py-3 text-center">Interest p/m</th>
              <th className="px-5 py-3 text-center">Model</th>
              <th className="px-5 py-3 text-center">Term (days)</th>
              <th className="px-5 py-3 text-center">Status</th>
              <th className="px-5 py-3 text-center">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {products.map(p => (
              <tr key={p.id} className={`hover:bg-gray-50 ${!p.active ? "opacity-50" : ""}`}>
                <td className="px-5 py-3 font-mono text-xs text-[#4F46E5]">{p.code}</td>
                <td className="px-5 py-3 font-semibold text-[#1b1d24]">{p.name}</td>
                <td className="px-5 py-3 text-gray-600">{TYPE_LABELS[p.productType] || p.productType}</td>
                <td className="px-5 py-3 text-right tabular-nums">{formatZAR(p.minAmount)}</td>
                <td className="px-5 py-3 text-right tabular-nums">{formatZAR(p.maxAmount)}</td>
                <td className="px-5 py-3 text-center">
                  {(p.interestRatePm * 100).toFixed(1)}%
                  <span className="text-[10px] text-gray-400 ml-0.5">p/m</span>
                </td>
                <td className="px-5 py-3 text-center text-gray-500">{MODEL_LABELS[p.interestModel] || p.interestModel}</td>
                <td className="px-5 py-3 text-center">{p.minTermDays}–{p.maxTermDays}</td>
                <td className="px-5 py-3 text-center">
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${p.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                    {p.active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-5 py-3 text-center">
                  <Link href={`/settings/products/loan/${p.id}`}
                    className="text-[#4F46E5] hover:underline text-xs font-medium">
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
            {products.length === 0 && (
              <tr>
                <td colSpan={10} className="text-center py-12 text-gray-400">
                  No loan products yet.{" "}
                  <Link href="/settings/products/loan/new" className="text-[#4F46E5] hover:underline">Create the first one →</Link>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
