import Link from "next/link"
import { ArrowRight, BadgeCheck, CheckCircle2, FilePlus2, HelpCircle, ShieldCheck, Smartphone, Upload } from "lucide-react"
import type { LenderIdentity } from "@/lib/config/identity-schema"
import type { PublicLoanProduct } from "@/lib/public-loan-products"
import { portalDocumentsUrl, portalLoginUrl as portalLoginHref, portalUrlOrNull } from "@/lib/portal-urls"
import { HomeFaqSection } from "@/app/(website)/site/HomeFaqSection"
import { HomeLoanCalculatorCard } from "@/app/(website)/site/HomeLoanCalculatorCard"
import { homeFaqs } from "@/app/(website)/site/home-faqs"
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/locales"
import { createTranslator, type MessageKey, type Translator } from "@/lib/i18n/translate"
import { localizeProduct } from "@/lib/i18n/products"
import { activeCurrencySymbol } from "@/lib/utils"

// Client-facing portal URLs (lib/portal-urls.ts), null when the deployment has
// no portal URL configured: the portal links are then left out rather than
// pointed at a guessed host.
const portalLoginCtaUrl = portalUrlOrNull(() => portalLoginHref(null))
const portalDocumentsCtaUrl = portalUrlOrNull(() => portalDocumentsUrl())

type HomeKey = MessageKey<"websiteHome">

const trustItems: HomeKey[] = ["trustNcr", "trustPopia", "trustFais", "trustPortal"]

const quickSteps: { step: string; title: HomeKey; body: HomeKey }[] = [
  { step: "1", title: "step1Title", body: "step1Body" },
  { step: "2", title: "step2Title", body: "step2Body" },
  { step: "3", title: "step3Title", body: "step3Body" },
]

const returnShortcuts: { label: HomeKey; href: string; icon: typeof FilePlus2 }[] = [
  { label: "continueApplication", href: "/site/apply", icon: FilePlus2 },
  ...(portalDocumentsCtaUrl ? [{ label: "uploadDocuments" as const, href: portalDocumentsCtaUrl, icon: Upload }] : []),
  ...(portalLoginCtaUrl ? [{ label: "clientPortal" as const, href: portalLoginCtaUrl, icon: Smartphone }] : []),
]

const protections: HomeKey[] = ["protection1", "protection2", "protection3", "protection4"]

const rands = (cents: number) => `${activeCurrencySymbol()}${Math.round(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`

function productRange(product: PublicLoanProduct, t: Translator<"websiteHome">): string {
  const unit = t(product.termUnit === "days" ? "unitDays" : "unitMonths")
  const min = rands(product.minAmount)
  const max = rands(product.maxAmount)
  return product.fixedTerm
    ? t("rangeFixed", { min, max, term: product.fixedTerm, unit })
    : t("rangeVariable", { min, max, minTerm: product.minTerm, maxTerm: product.maxTerm, unit })
}

/**
 * The public home page. Everything about the lender comes from its identity,
 * and the product cards only from the loan products it has configured.
 */
