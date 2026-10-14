"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import type { EntityDocumentType, PayoutChecklistItemKind } from "@prisma/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SELECT_CLASS } from "@/components/asset-finance/form-fields"
import { FormError, sendJson } from "@/components/asset-finance/register-form-controls"
import { ENTITY_DOCUMENT_LABELS } from "@/lib/asset-finance/labels"

export interface EvidenceOption {
  id: string
  fileName: string
  docType: EntityDocumentType
}

/**
 * Confirms one payout checklist item: the evidence document picked from the
 * deal's own staff uploads of the item's types (none for a signing item), the
 * serial or VIN typed off the supplier invoice where the item asks for it, and
 * an optional note. The route checks all of it; the database again.
 */
export function ChecklistConfirm(props: {
  dealId: string
  item: PayoutChecklistItemKind
  evidenceTypes: readonly EntityDocumentType[]
  documents: readonly EvidenceOption[]
}) {
  const router = useRouter()
  const options = props.documents.filter((d) => props.evidenceTypes.includes(d.docType))
  const [evidence, setEvidence] = useState("")
  const [serial, setSerial] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const needsEvidence = props.evidenceTypes.length > 0
  const needsSerial = props.item === "SUPPLIER_INVOICE_MATCHES_ASSET"

  const confirm = async () => {
    setBusy(true)
    setError(null)
    const result = await sendJson(`/api/asset-finance/deals/${props.dealId}/checklist/${props.item}`, "POST", {
      evidenceDocumentId: needsEvidence ? evidence || null : null,
      attestedSerial: needsSerial ? serial : null,
      note: note || null,
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    router.refresh()
  }

  if (needsEvidence && options.length === 0) {
    return (
      <p className="text-xs text-[var(--cf-text-muted)]">
        Upload the evidence on this deal first ({props.evidenceTypes.map((t) => ENTITY_DOCUMENT_LABELS[t]).join(" or ")}).
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {needsEvidence && (
          <select aria-label="Evidence document" className={`${SELECT_CLASS} max-w-[16rem]`} value={evidence} onChange={(e) => setEvidence(e.target.value)}>
            <option value="">Evidence…</option>
            {options.map((d) => (
              <option key={d.id} value={d.id}>{`${ENTITY_DOCUMENT_LABELS[d.docType]}: ${d.fileName}`}</option>
            ))}
          </select>
        )}
        {needsSerial && (
          <Input aria-label="Serial or VIN as on the invoice" placeholder="Serial / VIN as on the invoice" className="max-w-[14rem]" value={serial} onChange={(e) => setSerial(e.target.value)} />
        )}
        <Input aria-label="Note" placeholder="Note (optional)" className="max-w-[12rem]" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button size="sm" onClick={confirm} disabled={busy || (needsEvidence && !evidence) || (needsSerial && serial.trim() === "")}>
          {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          Confirm
        </Button>
      </div>
      <FormError message={error} />
    </div>
  )
}
