import type { Metadata } from "next"
import Link from "next/link"
import { headers } from "next/headers"
import { notFound } from "next/navigation"
import { QuoteSurface } from "@/components/insurance/QuoteSurface"
import { pickPlates } from "@/lib/insurance/quote-atmosphere"
import {
  isQuickQuoteEmbeddingHost,
  isMultiRiskEnabled,
  isQuickQuoteView,
  resolveQuickQuoteEmbedOrigin,
  DEFAULT_QUICKQUOTE_VIEW,
  QUICKQUOTE_VIEWS,
  type QuickQuoteView,
} from "@/lib/insurance/quickquote-config"
import { JsonLd } from "@/components/seo/JsonLd"
import { breadcrumbLd } from "@/lib/seo/jsonld"
import { buildPageMetadata } from "@/lib/seo/metadata"
import { getWebsiteIdentity } from "@/lib/website/identity"

/**
 * The comparison surface, on its own page.
 *
 * It used to be a section 2,700px down the insurance page, reached by an
 * anchor. Moving it here is not cosmetic — nearly every defect that surface has
 * produced came from being an iframe embedded inside a longer page: the frame
 * could only grow and never shrink, it accumulated ~1190px of dead space, a
 * height transition made it oscillate, anchor jumps landed behind the sticky
 * header, and switching product tabs silently destroyed the visitor's answers.
 * With the frame as the page's only content, a residual height change has
 * nothing left to shove around.
 *
 * The iframe itself stays, and must. FSP's bundle carries jQuery 1.9.1
 * (CVE-2020-11022/11023, CVE-2019-11358) and executes their JSONP, so it is
 * confined to its own origin where it never runs beside a session cookie. That
 * boundary is the reason for the frame; this page removes the cost of it
 * without giving it up.
 *
 * WHICH PRODUCTS ARE OFFERED is FSP_QUICKQUOTE_MULTI_RISK's decision, and the
 * page's own copy follows it rather than being written once and left. The tabs
 * were vehicle-only because our wizard took over motor and nothing else —
 * `missingFields` demanded all twelve vehicle fields, which a home-contents or
 * buildings form does not have, so those views fell through to FSP's unstyled
 * form. Tolerable half-hidden down a marketing page; not on a page whose whole
 * purpose is to look deliberate. Both are now real journeys, so the only thing
 * standing between them and the visitor is the flag.
 *
 * The heading and the meta description are derived from that same flag because
 * they are factual claims: with the flag off this page compares car insurance
 * and saying otherwise would be false, and with it on, calling it a car-only
 * page hides two products the visitor came for.
 */

export const dynamic = "force-dynamic"

/**
 * What this page actually compares, in one place.
 *
 * Read by the metadata, the H1 and the tab list, so the three cannot disagree
 * about which products are on offer.
 */