export function HomePage({ identity, products: catalogue, locale = DEFAULT_LOCALE }: { identity: LenderIdentity; products: PublicLoanProduct[]; locale?: Locale }) {
  const t = createTranslator(locale, "websiteHome")
  const tp = createTranslator(locale, "websiteProducts")
  const products = catalogue.map((product) => localizeProduct(product, tp))
  return (
    <div className="bg-[#11141b] text-white">
      <section className="relative min-h-[560px] overflow-hidden bg-[#11141b]">
        <div className="absolute inset-0 bg-linear-to-r from-[#11141b] via-[#11141b]/76 to-[#1b1d24]" />
        <div className="absolute inset-x-0 bottom-0 h-48 bg-linear-to-t from-[#11141b] to-transparent" />

        <div className="relative mx-auto flex min-h-[560px] max-w-7xl flex-col justify-end px-4 py-12 sm:px-6 lg:px-8">
          <div className="max-w-3xl py-16 lg:max-w-[660px]">
            {identity.ncrNumber && (
              <div className="mb-6 inline-flex items-center gap-2 border border-white/18 bg-white/10 px-4 py-2 text-xs font-semibold text-white/84 backdrop-blur">
                <BadgeCheck className="h-4 w-4 text-[#a5b4fc]" />
                {t("ncrBadge", { ncr: identity.ncrNumber })}
              </div>
            )}
            <h1 className="max-w-3xl text-balance text-5xl font-semibold leading-[0.98] tracking-normal text-white sm:text-6xl lg:text-7xl">
              {identity.tradingName}
            </h1>
            <p className="mt-7 max-w-2xl text-lg leading-8 text-white/78">
              {identity.brandTagline ?? t("defaultTagline")}
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/site/qualify"
                className="inline-flex items-center justify-center gap-2 bg-[#a5b4fc] px-6 py-3 text-sm font-semibold text-[#11141b] transition hover:bg-[#c7d2fe]"
              >
                {t("checkEligibility")}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/site/apply"
                className="inline-flex items-center justify-center gap-2 border border-white/26 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
              >
                {t("applyOnline")}
                <ArrowRight className="h-4 w-4" />
              </Link>
              {portalLoginCtaUrl && (
                <Link
                  href={portalLoginCtaUrl}
                  className="inline-flex items-center justify-center gap-2 border border-white/26 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
                >
                  {t("clientPortal")}
                  <Smartphone className="h-4 w-4" />
                </Link>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-white/10 bg-[#11141b] px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-col gap-3 border-b border-white/10 pb-7 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[#a5b4fc]">{t("startHere")}</p>
              <h2 className="mt-2 text-2xl font-semibold text-white">{t("whatDoYouNeed")}</h2>
            </div>
            <p className="max-w-xl text-sm leading-6 text-white/58">
              {t("chooseService")}
            </p>
          </div>

          <div className="grid items-stretch gap-3 py-7 md:grid-cols-2 lg:grid-cols-3">
            {products.map((product) => (
              <Link
                key={product.code}
                href={product.desktopHref}
                className="group flex h-full min-h-[132px] flex-col border border-white/12 bg-white/[0.04] p-5 transition hover:border-[#a5b4fc] hover:bg-white/[0.08]"
              >
                <div className="flex min-h-12 items-start justify-between gap-4">
                  <h3 className="text-base font-semibold text-white">{product.label}</h3>
                  <ArrowRight className="h-4 w-4 shrink-0 text-[#a5b4fc] transition group-hover:translate-x-1" />
                </div>
                <p className="mt-3 text-sm leading-6 text-white/56">{product.description}</p>
                <p className="mt-2 text-xs leading-5 text-white/48">{productRange(product, t)}</p>
              </Link>
            ))}
            {identity.fspNumber && (
              <Link
                href="/site/products/insurance"
                className="group flex h-full min-h-[132px] flex-col border border-white/12 bg-white/[0.04] p-5 transition hover:border-[#a5b4fc] hover:bg-white/[0.08]"
              >
                <div className="flex min-h-12 items-start justify-between gap-4">
                  <h3 className="text-base font-semibold text-white">{t("insurance")}</h3>
                  <ShieldCheck className="h-4 w-4 shrink-0 text-[#a5b4fc]" />
                </div>
                <p className="mt-3 text-sm leading-6 text-white/56">{t("insuranceCard")}</p>
              </Link>
            )}
            <Link
              href="/site/qualify"
              className="group flex h-full min-h-[132px] flex-col border border-[#a5b4fc]/45 bg-[#a5b4fc]/[0.08] p-5 transition hover:border-[#a5b4fc] hover:bg-[#a5b4fc]/[0.12]"
            >
              <div className="flex min-h-12 items-start justify-between gap-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#a5b4fc]">{t("guidedRoute")}</p>
                  <h3 className="mt-2 text-base font-semibold text-white">{t("notSure")}</h3>
                </div>
                <HelpCircle className="h-5 w-5 shrink-0 text-[#a5b4fc] transition group-hover:scale-105" />
              </div>
              <p className="mt-3 text-sm leading-6 text-white/68">{t("notSureBody")}</p>
            </Link>
          </div>

          <div className="grid gap-3 border-t border-white/10 py-6 lg:grid-cols-[1.15fr_0.85fr]">
            <div className="border border-white/12 bg-white/[0.04] p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#a5b4fc]">{t("howRoutes", { brand: identity.tradingName })}</p>
              <div className="mt-5 grid gap-3 md:grid-cols-3">
                {quickSteps.map((item) => (
                  <div key={item.step} className="flex gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center border border-[#a5b4fc]/35 bg-[#a5b4fc]/12 text-sm font-semibold text-[#a5b4fc]">
                      {item.step}
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-white">{t(item.title)}</h3>
                      <p className="mt-1 text-xs leading-5 text-white/58">{t(item.body)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="border border-[#a5b4fc]/30 bg-[#a5b4fc]/[0.06] p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#a5b4fc]">{t("alreadyStarted")}</p>
              <div className="mt-4 grid gap-2">
                {returnShortcuts.map((item) => (
                  <Link
                    key={item.label}
                    href={item.href}
                    className="flex min-h-11 items-center justify-between gap-3 border border-white/12 bg-[#11141b]/50 px-4 py-2.5 text-sm font-semibold text-white transition hover:border-[#a5b4fc]/60 hover:bg-[#11141b]/70"
                  >
                    <span className="inline-flex items-center gap-2">
                      <item.icon className="h-4 w-4 text-[#a5b4fc]" />
                      {t(item.label)}
                    </span>
                    <ArrowRight className="h-4 w-4 text-[#a5b4fc]" />
                  </Link>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 border-t border-white/10 pt-6 sm:grid-cols-4">
            {trustItems.filter((item) => item !== "trustFais" || identity.fspNumber).map((item) => (
              <div key={item} className="flex items-center gap-2 text-sm font-medium text-white/72">
                <CheckCircle2 className="h-4 w-4 text-[#a5b4fc]" />
                {t(item)}
              </div>
            ))}
          </div>
        </div>
      </section>

      {products.length > 0 && (
        <section className="relative overflow-hidden border-t border-white/10 bg-[#11141b] px-4 py-12 sm:px-6 md:py-20 lg:px-8">
          <div className="absolute inset-0 bg-linear-to-r from-[#11141b]/94 via-[#11141b]/68 to-[#1b1d24]" />
          <div className="relative mx-auto grid max-w-7xl gap-10 lg:grid-cols-[0.95fr_1.05fr]">
            <div className="flex flex-col justify-center">
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#a5b4fc]">{t("loanCalculator")}</p>
              <h2 className="mt-4 max-w-2xl text-3xl font-semibold leading-tight tracking-normal text-white sm:text-5xl">
                {t("calculatorHeading")}
              </h2>
              <p className="mt-5 max-w-xl text-base leading-7 text-white/68 md:text-lg md:leading-8">
                {t("calculatorBody")}
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link
                  href="/site/calculators"
                  className="inline-flex items-center justify-center gap-2 bg-[#a5b4fc] px-6 py-3 text-sm font-semibold text-[#11141b] transition hover:bg-[#c7d2fe]"
                >
                  {t("tryCalculator")}
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  href="/site/apply"
                  className="inline-flex items-center justify-center gap-2 border border-white/22 bg-white/[0.04] px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
                >
                  {t("applyNow")}
                </Link>
              </div>
            </div>

            <div className="hidden md:block">
              <HomeLoanCalculatorCard />
            </div>
          </div>
        </section>
      )}

      <section className="hidden border-t border-white/10 bg-[#11141b] px-4 py-20 sm:px-6 md:block lg:px-8">
        <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <div className="flex h-11 w-11 items-center justify-center border border-[#a5b4fc]/35 bg-[#a5b4fc]/12 text-[#a5b4fc]">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <p className="mt-6 text-xs font-semibold uppercase tracking-[0.28em] text-[#a5b4fc]">{t("howProtected")}</p>
            <h2 className="mt-4 text-balance text-4xl font-semibold tracking-normal text-white">
              {t("protectedHeading")}
            </h2>
            {/* The sentence claims FSP authorisation; it is not translated without it. */}
            {identity.fspNumber && identity.ncrNumber && (
              <p className="mt-5 text-lg leading-8 text-white/66">
                {t("protectedBody", { legalName: identity.legalName, ncr: identity.ncrNumber, fsp: identity.fspNumber })}
              </p>
            )}
          </div>
          <div className="grid gap-3">
            {protections.map((p) => (
              <div key={p} className="flex items-start gap-3 border border-white/12 bg-white/[0.04] px-5 py-4">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[#a5b4fc]" />
                <span className="text-sm leading-7 text-white/72">{t(p)}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="hidden md:block">
        <HomeFaqSection brand={identity.tradingName} faqs={homeFaqs(identity, catalogue, locale)} locale={locale} />
      </div>

      <section className="relative overflow-hidden bg-[#11141b] px-4 py-16 text-center text-white sm:px-6 lg:px-8">
        <div className="relative">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#a5b4fc]">{t("readyToBegin")}</p>
          <h2 className="mx-auto mt-4 max-w-3xl text-4xl font-semibold tracking-normal">
            {t("readyHeading")}
          </h2>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-white/72">
            {t("readyBody", { brand: identity.tradingName })}
          </p>
          <div className="mt-8 flex justify-center">
            <Link
              href="/site/apply"
              className="inline-flex items-center justify-center gap-2 bg-[#a5b4fc] px-7 py-3 text-sm font-semibold text-[#11141b] transition hover:bg-[#c7d2fe]"
            >
              {t("applyNow")}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}
