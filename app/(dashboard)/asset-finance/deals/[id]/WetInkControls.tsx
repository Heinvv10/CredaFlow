"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { EntityDocumentType } from "@prisma/client"
import { Button } from "@/components/ui/button"

/**
 * Wet ink for one signer row: upload the signed scan, or — for a scan someone
 * else uploaded — confirm it. The routes enforce both rules; the buttons only
 * avoid offering what would be refused.
 */
export function WetInkControls(props: {
  dealId: string
  signerId: string
  docType: EntityDocumentType
  scanDocumentId: string | null
  canUpload: boolean
  canConfirm: boolean
}) {
  const router = useRouter()
  const file = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const base = `/api/asset-finance/deals/${props.dealId}/signers/${props.signerId}`

  async function send(path: string, body?: BodyInit, success = "Saved") {
    setBusy(true)
    try {
      const res = await fetch(`${base}/${path}`, {
        method: "POST",
        body,
        ...(typeof body === "string" ? { headers: { "Content-Type": "application/json" } } : {}),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(data.error ?? "The request failed")
        return
      }
      toast.success(success)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function upload() {
    const chosen = file.current?.files?.[0]
    if (!chosen) {
      toast.error("Choose the signed scan first")
      return
    }
    const form = new FormData()
    form.set("docType", props.docType)
    form.set("file", chosen)
    await send("wet-ink", form, "Scan recorded; another user must confirm it")
    if (file.current) file.current.value = ""
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {props.canUpload && (
        <>
          <input
            ref={file}
            type="file"
            aria-label="Signed scan"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            className="max-w-[13rem] text-xs text-[var(--cf-text-secondary)] file:mr-2 file:rounded-md file:border-0 file:bg-[var(--cf-surface-strong)] file:px-2 file:py-1 file:text-xs file:text-[var(--cf-text)]"
          />
          <Button type="button" size="sm" variant="outline" onClick={upload} disabled={busy}>
            Upload wet-ink scan
          </Button>
        </>
      )}
      {props.canConfirm && (
        <Button type="button" size="sm" onClick={() => send("confirm", JSON.stringify({ scanDocumentId: props.scanDocumentId }), "Scan confirmed")} disabled={busy}>
          Confirm scan
        </Button>
      )}
    </div>
  )
}
