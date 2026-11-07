import type { ImageView, WebsiteImageryView } from "@/lib/config/website-imagery"

// The lender's own photos on the home page (lib/config/website-imagery.ts). Each
// piece renders only when its slot is set; with none set HomePage renders the
// markup it had before there were any.

/**
 * The wash behind the hero's text. It darkens only where the copy sits so the photo
 * shows at full strength on the right. Below `xl` the text column spans most of the
 * width, so the whole photo takes the `text` alpha. From `xl` the column (660px in a
 * 1280px container with 32px padding) ends at no more than 54.1% of the viewport, so
 * the wash holds `text` to `textUntil`% and is clear from `clearAt`%.
 * HomeImagery.test.tsx checks the body copy against a pure-white photo at the column's
 * right edge across desktop widths.
 */
export const HERO_WASH = { edge: 0.92, text: 0.75, textUntil: 56, clearAt: 88 } as const
const WASH = "17, 20, 27" // #11141b, the page background

const sideWash = `linear-gradient(to right, rgba(${WASH}, ${HERO_WASH.edge}) 0%, rgba(${WASH}, ${HERO_WASH.text}) ${HERO_WASH.textUntil}%, rgba(${WASH}, 0) ${HERO_WASH.clearAt}%)`

export function HeroImage({ image }: { image: ImageView }) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- a per-tenant API response, not a static asset */}
      <img src={image.src} srcSet={image.srcSet} sizes="100vw" alt={image.alt} width={image.width} height={image.height} fetchPriority="high" decoding="async" className="absolute inset-0 h-full w-full object-cover object-[72%_50%] xl:object-center" />
      <div className="absolute inset-0 bg-[#11141b]/75 xl:hidden" />
      <div className="absolute inset-0 hidden xl:block" style={{ backgroundImage: sideWash }} />
    </>
  )
}

/**
 * The top of a product card, running out to the card's border (the card has p-5).
 * Decorative when the lender wrote no alt text: the image sits inside the card's
 * link beside its title, so a screen reader needs nothing more than the title.
 */
export function ProductCardImage({ image }: { image: ImageView }) {
  return (
    <div className="-mx-5 -mt-5 mb-4 aspect-[16/9] overflow-hidden">
      {/* eslint-disable-next-line @next/next/no-img-element -- a per-tenant API response, not a static asset */}
      <img src={image.src} srcSet={image.srcSet} sizes="(min-width: 1024px) 416px, (min-width: 768px) 50vw, 100vw" alt={image.alt} width={image.width} height={image.height} loading="lazy" decoding="async" className="h-full w-full object-cover" />
    </div>
  )
}

export function CommunityBand({ community }: { community: NonNullable<WebsiteImageryView["community"]> }) {
  return (
    <section className="border-t border-white/10 bg-[#11141b] px-4 py-12 sm:px-6 md:py-16 lg:px-8">
      <div className="mx-auto grid max-w-7xl items-center gap-8 lg:grid-cols-2 lg:gap-12">
        <div className="aspect-[3/2] overflow-hidden border border-white/12">
          {/* eslint-disable-next-line @next/next/no-img-element -- a per-tenant API response, not a static asset */}
          <img src={community.src} srcSet={community.srcSet} sizes="(min-width: 1024px) 614px, 100vw" alt={community.alt} width={community.width} height={community.height} loading="lazy" decoding="async" className="h-full w-full object-cover" />
        </div>
        <div>
          <h2 className="text-balance text-3xl font-semibold leading-tight tracking-normal text-white sm:text-4xl">{community.heading}</h2>
          <p className="mt-5 max-w-xl text-base leading-7 text-white/72 md:text-lg md:leading-8">{community.body}</p>
        </div>
      </div>
    </section>
  )
}
