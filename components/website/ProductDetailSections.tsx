import Link from "next/link"
import { ArrowRight, CheckCircle2, FileText, HelpCircle, ListChecks, Users } from "lucide-react"

export type ProductDetailSectionsProps = {
  goodFitItems?: string[]
  notIdealItems?: string[]
  fitTitle?: string
  fitItems: string[]
  processTitle?: string
  processItems: string[]
  documentsTitle?: string
  documentItems: string[]
  decisionTitle?: string
  decisionItems: string[]
  note?: string
  enquiryHref?: string
  enquiryLabel?: string
  /** The lender's brand name, as it appears in the enquiry prompt. */
  lenderName: string
}

function DetailCard({
  title,
  items,
  icon: Icon,
}: {
  title: string
  items: string[]
  icon: typeof Users
}) {
  return (
    <article className="border border-white/16 bg-[#1a1e27]/64 p-6 backdrop-blur-md">
      <div className="flex h-11 w-11 items-center justify-center border border-[#a5b4fc]/35 bg-[#a5b4fc]/12 text-[#a5b4fc]">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </div>
      <h3 className="mt-5 text-lg font-semibold text-white">{title}</h3>
      <ul className="mt-4 space-y-3">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-3 text-sm leading-6 text-white/76">
            <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#a5b4fc]" aria-hidden="true" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </article>
  )
}

export function ProductDetailSections({
  goodFitItems,
  notIdealItems,
  fitTitle = "Who this is for",
  fitItems,
  processTitle = "How it works",
  processItems,
  documentsTitle = "What we usually need",
  documentItems,
  decisionTitle = "Before you decide",
  decisionItems,
  note,
  enquiryHref = "/site/contact",
  enquiryLabel = "Speak to an advisor",
  lenderName,
}: ProductDetailSectionsProps) {
  const showFitPanel = Boolean(goodFitItems?.length || notIdealItems?.length)

  return (
    <section className="bg-[#11141b] px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#a5b4fc]">Product detail</p>
        <h2 className="mt-4 max-w-3xl text-3xl font-semibold tracking-normal text-white sm:text-4xl">
          Clear next steps before you apply or enquire
        </h2>
        {note ? <p className="mt-4 max-w-3xl text-base leading-7 text-white/64">{note}</p> : null}
        {showFitPanel ? (
          <div className="mt-8 grid gap-4 lg:grid-cols-2">
            {goodFitItems?.length ? (
              <article className="border border-[#a5b4fc]/35 bg-[#a5b4fc]/[0.07] p-6">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#a5b4fc]">Good fit if</p>
                <ul className="mt-4 space-y-3">
                  {goodFitItems.map((item) => (
                    <li key={item} className="flex items-start gap-3 text-sm leading-6 text-white/78">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#a5b4fc]" aria-hidden="true" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ) : null}
            {notIdealItems?.length ? (
              <article className="border border-white/14 bg-white/[0.04] p-6">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/64">Consider another path if</p>
                <ul className="mt-4 space-y-3">
                  {notIdealItems.map((item) => (
                    <li key={item} className="flex items-start gap-3 text-sm leading-6 text-white/68">
                      <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-white/42" aria-hidden="true" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ) : null}
          </div>
        ) : null}
        <div className="mt-10 grid gap-5 lg:grid-cols-4">
          <DetailCard title={fitTitle} items={fitItems} icon={Users} />
          <DetailCard title={processTitle} items={processItems} icon={ListChecks} />
          <DetailCard title={documentsTitle} items={documentItems} icon={FileText} />
          <DetailCard title={decisionTitle} items={decisionItems} icon={HelpCircle} />
        </div>
        <div className="mt-8 flex flex-col gap-3 border border-[#a5b4fc]/30 bg-[#a5b4fc]/[0.06] p-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-sm leading-6 text-white/72">
            Still unsure which path fits? Start with an enquiry and {lenderName} will route you to the correct product workflow.
          </p>
          <Link
            href={enquiryHref}
            className="inline-flex shrink-0 items-center justify-center gap-2 border border-[#a5b4fc]/70 px-5 py-2.5 text-sm font-semibold text-[#a5b4fc] transition hover:bg-[#a5b4fc]/10"
          >
            {enquiryLabel}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  )
}
