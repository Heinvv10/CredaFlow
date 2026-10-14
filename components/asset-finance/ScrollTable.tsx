import { cn } from "@/lib/utils"

/**
 * A long table in ONE scroll container, both directions: on a phone it
 * scrolls sideways with every column header reachable, and the header row
 * stays visible while the rows scroll. Cells never wrap, so an amount or a
 * date stays on one line. Children are the ui/table header and body parts.
 * Below the sm breakpoint a one-line hint says the table scrolls sideways.
 */
export function ScrollTable({ children, maxHeight = "max-h-[28rem]", className }: {
  children: React.ReactNode
  maxHeight?: string
  className?: string
}) {
  return (
    <>
      <p className="mb-2 text-xs text-[var(--cf-text-muted)] sm:hidden">Scroll the table sideways to see every column.</p>
      <div className={cn("relative w-full overflow-auto", maxHeight, className)}>
        <table className="w-full caption-bottom text-sm [&_td]:whitespace-nowrap [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:whitespace-nowrap [&_th]:bg-[var(--cf-bg-panel)]">
          {children}
        </table>
      </div>
    </>
  )
}
