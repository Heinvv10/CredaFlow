import Link from "next/link"
import { cn } from "@/lib/utils"
import type { PortalEntitySummary } from "@/lib/asset-finance/portal-entities"

/** The businesses the client may act for; the current one is highlighted. */
export function PortalEntitySwitcher({ entities, currentId }: { entities: PortalEntitySummary[]; currentId: string }) {
  if (entities.length < 2) return null
  return (
    <nav aria-label="Switch business" className="flex flex-wrap gap-2">
      {entities.map((e) => (
        <Link
          key={e.id}
          href={`/portal/business/${e.id}`}
          aria-current={e.id === currentId ? "page" : undefined}
          className={cn(
            "rounded-full border px-3 py-1.5 text-sm transition-colors",
            e.id === currentId
              ? "border-[var(--cf-brand)] bg-[var(--cf-brand)] text-[var(--cf-on-brand)]"
              : "border-[var(--cf-border-subtle)] text-[var(--cf-text-secondary)] hover:bg-[var(--cf-surface-hover)]",
          )}
        >
          {e.legalName}
        </Link>
      ))}
    </nav>
  )
}
