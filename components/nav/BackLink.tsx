import Link from "next/link"
import { ArrowLeft } from "lucide-react"

/** Shared "back to parent" link for the client portal. */
export function BackLink({ href, label, className }: { href: string; label: string; className?: string }) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-2 text-sm text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]${className ? ` ${className}` : ""}`}
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      {label}
    </Link>
  )
}
