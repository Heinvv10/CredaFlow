import type { ImageView, WebsiteImageryView } from "@/lib/config/website-imagery"

// The lender's own photos on the home page (lib/config/website-imagery.ts). Each
// piece renders only when its slot is set; with none set HomePage renders the
// markup it had before there were any.

/**
 * Behind the hero's text, under a dark wash so the white copy stays readable on
 * any photo: 80% of the page background where the text sits (all of it on a
 * phone, the left 70% from `lg`), 30% at the right edge. White body text on the
 * lightest possible photo under 80% of #11141b is above 6:1, past WCAG AA's 4.5:1.
 */
export function HeroImage({ image }: { image: ImageView }) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- a per-tenant API response, not a static asset */}
      <img src={image.src} alt={image.alt} width={image.width} height={image.height} fetchPriority="high" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
      <div className="absolute inset-0 bg-[#11141b]/80 lg:hidden" />
      <div className="absolute inset-0 hidden bg-linear-to-r from-[#11141b] via-[#11141b]/80 via-70% to-[#11141b]/30 lg:block" />
    </>
  )
}

/** The top of a product card, running out to the card's border (the card has p-5). */
export function ProductCardImage({ image }: { image: ImageView }) {
  return (
    <div className="-mx-5 -mt-5 mb-4 aspect-[16/9] overflow-hidden">
      {/* eslint-disable-next-line @next/next/no-img-element -- a per-tenant API response, not a static asset */}
      <img src={image.src} alt={image.alt} width={image.width} height={image.height} loading="lazy" decoding="async" className="h-full w-full object-cover" />
    </div>
  )
}

export function CommunityBand({ community }: { community: NonNullable<WebsiteImageryView["community"]> }) {
  return (
    <section className="border-t border-white/10 bg-[#11141b] px-4 py-12 sm:px-6 md:py-16 lg:px-8">
      <div className="mx-auto grid max-w-7xl items-center gap-8 lg:grid-cols-2 lg:gap-12">
        <div className="aspect-[3/2] overflow-hidden border border-white/12">
          {/* eslint-disable-next-line @next/next/no-img-element -- a per-tenant API response, not a static asset */}
          <img src={community.src} alt={community.alt} width={community.width} height={community.height} loading="lazy" decoding="async" className="h-full w-full object-cover" />
        </div>
        <div>
          <h2 className="text-balance text-3xl font-semibold leading-tight tracking-normal text-white sm:text-4xl">{community.heading}</h2>
          <p className="mt-5 max-w-xl text-base leading-7 text-white/72 md:text-lg md:leading-8">{community.body}</p>
        </div>
      </div>
    </section>
  )
}
