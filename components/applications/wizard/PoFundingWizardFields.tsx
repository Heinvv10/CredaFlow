"use client"

import { useEffect, useState } from "react"
import { FieldGroup } from "@/components/wizard/FieldGroup"
import { INP } from "./constants"
import type { ApplicationWizardData } from "./types"
import type { ValidationErrors } from "@/lib/validation/application-wizard"

interface ClientDocumentRow {
  id: string
  docType: string
  fileName: string
  createdAt: string
}

/**
 * The purchase order a PO-funding application funds (lib/applications/po-funding.ts):
 * its number, the buyer, and the order document — picked from the client's
 * PO documents or uploaded here as one. prepareApplicationFields enforces the
 * same facts on save.
 */
export function PoFundingWizardFields({
  data,
  patch,
  errors,
}: {
  data: ApplicationWizardData
  patch: (partial: Partial<ApplicationWizardData>) => void
  errors: ValidationErrors<ApplicationWizardData>
}) {
  const [orders, setOrders] = useState<ClientDocumentRow[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState("")
  const clientId = data.clientId

  useEffect(() => {
    if (!clientId) return
    let cancelled = false
    fetch(`/api/clients/${clientId}/documents`)
      .then((res) => (res.ok ? res.json() : []))
      .then((docs: ClientDocumentRow[]) => {
        if (!cancelled && Array.isArray(docs)) setOrders(docs.filter((d) => d.docType === "PO_DOCUMENT"))
      })
      .catch(() => {
        if (!cancelled) setOrders([])
      })
    return () => { cancelled = true }
  }, [clientId])

  async function upload(file: File) {
    setUploading(true)
    setUploadError("")
    try {
      const form = new FormData()
      form.append("file", file)
      form.append("docType", "PO_DOCUMENT")
      form.append("clientId", clientId)
      const res = await fetch("/api/documents", { method: "POST", body: form })
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string }
      if (!res.ok || typeof body.id !== "string") {
        setUploadError(body.error ?? "The purchase order could not be uploaded.")
        return
      }
      const id = body.id
      setOrders((current) => [{ id, docType: "PO_DOCUMENT", fileName: file.name, createdAt: new Date().toISOString() }, ...current])
      patch({ poDocumentId: id })
    } catch {
      setUploadError("Network error while uploading the purchase order.")
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-[var(--cf-border-subtle)] p-4">
      <p className="text-xs text-[var(--cf-text-muted)]">
        Purchase order funding is business credit repaid from the buyer&apos;s payment. Record the order it funds.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FieldGroup label="Purchase order number" required error={errors.poNumber}>
          <input id="poNumber" className={INP} maxLength={64} value={data.poNumber}
            onChange={(e) => patch({ poNumber: e.target.value })} />
        </FieldGroup>
        <FieldGroup label="Buyer (who issued the order)" required error={errors.poBuyerName}>
          <input id="poBuyerName" className={INP} maxLength={200} value={data.poBuyerName}
            onChange={(e) => patch({ poBuyerName: e.target.value })} />
        </FieldGroup>
      </div>
      <FieldGroup label="Purchase order document" required error={errors.poDocumentId || uploadError || undefined}>
        <div className="space-y-2">
          <select id="poDocumentId" className={INP} value={data.poDocumentId}
            onChange={(e) => patch({ poDocumentId: e.target.value })}>
            <option value="">{orders.length === 0 ? "No purchase order on file yet" : "Choose the client's purchase order…"}</option>
            {orders.map((d) => <option key={d.id} value={d.id}>{d.fileName}</option>)}
          </select>
          <input id="poDocumentUpload" type="file" accept="application/pdf,image/jpeg,image/png" disabled={uploading}
            className="text-sm" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f) }} />
          {uploading && <p className="text-xs text-[var(--cf-text-muted)]">Uploading…</p>}
        </div>
      </FieldGroup>
    </div>
  )
}
