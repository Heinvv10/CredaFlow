// `?page=` arrives as a raw, untrusted (or absent) query string. Garbage,
// zero, negative, and non-integer values all degrade to page 1 rather than
// producing a negative `skip` or an empty Prisma query — a page number is
// display state, not something worth a hard error over.
export function parsePage(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return 1
  return n
}

export function pageOffsets(page: number, pageSize: number): { skip: number; take: number } {
  return { skip: (page - 1) * pageSize, take: pageSize }
}

// Always at least 1: a queue with zero matching rows still has one (empty) page,
// which keeps "Page 1 of 1" a valid state instead of the caller special-casing 0.
export function totalPages(totalCount: number, pageSize: number): number {
  return Math.max(1, Math.ceil(totalCount / pageSize))
}

// Split from parsePage because totalPages depends on a DB count that isn't
// known until after that query resolves — parsePage runs first (to shape the
// query), this runs second (to correct it once the real total is known). A
// stale bookmark or hand-edited `?page=` outliving a shrinking result set
// (e.g. after items get decided) would otherwise skip past the end of the
// table: an empty page with a "Page 99 of 5" footer instead of landing on
// the last real page.
export function clampPage(page: number, totalPages: number): number {
  return Math.max(1, Math.min(page, totalPages))
}
