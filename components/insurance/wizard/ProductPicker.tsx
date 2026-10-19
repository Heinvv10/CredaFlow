import { formatRands } from "@/lib/utils"
import { TYPE_LABELS } from "./constants"
import type { Product } from "./types"

interface Props {
  products: Product[]
  selectedProductId: string
  applyProduct: (p: Product) => void
  useProduct: "catalogue" | "manual"
  setUseProduct: (v: "catalogue" | "manual") => void
}

export function ProductPicker({
  products,
  selectedProductId,
  applyProduct,
  useProduct,
  setUseProduct,
}: Props) {
  const activeProducts = products.filter((p) => p.active)
  if (activeProducts.length === 0) return null

  return (
    <>
      <div className="bg-white rounded-2xl shadow-sm p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">
          Product Source
        </p>
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              [
                "catalogue",
                "From Product Catalogue",
                "Select a pre-configured product — rates auto-fill",
              ],
              [
                "manual",
                "Manual Entry",
                "Enter all fields manually",
              ],
            ] as const
          ).map(([val, title, desc]) => (
            <label
              key={val}
              className={`cursor-pointer p-3 rounded-xl border-2 transition-colors ${
                useProduct === val
                  ? "border-[#4F46E5] bg-amber-50"
                  : "border-gray-200 hover:border-gray-300"
              }`}
            >
              <input
                type="radio"
                name="useProduct"
                value={val}
                checked={useProduct === val}
                onChange={() => setUseProduct(val)}
                className="sr-only"
              />
              <p className="font-semibold text-sm text-[#1b1d24]">{title}</p>
              <p className="text-[11px] text-gray-400 mt-0.5">{desc}</p>
            </label>
          ))}
        </div>
      </div>

      {useProduct === "catalogue" && (
        <div className="bg-white rounded-2xl shadow-sm p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">
            Select Product
          </p>
          <div className="space-y-2">
            {activeProducts.map((p) => (
              <label
                key={p.id}
                className={`flex items-center justify-between p-3 rounded-xl border-2 cursor-pointer transition-colors ${
                  selectedProductId === p.id
                    ? "border-[#4F46E5] bg-amber-50"
                    : "border-gray-100 hover:border-gray-200"
                }`}
              >
                <input
                  type="radio"
                  name="product"
                  value={p.id}
                  checked={selectedProductId === p.id}
                  onChange={() => applyProduct(p)}
                  className="sr-only"
                />
                <div>
                  <p className="font-semibold text-sm text-[#1b1d24]">{p.name}</p>
                  <p className="text-xs text-gray-400">
                    {p.code} · {TYPE_LABELS[p.type] || p.type}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold text-[#4F46E5]">
                    {p.headlineIsFrom ? "From " : ""}{formatRands(p.headlinePremium)}
                    <span className="text-xs font-normal text-gray-400">/mo{p.headlineIsFrom ? " · main member" : ""}</span>
                  </p>
                  <p className="text-xs text-gray-400">Cover: {formatRands(p.sumAssured)}</p>
                </div>
              </label>
            ))}
            {selectedProductId && (
              <div className="mt-3 p-3 bg-amber-50 border border-[#4F46E5]/20 rounded-xl text-xs text-[#4F46E5] font-medium">
                Product selected — premium, sum assured and commission auto-filled below. You
                can still edit.
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
