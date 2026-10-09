import Link from "next/link"
import { ChevronRight } from "lucide-react"
import type { Crumb } from "@/lib/nav/breadcrumbs"

const VARIANTS = {
  default: {
    nav: "text-[var(--cf-text-muted)]",
    link: "hover:text-[var(--cf-text)] transition-colors",
    current: "text-[var(--cf-text)]",
    sep: "text-[var(--cf-border-subtle)]",
  },
  onDark: {
    // white/60 clears WCAG AA (4.5:1) for the link crumbs on the dark heroes;
    // white/42 measured ~4.1:1. Current crumb bumped to /85 to keep hierarchy.
    nav: "text-white/60",
    link: "hover:text-white transition-colors",
    current: "text-white/85",
    sep: "text-white/40",
  },
} as const

type BreadcrumbsProps = {
  items: Crumb[]
  variant?: keyof typeof VARIANTS
  className?: string
}

/**
 * Visible breadcrumb trail. Caller supplies explicit crumbs; the last is the
 * current page (rendered inert). Renders nothing for a single-crumb trail.
 */
export function Breadcrumbs({ items, variant = "default", className }: BreadcrumbsProps) {
  if (items.length < 2) return null
  const v = VARIANTS[variant]
  return (
    <nav
      aria-label="Breadcrumb"
      className={`flex items-center gap-1.5 text-xs ${v.nav} ${className ?? ""}`}
    >
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((item, i) => {
          const isLast = i === items.length - 1
          return (
            <li key={`${item.label}-${i}`} className="flex items-center gap-1.5">
              {i > 0 && <ChevronRight size={13} aria-hidden="true" className={v.sep} />}
              {isLast || !item.href ? (
                <span
                  aria-current={isLast ? "page" : undefined}
                  className={`max-w-[16rem] truncate ${isLast ? v.current : ""}`}
                >
                  {item.label}
                </span>
              ) : (
                <Link href={item.href} className={v.link}>
                  {item.label}
                </Link>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
