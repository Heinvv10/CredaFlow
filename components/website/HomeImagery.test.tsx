import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { applyLivePricing } from "@/lib/public-loan-products"
import type { WebsiteImageryView } from "@/lib/config/website-imagery"
import { HomePage } from "./HomePage"

const LIVE = (min: number) => ({
  interestRatePm: 3, interestModel: "REDUCING_BALANCE" as const, initiationFeePct: 0.15, initiationFeeMax: 605000,
  monthlyServiceFee: 6900, minAmount: min, maxAmount: 7500000, minTermDays: 90, maxTermDays: 1800,
})
const PRODUCTS = applyLivePricing({ personal: LIVE(200000), "short-term": LIVE(100000) }).filter((p) => p.code === "personal" || p.code === "short-term")

const view = (src: string, alt: string) => ({ src, alt, width: 1600, height: 900 })
const IMAGERY: WebsiteImageryView = {
  hero: view("/api/website/imagery/hero?v=aaaaaaaaaaaa", "Two people reviewing a loan at a kitchen table"),
  products: { personal: view("/api/website/imagery/product-personal?v=bbbbbbbbbbbb", "A family at home") },
  community: { ...view("/api/website/imagery/community?v=cccccccccccc", "A market street"), heading: "Part of the community", body: "We lend to the people we live next to." },
}

const render = (imagery?: WebsiteImageryView | null) => renderToStaticMarkup(<HomePage identity={ACME_LENDER} products={PRODUCTS} imagery={imagery} />)
const imgs = (html: string) => html.match(/<img\b[^>]*>/g) ?? []

describe("home page imagery", () => {
  it("renders exactly the page it always did when there is no imagery", () => {
    const before = renderToStaticMarkup(<HomePage identity={ACME_LENDER} products={PRODUCTS} />)
    expect(render(null)).toBe(before)
    expect(render({ products: {} })).toBe(before)
    expect(imgs(before)).toEqual([])
  })

  it("shows the hero photo with its alt text, sized, high priority, behind a dark wash", () => {
    const [hero] = imgs(render(IMAGERY))
    expect(hero).toContain('src="/api/website/imagery/hero?v=aaaaaaaaaaaa"')
    expect(hero).toContain('alt="Two people reviewing a loan at a kitchen table"')
    expect(hero).toContain('width="1600"')
    expect(hero).toContain('height="900"')
    expect(hero).toContain('fetchPriority="high"')
    expect(hero).not.toContain('loading="lazy"')
    expect(render(IMAGERY)).toContain("bg-[#11141b]/80 lg:hidden")
  })

  it("keeps the hero inside its section so a phone does not scroll sideways", () => {
    const html = render(IMAGERY)
    const hero = html.slice(html.indexOf("<section"), html.indexOf("</section>"))
    expect(hero).toContain("overflow-hidden")
    expect(hero).toContain("absolute inset-0 h-full w-full object-cover")
  })

  it("puts a lazy image on the product card it is keyed to, and none on the others", () => {
    const html = render(IMAGERY)
    const personal = html.slice(html.indexOf("Personal loan") - 700, html.indexOf("Personal loan"))
    expect(personal).toContain('src="/api/website/imagery/product-personal?v=bbbbbbbbbbbb"')
    expect(personal).toContain('alt="A family at home"')
    expect(personal).toContain('loading="lazy"')
    expect(imgs(html).filter((i) => i.includes("product-short-term"))).toEqual([])
    expect(imgs(html)).toHaveLength(3)
  })

  it("renders the community band, lazy, with its heading and sentence, after the product cards", () => {
    const html = render(IMAGERY)
    const community = imgs(html).find((i) => i.includes("community"))
    expect(community).toContain('alt="A market street"')
    expect(community).toContain('loading="lazy"')
    expect(html).toContain("Part of the community")
    expect(html).toContain("We lend to the people we live next to.")
    expect(html.indexOf("Part of the community")).toBeGreaterThan(html.indexOf("Personal loan"))
  })

  it("renders the community band only when its image is set", () => {
    const { community: _community, ...without } = IMAGERY
    expect(render(without)).not.toContain("Part of the community")
    expect(imgs(render(without))).toHaveLength(2)
  })
})
