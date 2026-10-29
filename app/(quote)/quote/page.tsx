import { headers } from "next/headers"
import { notFound } from "next/navigation"
import { QuickQuoteHeightReporter } from "@/components/insurance/QuickQuoteHeightReporter"
import { QuickQuoteWidget } from "@/components/insurance/QuickQuoteWidget"
import { QuickQuoteWizard } from "@/components/insurance/QuickQuoteWizard"
import {
  DEFAULT_QUICKQUOTE_VIEW,
  isMultiVehicleEnabled,
  isQuickQuoteView,
  isMultiRiskEnabled,
  resolveQuickQuoteHostConfig,
} from "@/lib/insurance/quickquote-config"
import { findLenderIdentity } from "@/lib/config/identity"
import { websiteBaseUrl } from "@/lib/config/deployment-urls"
import { getResolvedTenantId } from "@/lib/tenant"

interface QuotePageProps {
  searchParams: Promise<{ view?: string }>
}

/**
 * The embed is gated on runtime environment, so this page must not be
 * prerendered. `next build` runs inside the Docker image build, where the box's
 * runtime .env does not exist — a statically prerendered page would bake
 * "unconfigured" permanently and the feature could never be switched on by
 * setting the variables and restarting the container. It also reads the
 * request Host, which a static render has no concept of.
 */
export const dynamic = "force-dynamic"

/**
 * Absolute — this page is served from a different origin to the main site.
 * Null while NEXT_PUBLIC_WEBSITE_URL is unset: no link rather than a guess.
 */
function privacyPolicyUrl(): string | null {
  const base = websiteBaseUrl()
  return base ? `${base}/site/privacy` : null
}

/**
 * The isolated QuickQuote host. Reached only through the iframe on
 * /site/products/insurance — see components/insurance/QuickQuotePanel.tsx.
 *
 * 404s unless the embed is fully configured AND the request arrived on an
 * allow-listed quote host. proxy.ts already refuses off-host requests; this is
 * the second layer, so the confinement does not depend on middleware alone.
 */
