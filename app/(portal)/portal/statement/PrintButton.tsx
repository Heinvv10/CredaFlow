"use client"

import { useT } from "@/lib/i18n/client"

export function PrintButton() {
  const t = useT("portalStatement")
  return (
    <button
      className="px-3 py-1.5 rounded border text-xs font-semibold print:hidden"
      style={{ borderColor: "#4338CA", color: "#4338CA" }}
      onClick={() => window.print()}
    >
      {t("print")}
    </button>
  )
}
