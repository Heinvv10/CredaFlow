import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { applyLivePricing } from "@/lib/public-loan-products"
import type { WebsiteImageryView } from "@/lib/config/website-imagery"
import { HomePage } from "./HomePage"
import { HERO_WASH } from "./HomeImagery"

const LIVE = (min: number) => ({
  interestRatePm: 3, interestModel: "REDUCING_BALANCE" as const, initiationFeePct: 0.15, initiationFeeMax: 605000,
  monthlyServiceFee: 6900, minAmount: min, maxAmount: 7500000, minTermDays: 90, maxTermDays: 1800,
})
const PRODUCTS = applyLivePricing({ personal: LIVE(200000), "short-term": LIVE(100000) }).filter((p) => p.code === "personal" || p.code === "short-term")

const view = (slot: string, v: string, alt: string) => ({
  src: `/api/website/imagery/${slot}?v=${v}&w=1920`,
  srcSet: `/api/website/imagery/${slot}?v=${v}&w=800 800w, /api/website/imagery/${slot}?v=${v}&w=1920 1920w`,
  alt, width: 1600, height: 900,
})
const IMAGERY: WebsiteImageryView = {
  hero: view("hero", "aaaaaaaaaaaa", "Two people reviewing a loan at a kitchen table"),
  products: { personal: view("product-personal", "bbbbbbbbbbbb", "") },
  community: { ...view("community", "cccccccccccc", "A market street"), heading: "Part of the community", body: "We lend to the people we live next to." },
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
    expect(hero).toContain('src="/api/website/imagery/hero?v=aaaaaaaaaaaa&amp;w=1920"')
    expect(hero).toContain('srcSet="/api/website/imagery/hero?v=aaaaaaaaaaaa&amp;w=800 800w, /api/website/imagery/hero?v=aaaaaaaaaaaa&amp;w=1920 1920w"')
    expect(hero).toContain('sizes="100vw"')
    expect(hero).toContain('alt="Two people reviewing a loan at a kitchen table"')
    expect(hero).toContain('width="1600"')
    expect(hero).toContain('height="900"')
    expect(hero).toContain('fetchPriority="high"')
    expect(hero).not.toContain('loading="lazy"')
    expect(render(IMAGERY)).toContain("bg-[#11141b]/75 xl:hidden")
    expect(render(IMAGERY)).toContain(`rgba(17, 20, 27, ${HERO_WASH.text}) ${HERO_WASH.textUntil}%`)
  })

  it("keeps the hero inside its section so a phone does not scroll sideways", () => {
    const html = render(IMAGERY)
    const hero = html.slice(html.indexOf("<section"), html.indexOf("</section>"))
    expect(hero).toContain("overflow-hidden")
    expect(hero).toContain("absolute inset-0 h-full w-full object-cover")
  })

  it("puts a lazy, decorative (alt=\"\") image with a srcSet on the product card it is keyed to, and none on the others", () => {
    const html = render(IMAGERY)
    const personal = html.slice(html.indexOf("Personal loan") - 900, html.indexOf("Personal loan"))
    expect(personal).toContain('src="/api/website/imagery/product-personal?v=bbbbbbbbbbbb&amp;w=1920"')
    expect(personal).toContain('srcSet="')
    expect(personal).toContain('alt=""')
    expect(personal).toContain('loading="lazy"')
    expect(imgs(html).filter((i) => i.includes("product-short-term"))).toEqual([])
    expect(imgs(html)).toHaveLength(3)
  })

  it("renders the community band, lazy, with its heading and sentence, after the product cards", () => {
    const html = render(IMAGERY)
    const community = imgs(html).find((i) => i.includes("community"))
    expect(community).toContain('alt="A market street"')
    expect(community).toContain('srcSet="')
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


// WCAG relative luminance and contrast for an sRGB channel triple (0-255).
const lum = (rgb: number[]) => {
  const [r, g, b] = rgb.map((c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
const over = (top: number[], alpha: number, under: number[]) => top.map((c, i) => c * alpha + under[i] * (1 - alpha))
const PAGE = [17, 20, 27]
const WHITE = [255, 255, 255]

// The wash's alpha at a point across the viewport, as the CSS gradient interpolates it.
const washAt = (pct: number) => {
  const { edge, text, textUntil, clearAt } = HERO_WASH
  if (pct <= textUntil) return edge + (text - edge) * (pct / textUntil)
  if (pct >= clearAt) return 0
  return text * (1 - (pct - textUntil) / (clearAt - textUntil))
}

describe("the hero wash keeps the body copy readable on the brightest photo", () => {
  // HomePage: a 660px text column in a max-w-7xl (1280px) container with lg:px-8.
  const columnEdgePct = (vw: number) => ((Math.max(0, (vw - 1280) / 2) + 32 + 660) / vw) * 100

  it.each([1280, 1366, 1440, 1536, 1920, 2560])("at the end of a line on a %ipx screen", (vw) => {
    const bg = over(PAGE, washAt(columnEdgePct(vw)), WHITE)
    const copy = over(WHITE, 0.78, bg) // text-white/78
    expect(contrast(copy, bg)).toBeGreaterThanOrEqual(4.5)
  })

  it("on a phone or tablet, where the flat 75% wash sits under all of it", () => {
    const bg = over(PAGE, 0.75, WHITE)
    expect(contrast(over(WHITE, 0.78, bg), bg)).toBeGreaterThanOrEqual(4.5)
  })
})
