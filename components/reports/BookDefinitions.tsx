import { BOOK_DEFINITIONS } from "@/lib/reports/book-arrears"

/** What the book, arrears and PAR figures beside it count (lib/reports/book-arrears.ts). */
export function BookDefinitions({ scope, chargesLive = false }: { scope: string; chargesLive?: boolean }) {
  return (
    <div className="mt-4 space-y-1 text-xs text-[var(--cf-text-muted)]" data-testid="book-definitions">
      <p>{scope}</p>
      <p>{BOOK_DEFINITIONS.book}</p>
      <p>{BOOK_DEFINITIONS.arrears}</p>
      {chargesLive && <p>{BOOK_DEFINITIONS.chargesOnly}</p>}
      <p>{BOOK_DEFINITIONS.par}</p>
    </div>
  )
}
