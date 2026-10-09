import Image from "next/image"
import Link from "next/link"
import { ArrowRight, CheckCircle2 } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import type { Crumb } from "@/lib/nav/breadcrumbs"

export type ProductServiceGroup = {
  title: string
  icon: LucideIcon
  items: string[]
}

export type ProductCTA = {
  label: string
  href: string
}

export type ProductPageProps = {
  breadcrumb?: Crumb[]
  hero: {
    eyebrow: string
    headline: string
    subhead: string
    /** Optional photograph behind the hero; none is requested when absent. */
    bgImage?: string
  }
  welcome: {
    title: string
    subtitle: string
    body: string
  }
  services: {
    sectionTitle: string
    sectionIntro?: string
    groups: ProductServiceGroup[]
  }
  whyChoose: {
    title: string
    bullets: string[]
  }
  mission: {
    title: string
    body: string
  }
  ctas: {
    primary: ProductCTA
    secondary?: ProductCTA
  }
}

export default function ProductPageTemplate({
  breadcrumb,
  hero,
  welcome,
  services,
  whyChoose,
  mission,
  ctas,
}: ProductPageProps) {
  const groupCols = services.groups.length === 2 ? "lg:grid-cols-2" : "lg:grid-cols-3"
  const bulletCols = whyChoose.bullets.length === 4 ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3"

  return (
    <div className="bg-[#11141b] text-white">
      <section className="relative flex min-h-[520px] items-center overflow-hidden px-4 py-24 sm:px-6 lg:px-8">
        {hero.bgImage ? (
          <Image
            src={hero.bgImage}
            alt="" role="presentation" aria-hidden="true"
            fill
            priority
            className="object-cover object-center scale-105"
            sizes="100vw"
          />
        ) : null}
        <div className="absolute inset-0 bg-[#11141b]/20" />
        <div className="absolute inset-0 bg-linear-to-r from-[#11141b]/88 via-[#11141b]/52 to-[#11141b]/0" />
        <div className="relative mx-auto w-full max-w-7xl">
          {breadcrumb && breadcrumb.length > 1 && (
            <Breadcrumbs items={breadcrumb} variant="onDark" className="mb-6" />
          )}
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#a5b4fc]">
            {hero.eyebrow}
          </p>
          <h1 className="mt-5 max-w-4xl text-balance text-3xl font-semibold leading-tight tracking-normal text-white sm:text-5xl lg:text-6xl">
            {hero.headline}
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-white/68">{hero.subhead}</p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Link
              href={ctas.primary.href}
              className="inline-flex items-center justify-center gap-2 bg-[#a5b4fc] px-6 py-3 text-sm font-semibold text-[#11141b] transition hover:bg-[#c7d2fe]"
            >
              {ctas.primary.label}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
            {ctas.secondary ? (
              <Link
                href={ctas.secondary.href}
                className="inline-flex items-center justify-center gap-2 border border-[#a5b4fc]/70 px-6 py-3 text-sm font-semibold text-[#a5b4fc] transition hover:bg-[#a5b4fc]/10"
              >
                {ctas.secondary.label}
              </Link>
            ) : null}
          </div>
        </div>
      </section>

      <section className="border-y border-white/10 bg-[#1a1e27] px-4 py-20 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#a5b4fc]">
            {welcome.title}
          </p>
          <h2 className="mt-4 text-3xl font-semibold tracking-normal text-white sm:text-4xl">
            {welcome.subtitle}
          </h2>
          <p className="mt-6 text-lg leading-8 text-white/66">{welcome.body}</p>
        </div>
      </section>

      <section className="bg-[#11141b] px-4 py-20 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#a5b4fc]">Our services</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-normal text-white sm:text-4xl">
            {services.sectionTitle}
          </h2>
          {services.sectionIntro ? (
            <p className="mt-4 max-w-3xl text-base leading-7 text-white/62">{services.sectionIntro}</p>
          ) : null}
          <div className={`mt-10 grid gap-5 ${groupCols}`}>
            {services.groups.map((group) => {
              const Icon = group.icon
              return (
                <article
                  key={group.title}
                  className="border border-white/16 bg-[#1a1e27]/64 p-7 backdrop-blur-md"
                >
                  <div className="flex h-12 w-12 items-center justify-center border border-[#a5b4fc]/35 bg-[#a5b4fc]/12 text-[#a5b4fc]">
                    <Icon className="h-6 w-6" aria-hidden="true" />
                  </div>
                  <h3 className="mt-6 text-xl font-semibold text-white">{group.title}</h3>
                  <ul className="mt-5 space-y-3">
                    {group.items.map((item) => (
                      <li key={item} className="flex items-start gap-3 text-sm leading-6 text-white/76">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#a5b4fc]" aria-hidden="true" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              )
            })}
          </div>
        </div>
      </section>

      <section className="border-y border-white/10 bg-[#1a1e27] px-4 py-20 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#a5b4fc]">Why choose us</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-normal text-white sm:text-4xl">
            {whyChoose.title}
          </h2>
          <div className={`mt-10 grid gap-4 ${bulletCols}`}>
            {whyChoose.bullets.map((bullet) => (
              <div
                key={bullet}
                className="flex items-start gap-3 border border-white/16 bg-[#11141b]/60 p-5 backdrop-blur-md"
              >
                <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-[#a5b4fc]" aria-hidden="true" />
                <span className="text-sm font-medium text-white/86">{bullet}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-[#11141b] px-4 py-20 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#a5b4fc]">
            {mission.title}
          </p>
          <p className="mt-6 text-xl leading-9 text-white/86 sm:text-2xl sm:leading-10">
            {mission.body}
          </p>
        </div>
      </section>

      <section className="border-t border-white/10 bg-[#1a1e27] px-4 py-14 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-4xl flex-col items-center justify-center gap-4 text-center sm:flex-row">
          <Link
            href={ctas.primary.href}
            className="inline-flex items-center justify-center gap-2 bg-[#a5b4fc] px-6 py-3 text-sm font-semibold text-[#11141b] transition hover:bg-[#c7d2fe]"
          >
            {ctas.primary.label}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
          {ctas.secondary ? (
            <Link
              href={ctas.secondary.href}
              className="inline-flex items-center justify-center gap-2 border border-[#a5b4fc]/70 px-6 py-3 text-sm font-semibold text-[#a5b4fc] transition hover:bg-[#a5b4fc]/10"
            >
              {ctas.secondary.label}
            </Link>
          ) : null}
        </div>
      </section>
    </div>
  )
}