export default async function QuotePage({ searchParams }: QuotePageProps) {
  const requestHeaders = await headers()
  const hostname = (requestHeaders.get("host") ?? "")
    .split(":")[0]
    .toLowerCase()
    .replace(/\.$/, "")

  const config = resolveQuickQuoteHostConfig(hostname)
  if (!config) notFound()

  const identity = await findLenderIdentity(await getResolvedTenantId())
  if (!identity) return null
  // The quote host names the lender as the FSP: no FSP number, no quotes.
  if (!identity.fspNumber) notFound()
  const privacyUrl = privacyPolicyUrl()

  const { view } = await searchParams
  const requested = isQuickQuoteView(view) ? view : DEFAULT_QUICKQUOTE_VIEW
  // The flag gates the HOST, not just which tabs the marketing page offers.
  // Gating only the tab list left /quote?view=home serving the whole journey
  // with FSP_QUICKQUOTE_MULTI_RISK off — reachable from a bookmark, browser
  // history, or anyone who has seen the URL. That made the one lever for
  // retiring a misbehaving journey a cosmetic preference: turning it off
  // removed a tab and left the journey live.
  //
  // 404 rather than quietly serving motor instead. A silent fallback hands
  // someone who asked to insure their house a form headed "Tell us about the
  // car", with nothing saying the product changed — and this page's whole
  // job is to be a truthful surface. A visitor who followed a stale link is
  // better told the page is not there than shown the wrong product.
  const flagged = requested !== "motor" && !isMultiRiskEnabled()
  if (flagged) notFound()
  const initialView = requested

  return (
    <main className="cf-quote-page relative mx-auto w-full max-w-5xl px-6 py-8 md:px-10">
      <div className="cf-quote-shell">
        <header className="mb-7 flex items-center gap-3 border-b border-white/12 pb-4">
          <span className="text-sm font-semibold tracking-wide text-white">
            {identity.tradingName}
          </span>
          {/* Registration numbers belong on the collecting origin, not only on
              the page that frames it — this host stands alone in the iframe. */}
          <span className="ml-auto text-[0.6rem] uppercase tracking-[0.14em] text-white/48">
            {identity.ncrNumber ? `NCR ${identity.ncrNumber}` : null}{identity.ncrNumber && identity.fspNumber ? " · " : null}{identity.fspNumber ? `FSP ${identity.fspNumber}` : null}
          </span>
        </header>

      <QuickQuoteHeightReporter />
      {/* `view` decides which journey the wizard drives: which fields it asks,
          which it requires FSP to have served before it takes over at all, and
          which questions its boot skeleton reserves space for. All three views
          are real journeys — `initialView` above has already refused a
          flag-gated one. */}
      <QuickQuoteWizard multiVehicle={isMultiVehicleEnabled()} view={initialView} />
      <QuickQuoteWidget config={config} view={initialView} />

      {/* FAIS: the visitor is receiving comparative quotes, not advice. The
          basis of the service has to be stated where the service happens, not
          only on the page that frames it. */}
      <section className="mt-10 border-t border-white/12 pt-6 text-xs leading-6 text-white/60">
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-white/72">
          Important information
        </h2>
        <p className="mt-3">
          Quotes are supplied by FSP Solutions and the participating insurers.{" "}
          {identity.tradingName} is an authorised Financial Services Provider (FSP{" "}
          {identity.fspNumber})
          acting as intermediary. No advice is given here and no assessment of your
          particular needs, objectives or circumstances has been carried out — the
          comparison is provided so that you can make your own decision.
        </p>
        <p className="mt-3">
          Premiums shown are indicative and subject to the insurer&apos;s own underwriting,
          acceptance and terms. Cover begins only once the insurer has issued a policy.
        </p>

        {/* POPIA s18 requires notification AT collection. This page is where the
            personal information is entered, and it deliberately carries no
            Footer, so the notice has to live here rather than on the page that
            frames it.

            ⚠️ NOT YET APPROVED BY LEGAL — same status as the FAIS copy on the
            insurance page.

            The responsible-party sentence was briefly deleted here on the
            grounds that it pre-judged the operator question. That was an
            over-correction: it identifies the lender as responsible party *for
            the referral*, which is uncontested — the lender is unavoidably that
            for a referral it solicits on its own page. The contested question
            is FSP's status, and this sentence never spoke to it. s18(1)(b)
            requires the responsible party be named at collection, so removing
            it under-disclosed. Restored, scoped to the referral only.

            STILL OWED BY LEGAL, do not guess at these:
              - s18(1)(b) wants name AND address; no address appears here or on
                the linked privacy notice.
              - s11(3) right to object is not stated (pre-existing gap).
              - s72 cross-border transfer: FSP's hosting location is unknown,
                so whether the data leaves the country is unstated. */}
        <h2 className="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-white/72">
          How your information is used
        </h2>
        {/* Split by stage, because the two stages genuinely differ and the
            single sentence that used to be here over-disclosed the first one.
            At quote stage QuickQuoteWizard derives birth year and gender from
            the ID number and writes only those into FSP's form — the raw
            number is not in their field map and does not leave the browser.
            Telling someone their identity number goes to a third party when it
            does not is both inaccurate and needlessly off-putting. If the ID is
            ever added to FIELD_NAMES, merge these two paragraphs back. */}
        <p className="mt-3">
          To get you quotes, the details of what you want insured — and your age, gender
          and area — are submitted to FSP Solutions, who obtain prices from the
          participating insurers. If you enter your identity number, it is used in your
          browser only, to fill in your year of birth and gender; it is not sent with
          your quote.
        </p>
        <p className="mt-3">
          If you choose one of the quotes and ask to be contacted, the name and contact
          details you enter are passed to {identity.tradingName} so that an adviser can call you
          about it.
        </p>
        <p className="mt-3">
          {identity.legalName} is the responsible party for referring you to this
          service, for the enquiry it receives when you complete a quote, and for any
          follow-up contact it makes. Providing your details is voluntary; without them
          the insurers cannot price your risk. To ask what personal information is held about you, or to have
          it corrected or deleted, contact {identity.tradingName} or FSP Solutions. You may also
          complain to the Information Regulator of South Africa.
          {privacyUrl && (
            <>
              {" "}
              <a
                href={privacyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-white"
              >
                Read the {identity.tradingName} privacy notice
              </a>
              .
            </>
          )}
        </p>
        <p className="mt-3">
          If you would prefer to speak to an adviser before deciding, close this quote and
          use the enquiry form on our insurance page.
        </p>
      </section>
      </div>
    </main>
  )
}
