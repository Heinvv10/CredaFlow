"use client"

import { useT } from "@/lib/i18n/client"

export interface PoFundingInput {
  poNumber: string
  poBuyerName: string
  poFile: File | null
}

export const EMPTY_PO_INPUT: PoFundingInput = { poNumber: "", poBuyerName: "", poFile: null }

/** Mirrors the server's rule (lib/applications/po-funding.ts) so submit waits for every fact. */
export function poInputComplete(po: PoFundingInput): boolean {
  return po.poNumber.trim().length >= 1 && po.poBuyerName.trim().length >= 2 && po.poFile !== null
}

/**
 * Uploads the purchase order as the client's PO_DOCUMENT and returns its id,
 * or the server's error. The application then names that document.
 */
export async function uploadPoDocument(file: File): Promise<{ id: string } | { error: string }> {
  const form = new FormData()
  form.append("file", file)
  form.append("docType", "PO_DOCUMENT")
  const res = await fetch("/api/documents", { method: "POST", body: form })
  const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string }
  if (!res.ok || typeof data.id !== "string") return { error: data.error ?? "" }
  return { id: data.id }
}

export function PoFundingFields({
  value,
  onChange,
  inputClass,
  labelClass,
}: {
  value: PoFundingInput
  onChange: (next: PoFundingInput) => void
  inputClass: string
  labelClass: string
}) {
  const t = useT("portalApply")
  return (
    <div className="space-y-5 rounded-lg border border-gray-100 p-4">
      <p className="text-xs text-gray-500">{t("poBusinessOnly")}</p>
      <div>
        <label htmlFor="poNumber" className={labelClass}>{t("poNumberLabel")}</label>
        <input id="poNumber" value={value.poNumber} maxLength={64} required className={inputClass}
          onChange={(e) => onChange({ ...value, poNumber: e.target.value })} />
      </div>
      <div>
        <label htmlFor="poBuyerName" className={labelClass}>{t("poBuyerLabel")}</label>
        <input id="poBuyerName" value={value.poBuyerName} maxLength={200} required className={inputClass}
          onChange={(e) => onChange({ ...value, poBuyerName: e.target.value })} />
      </div>
      <div>
        <label htmlFor="poDocument" className={labelClass}>{t("poDocumentLabel")}</label>
        <input id="poDocument" type="file" accept="application/pdf,image/jpeg,image/png" required className="text-sm"
          onChange={(e) => onChange({ ...value, poFile: e.target.files?.[0] ?? null })} />
      </div>
    </div>
  )
}
