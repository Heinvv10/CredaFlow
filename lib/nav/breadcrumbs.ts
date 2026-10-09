import type { BreadcrumbItem } from "@/lib/seo/jsonld"

/** A single breadcrumb. The current page is the last crumb and has no href. */
export type Crumb = { label: string; href?: string }

/**
 * Convert a SEO breadcrumb trail (the same array fed to `breadcrumbLd`) into
 * visible `Crumb`s. The last item is the current page, so its href is dropped.
 */
export function toCrumbs(trail: BreadcrumbItem[]): Crumb[] {
  return trail.map((item, i) =>
    i === trail.length - 1 ? { label: item.name } : { label: item.name, href: item.path },
  )
}
