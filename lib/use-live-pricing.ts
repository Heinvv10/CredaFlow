"use client"

import { useEffect, useState } from "react"
import type { LivePricing, PublicLoanProductCode } from "@/lib/public-loan-products"

export type LivePricingByCode = Partial<Record<PublicLoanProductCode, LivePricing>>

// Fetch the LIVE per-product fee structure + amount/term ranges the admin set at
// /settings/products/loan (see app/api/website/loan-pricing/route.ts), keyed by
// public product code. Pure + fail-open so it can be unit-tested and reused:
// ANY failure (network, non-2xx, malformed body) resolves to {}, which callers
// overlay onto the static catalogue via applyLivePricing — a dead API just means
// the static snapshot renders, never a blank or crashed public page.
export async function fetchLivePricing(): Promise<LivePricingByCode> {
  try {
    const res = await fetch("/api/website/loan-pricing")
    if (!res.ok) return {}
    const data = (await res.json()) as { pricing?: LivePricingByCode } | null
    return data?.pricing ?? {}
  } catch {
    return {}
  }
}

// Shared live-pricing hook for the public CLIENT surfaces (calculator, apply
// form, qualify wizard) so all three read ONE path and can never drift from each
// other. Returns {} until the fetch resolves and on any error (fail-open); pass
// `pricing` straight into applyLivePricing(). `loading` is exposed for callers
// that want to defer a first paint, but the static catalogue renders first so
// none of them need to.
export function useLivePricing(): { pricing: LivePricingByCode; loading: boolean } {
  const [pricing, setPricing] = useState<LivePricingByCode>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void fetchLivePricing()
      .then((next) => {
        if (!cancelled) setPricing(next)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { pricing, loading }
}