function offering() {
  const multiRisk = isMultiRiskEnabled()
  return {
    views: multiRisk ? QUICKQUOTE_VIEWS : (["motor"] as const),
    // "car insurance" / "car, home contents and buildings insurance". Only the
    // product noun moves; the quote-only sentence below is untouched.
    noun: multiRisk ? "car, home contents and buildings insurance" : "car insurance",
    heading: multiRisk ? "Compare insurance quotes" : "Compare car insurance quotes",
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const { noun, heading } = offering()
  return buildPageMetadata({
    identity: await getWebsiteIdentity(),
    title: heading,
    description: `Compare ${noun} from a panel of South African insurers in a few minutes. A quote-only service — no advice is given and no assessment of your needs is carried out.`,
    path: "/site/products/insurance/quotes",
  })
}

const quotesTrail = [
  { name: "Home", path: "/" },
  { name: "Insurance", path: "/site/products/insurance" },
  { name: "Compare quotes", path: "/site/products/insurance/quotes" },
]

/**
 * Which tab to open on, honouring the one named in the URL.
 *
 * The panel used to start on the first offered view no matter what, so a reload
 * — or a link someone sent — dropped a visitor pricing their house back onto
 * the car form. The tab now rides in the query string, which survives a
 * refresh, makes a product linkable, and needs no storage.
 *
 * Validated against the views this page is actually OFFERING rather than
 * against the full list: with FSP_QUICKQUOTE_MULTI_RISK off, `?view=building`
 * is a stale bookmark, and it must open the car tab rather than a tab that is
 * not there. This page does NOT 404 on it the way the quote host does — the
 * host is serving a journey that should not exist, while this is a marketing
 * page whose worst case is showing its default product.
 */
function initialView(
  offered: readonly QuickQuoteView[],
  requested: string | string[] | undefined,
): QuickQuoteView {
  return isQuickQuoteView(requested) && offered.includes(requested)
    ? requested
    : (offered[0] ?? DEFAULT_QUICKQUOTE_VIEW)
}

export default async function InsuranceQuotesPage({
  searchParams,
}: {
  /* string | string[]: Next hands back an ARRAY for a repeated key, so
     `?view=motor&view=building` is not the `string` the obvious annotation
     claims. Typed honestly rather than narrowed, because the narrow version
     compiles while being wrong about real traffic — and initialView has to
     refuse the array rather than index into it. */
  searchParams: Promise<{ view?: string | string[] }>
}) {
  const identity = await getWebsiteIdentity()
  if (!identity) return null
  // Quotes come through an authorised intermediary: no FSP number, no page.
  if (!identity.fspNumber) notFound()

  const requestHeaders = await headers()
  const hostname = (requestHeaders.get("host") ?? "")
    .split(":")[0]
    .toLowerCase()
    .replace(/\.$/, "")

  const origin = isQuickQuoteEmbeddingHost(hostname)
    ? resolveQuickQuoteEmbedOrigin()
    : null

  const { views, heading } = offering()
  // Chosen per request and held for the whole load — see pickPlates. Only the
  // offered views get a plate, so a flag-off page ships one image, not three.
  const allPlates = pickPlates()
  const plates = Object.fromEntries(
    views.flatMap((v) => (allPlates[v] ? [[v, allPlates[v]]] : [])),
  )

  // Same gate the embedded section used. A page that exists but cannot render
  // the frame is worse than no page: it is a dead end reached from a CTA that
  // promised a quote.
  if (!origin) notFound()

  return (
    <>
      <JsonLd id="insurance-quotes" data={[breadcrumbLd(quotesTrail)]} />

      {/* QuoteSurface owns <main> — the photographic field has to precede it
          in the document, not sit inside it. See its own comment. */}
      <QuoteSurface
        origin={origin}
        views={views}
        plates={plates}
        initialView={initialView(views, (await searchParams).view)}
        footnote={
          /* BELOW the panel: it ends "see the important information on the
             form", so it has to follow the form. text-white/60, not /48 —
             measured over the photographic field at 390x844 the smaller value
             gave 4.28:1 against a 4.5:1 AA floor for 12px text. */
          <p className="mt-5 max-w-3xl text-xs leading-5 text-white/60">
            The quote service is operated by FSP Solutions. It sends the details you
            enter directly to them, and lets them set their own cookies. If you choose a
            quote and ask to be contacted, an adviser from {identity.tradingName} will call you about it. No
            advice is provided — see the important information on the form.{" "}
            {identity.tradingName} is an authorised Financial Services Provider (FSP{" "}
            {identity.fspNumber}).
          </p>
        }
      >
        {/* /60 not /48 — see the footnote note; 12px over the field measured 4.28:1. */}
        <nav aria-label="Breadcrumb" className="text-xs text-white/60">
          <Link href="/site/products/insurance" className="hover:text-white/72">
            Insurance
          </Link>
          <span aria-hidden="true"> · </span>
          <span className="text-white/72">Compare quotes</span>
        </nav>

        {/* ⚠️ FAIS COPY — carried over verbatim from the embedded section it
            replaces, including its approval status. This page is execution-only
            (no advice, no needs analysis) while the insurance page around it
            describes an advice-led pathway, so the distinction has to be
            explicit wherever the surface appears. Do not reword without legal. */}
        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white md:text-4xl">
          {heading}
        </h1>
        <p className="mt-4 max-w-3xl text-base leading-7 text-white/72">
          Compare cover from our panel of insurers in a few minutes and decide for
          yourself.{" "}
          <strong className="font-semibold text-white/88">
            This is a quote-only service: no advice is given, and no assessment of your
            needs, objectives or circumstances is carried out.
          </strong>{" "}
          If you would rather be guided,{" "}
          <Link
            href="/site/products/insurance#insurance-enquiry"
            className="underline hover:text-white"
          >
            speak to an adviser instead
          </Link>
          .
        </p>

      </QuoteSurface>
    </>
  )
}
