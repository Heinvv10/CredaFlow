"use client"

import { useState } from "react"
import { Calculator, PiggyBank, ArrowLeftRight } from "lucide-react"
import RepaymentTab from "./RepaymentTab"
import AffordabilityTab from "./AffordabilityTab"
import ComparisonTab from "./ComparisonTab"

const TABS = [
  { key: "repayment", label: "Product calculator", icon: Calculator },
  { key: "affordability", label: "Affordability", icon: PiggyBank },
  { key: "comparison", label: "Compare scenarios", icon: ArrowLeftRight },
] as const

type TabKey = (typeof TABS)[number]["key"]

export default function CalculatorTabs() {
  const [active, setActive] = useState<TabKey>("repayment")

  return (
    <div className="premium-calculator">
      <div className="mb-8 flex w-full flex-col gap-1.5 border border-white/10 bg-white/[0.035] p-1.5 shadow-[0_20px_70px_rgba(0,0,0,0.32)] backdrop-blur-xl sm:w-fit sm:flex-row">
        {TABS.map((tab) => {
          const Icon = tab.icon
          const isActive = active === tab.key
          return (
            <button
              key={tab.key}
              onClick={() => setActive(tab.key)}
              className={`inline-flex min-h-11 w-full items-center justify-center gap-2 border px-4 py-2.5 text-sm font-semibold transition-colors sm:w-auto ${
                isActive
                  ? "border-[#a5b4fc] bg-[#a5b4fc] text-[#11141b]"
                  : "border-transparent text-white/60 hover:border-white/12 hover:bg-white/[0.045] hover:text-white"
              }`}
            >
              <Icon size={16} />
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Keep every tab mounted (hidden when inactive) so entered inputs survive
          a tab switch — the old conditional render unmounted and discarded them. */}
      <div className={active === "repayment" ? "" : "hidden"}><RepaymentTab /></div>
      <div className={active === "affordability" ? "" : "hidden"}><AffordabilityTab /></div>
      <div className={active === "comparison" ? "" : "hidden"}><ComparisonTab /></div>
    </div>
  )
}
