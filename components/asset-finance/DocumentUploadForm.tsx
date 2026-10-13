"use client"

import { useRef, useState } from "react"
import { toast } from "sonner"
import type { EntityDocumentType } from "@prisma/client"
import { Button } from "@/components/ui/button"
import { ENTITY_DOCUMENT_LABELS } from "@/lib/asset-finance/labels"
import { SELECT_CLASS } from "./form-fields"

/** Multipart upload of one entity document to `apiBase` (…/documents), filed on `dealId` when given. */
export function DocumentUploadForm({
  apiBase,
  docTypes,
  onUploaded,
  dealId,
}: {
  apiBase: string
  docTypes: readonly EntityDocumentType[]
  onUploaded: () => void
  dealId?: string
}) {
  const [docType, setDocType] = useState<EntityDocumentType | "">("")
  const [uploading, setUploading] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  async function upload() {
    const file = fileInput.current?.files?.[0]
    if (!docType || !file) {
      toast.error("Choose a document type and a file")
      return
    }
    const form = new FormData()
    form.set("docType", docType)
    form.set("file", file)
    if (dealId) form.set("dealId", dealId)
    setUploading(true)
    try {
      const res = await fetch(apiBase, { method: "POST", body: form })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        toast.error(body.error ?? "Upload failed")
        return
      }
      toast.success("Document uploaded")
      setDocType("")
      if (fileInput.current) fileInput.current.value = ""
      onUploaded()
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-dashed border-[var(--cf-border-strong)] bg-[var(--cf-surface-soft)] p-3 sm:flex-row sm:items-end">
      <div className="sm:w-64">
        <label htmlFor="entity-doc-type" className="mb-1.5 block text-xs font-semibold text-[var(--cf-text-secondary)]">
          Document type
        </label>
        <select
          id="entity-doc-type"
          className={SELECT_CLASS}
          value={docType}
          onChange={(e) => setDocType(e.target.value as EntityDocumentType)}
        >
          <option value="">Choose…</option>
          {docTypes.map((t) => (
            <option key={t} value={t}>
              {ENTITY_DOCUMENT_LABELS[t]}
            </option>
          ))}
        </select>
      </div>
      <div className="flex-1">
        <label htmlFor="entity-doc-file" className="mb-1.5 block text-xs font-semibold text-[var(--cf-text-secondary)]">
          File (PDF, JPEG, PNG or WebP, up to 10 MB)
        </label>
        <input
          id="entity-doc-file"
          ref={fileInput}
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp"
          className="block w-full text-sm text-[var(--cf-text-secondary)] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--cf-surface-strong)] file:px-3 file:py-2 file:text-sm file:text-[var(--cf-text)]"
        />
      </div>
      <Button type="button" size="sm" onClick={upload} disabled={uploading}>
        {uploading ? "Uploading…" : "Upload"}
      </Button>
    </div>
  )
}
