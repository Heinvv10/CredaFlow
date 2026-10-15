"use client"

import { BarChart3 } from "lucide-react"
import { ProductLoanCalculator } from "@/components/website/ProductLoanCalculator"
import { useT } from "@/lib/i18n/client"

export function HomeLoanCalculatorCard() {
  const t = useT("websiteHome")
  return (
    <div className="border border-white/16 bg-[#11141b]/70 p-4 shadow-[0_28px_100px_rgba(0,0,0,0.42)] backdrop-blur-md sm:p-6">
      <div className="flex items-center justify-between border-b border-white/12 pb-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#a5b4fc]">{t("loanCalculator")}</p>
          <h3 className="mt-2 text-2xl font-semibold text-white">{t("calcCardHeading")}</h3>
        </div>
        <BarChart3 className="h-6 w-6 text-[#a5b4fc]" />
      </div>
      <div className="mt-5">
        <ProductLoanCalculator variant="compact" defaultProduct="short-term" />
      </div>
    </div>
  )
}
