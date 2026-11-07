import type { ImageView, WebsiteImageryView } from "@/lib/config/website-imagery"

// The lender's own photos on the home page (lib/config/website-imagery.ts). Each
// piece renders only when its slot is set; with none set HomePage renders the
// markup it had before there were any.

/**
 * Behind the hero's text. The wash darkens only where the copy sits so the photo
 * shows at full strength on the right: on a phone (text over the whole image) 75%
 * of the page background everywhere; from `lg` 92% at the left edge, 75% at 45%
 * (past the right edge of the text column) and clear from 75%. White body text on
 * the lightest possible photo under 75% of #11141b is about 5.6:1, past WCAG AA's
 * 4.5:1. A short fade at the bottom blends the photo into the next section.
 */
export function HeroImage({ image }: { image: ImageView }) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- a per-tenant API response, not a static asset */}
      <img src={image.src} srcSet={image.srcSet} sizes="100vw" alt={image.alt} width={image.width} height={image.height} fetchPriority="high" decoding="async" className="absolute inset-0 h-full w-full object-cover object-[72%_50%] lg:object-center" />
      <div className="absolute inset-0 bg-[#11141b]/75 lg:hidden" />
      <div className="absolute inset-0 hidden bg-linear-to-r from-[#11141b]/92 via-[#11141b]/75 via-45% to-transparent to-75% lg:block" />
      <div className="absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-[#11141b] to-transparent" />
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
