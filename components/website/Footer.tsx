import Link from "next/link"
import { sastParts } from "@/lib/date/sast"
import type { LenderIdentity } from "@/lib/config/identity-schema"

const contactLinks = [
  { label: "Contact Us", href: "/site/contact" },
]

const productLinksCol = [
  { label: "Insurance", href: "/site/products/insurance" },
  { label: "Apply Online", href: "/site/apply" },
]

const resourceLinks = [
  { label: "Loan Calculator", href: "/site/calculators" },
  { label: "Check if I Qualify", href: "/site/qualify" },
]

const legalLinks = [
  { label: "Privacy & POPIA", href: "/site/privacy" },
  { label: "Terms & Conditions", href: "/site/terms" },
  { label: "Regulatory Information", href: "/site/regulatory-information" },
  { label: "Complaints", href: "/site/contact#complaints" },
]

function FooterColumn({ title, links }: { title: string; links: { label: string; href: string }[] }) {
  // Footer column titles are nav-group labels, not document-outline headings.
  // Using a heading tag here forced a level choice that either skipped a level
  // on pages without content H2s (audit "Heading Hierarchy Issues") or sat at
  // H2 alongside substantive content sections. The `nav` + `aria-labelledby`
  // pairing names the group for assistive tech without polluting the outline.
  const labelId = `footer-col-${title.toLowerCase()}`
  return (
    <nav aria-labelledby={labelId}>
      <p id={labelId} className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-[#a5b4fc]">
        {title}
      </p>
      <ul className="space-y-2.5">
        {links.map((link) => (
          <li key={link.href}>
            <Link href={link.href} className="text-sm text-white/54 transition-colors hover:text-white">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export default function Footer({ identity }: { identity: LenderIdentity }) {
  return (
    /* relative z-10: a page may render a position:fixed background layer (the
       insurance quotes page does), and a positioned layer paints ABOVE
       non-positioned siblings regardless of document order. Without this the
       photographic field on that page covered the whole footer — measured
       6.99:1 -> 1.05:1 on the NCR / FSP strip, invisible but
       still clickable, which is a WCAG 1.4.3 failure on regulatory copy.
       NavBar is already sticky z-50 and needs no equivalent. */
    <footer className="relative z-10 mt-auto border-t border-white/10 bg-[#11141b] text-white/70">
      {/* pb reserves the strip the WhatsApp launcher occupies (fixed, bottom-6
          + a 44px pill = 68px up from the viewport bottom). Without it the
          launcher lands on the same NCR / FSP strip the z-10 above
          protects — a second, unrelated way to obscure it. This happens
          at every width from 375px to 1440px; at desktop widths the pill covers
          the registration number outright. Kept as pt/pb rather than py so the
          reserve does not also pad the top. Enforced by Footer.test.tsx. */}
      <div className="mx-auto max-w-7xl px-4 pt-12 pb-24 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-5">
          <div className="col-span-2 md:col-span-1">
            <div className="mb-4 flex items-center gap-2">
              <span className="text-base font-bold text-white">{identity.tradingName}</span>
            </div>
            {identity.brandTagline && (
              <p className="mb-3 text-sm leading-relaxed text-white/54">{identity.brandTagline}</p>
            )}
            <div className="mt-4 space-y-1.5 text-sm text-white/54">
              <p>{identity.publicPhone}</p>
              <p>{identity.publicEmail}</p>
            </div>
          </div>

          <FooterColumn title="Contact" links={contactLinks} />
          <FooterColumn title="Products" links={productLinksCol} />
          <FooterColumn title="Resources" links={resourceLinks} />
          <FooterColumn title="Legal" links={legalLinks} />
        </div>

        <div className="mt-10 flex flex-col items-center justify-between gap-3 border-t border-white/10 pt-6 text-xs text-white/64 sm:flex-row">
          <p>&copy; {sastParts(new Date()).year} {identity.legalName} · Co. Reg: {identity.companyRegNumber}. All rights reserved.</p>
          <p>Registered Credit Provider — NCR Reg: {identity.ncrNumber} · FSP: {identity.fspNumber}</p>
        </div>
      </div>
    </footer>
  )
}
