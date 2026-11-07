"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { WebsiteImageSlot } from "@/components/settings/WebsiteImageSlot"
import { PRODUCT_SLUGS, getSlotImage, type ImagerySlot, type WebsiteImagery } from "@/lib/config/website-imagery-schema"

const PRODUCT_TITLES: Record<(typeof PRODUCT_SLUGS)[number], string> = {
  "short-term": "Short-term loan",
  personal: "Personal loan",
  "purchase-order": "Purchase order funding",
  "invoice-discounting": "Invoice discounting",
}

const SLOTS: { slot: ImagerySlot; title: string; hint: string }[] = [
  { slot: "hero", title: "Home page hero", hint: "The large photo behind the home page headline. A dark wash keeps the white text readable; landscape, at least 1600 px wide, works best." },
  ...PRODUCT_SLUGS.map((slug) => ({
    slot: `product-${slug}` as const,
    title: `${PRODUCT_TITLES[slug]} card`,
    hint: "Shown at the top of this product's card under “What do you need today?”. Optional; a card without one stays as it is.",
  })),
  { slot: "community", title: "Community band", hint: "A band below the product cards with one photo, a heading and a sentence. Shown only when it is set." },
]

// The photos on the public home page. ADMIN only, like the letterhead logo (the server enforces it).
export function WebsiteImageryManager() {
  const [imagery, setImagery] = useState<WebsiteImagery | null>(null)
  const [offered, setOffered] = useState<readonly string[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/website-imagery", { cache: "no-store" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Failed to load the website images.")
      setImagery(data.imagery ?? {})
      setOffered(data.offeredProducts ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the website images.")
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch of server state
    void load()
  }, [load])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Website images</CardTitle>
        <CardDescription>
          Photos for the public website&apos;s home page, shown only for the products you offer. The hero and community photo need alt text. Without any, the page looks as it always has. A removed photo disappears from the site within a day.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {imagery && SLOTS.map(({ slot, title, hint }) => {
          const image = getSlotImage(imagery, slot)
          // A product card exists on the site only for a product the lender offers; keep one that already has an image so it can be removed.
          if (slot.startsWith("product-") && !image && !offered.includes(slot.slice("product-".length))) return null
          return <WebsiteImageSlot key={`${slot}:${image?.sha256 ?? "none"}:${image?.alt ?? ""}`} slot={slot} title={title} hint={hint} image={image} onChanged={load} />
        })}
      </CardContent>
    </Card>
  )
}
