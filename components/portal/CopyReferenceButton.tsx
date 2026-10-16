"use client"

import { Copy } from "lucide-react"
import { toast } from "@/lib/toast"
import { useT } from "@/lib/i18n/client"

/** Copies a payment reference so the borrower pastes it into their banking app exactly. */
export function CopyReferenceButton({ reference }: { reference: string }) {
  const t = useT("portalPayment")
  return (
    <button
      type="button"
      aria-label={t("copyReferenceAria", { reference })}
      onClick={() => {
        navigator.clipboard.writeText(reference).then(
          () => toast.copied(),
          () => toast.error(t("copyFailed")),
        )
      }}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--cf-border-strong)] px-2.5 py-1 text-xs font-semibold text-[var(--cf-text)] hover:bg-[var(--cf-bg-subtle)]"
    >
      <Copy className="h-3.5 w-3.5" />
      {t("copy")}
    </button>
  )
}
