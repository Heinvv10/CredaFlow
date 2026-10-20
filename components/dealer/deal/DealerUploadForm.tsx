"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import type { EntityDocumentType } from "@prisma/client"
import { Button } from "@/components/ui/button"
import { SELECT_CLASS } from "@/components/asset-finance/form-fields"
import { ENTITY_DOCUMENT_LABELS } from "@/lib/asset-finance/labels"

/**
 * Multipart upload of one document on the dealer's deal. With `requestId` it
 * answers that document request (its type fixed). Refreshes the page after.
 */
export function DealerUploadForm({ dealId, docTypes, requestId, idPrefix }: {
  dealId: string
  docTypes: readonly EntityDocumentType[]
  requestId?: string
  idPrefix: string
}) {
  const router = useRouter()
  const [docType, setDocType] = useState<EntityDocumentType | "">(docTypes.length === 1 ? docTypes[0] : "")
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  async function upload() {
    const file = fileInput.current?.files?.[0]
    if (!docType || !file) return setError("Choose a document type and a file")
    const form = new FormData()
    form.set("docType", docType)
    form.set("file", file)
    const url = `/api/dealer/deals/${dealId}/documents${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ""}`
    setUploading(true)
    setError(null)
    try {
      const res = await fetch(url, { method: "POST", body: form })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? `Upload failed (${res.status})`)
        return
      }
      if (fileInput.current) fileInput.current.value = ""
      if (docTypes.length > 1) setDocType("")
      router.refresh()
    } catch {
      setError("Network error. Try again.")
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-3 rounded-md border border-dashed border-[var(--cf-border-strong)] bg-[var(--cf-surface-soft)] p-3 sm:flex-row sm:items-end">
        {docTypes.length > 1 ? (
          <div className="sm:w-64">
            <label htmlFor={`${idPrefix}-type`} className="mb-1.5 block text-xs font-semibold text-[var(--cf-text-secondary)]">Document type</label>
            <select id={`${idPrefix}-type`} className={SELECT_CLASS} value={docType} onChange={(e) => setDocType(e.target.value as EntityDocumentType)}>
              <option value="">Choose…</option>
              {docTypes.map((t) => <option key={t} value={t}>{ENTITY_DOCUMENT_LABELS[t]}</option>)}
            </select>
          </div>
        ) : null}
        <div className="flex-1">
          <label htmlFor={`${idPrefix}-file`} className="mb-1.5 block text-xs font-semibold text-[var(--cf-text-secondary)]">
            {docTypes.length === 1 ? ENTITY_DOCUMENT_LABELS[docTypes[0]] : "File"} (PDF, JPEG, PNG or WebP, up to 10 MB)
          </label>
          <input
            id={`${idPrefix}-file`} ref={fileInput} type="file" accept="application/pdf,image/jpeg,image/png,image/webp"
            className="block w-full text-sm text-[var(--cf-text-secondary)] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--cf-surface-strong)] file:px-3 file:py-2 file:text-sm file:text-[var(--cf-text)]"
          />
        </div>
        <Button type="button" size="sm" onClick={upload} disabled={uploading}>{uploading ? "Uploading…" : "Upload"}</Button>
      </div>
      {error ? <p role="alert" className="text-xs text-[var(--cf-danger)]">{error}</p> : null}
    </div>
  )
}
