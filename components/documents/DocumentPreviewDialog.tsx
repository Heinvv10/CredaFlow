"use client"

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { AlertTriangle, Download, Loader2 } from "lucide-react"
import type { DocumentRecord } from "@/lib/document-types"
import { DOC_TYPE_LABELS } from "@/lib/document-types"

interface Props {
  doc: DocumentRecord
  open: boolean
  onOpenChange: (open: boolean) => void
}

type PreviewState =
  | { kind: "loading" }
  | { kind: "ready"; objectUrl: string }
  | { kind: "refused"; message: string }

// The view endpoint answers with a JSON refusal (401/403/422) when a
// document may not be served — e.g. a credit agreement missing its
// integrity binding. Pointing an <iframe> straight at the endpoint painted
// that raw JSON into the preview pane, which staff read as a corrupted
// document. Fetching first lets a refusal render as a readable message.
export function DocumentPreviewBody({ doc, open }: { doc: DocumentRecord; open: boolean }) {
  const [state, setState] = useState<PreviewState>({ kind: "loading" })
  const viewUrl = `/api/documents/${doc.id}/view`
  const isImage = doc.mimeType?.startsWith("image/")

  useEffect(() => {
    if (!open) return
    let cancelled = false
    let objectUrl: string | null = null
    // Re-opening for another document must not show the previous result.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ kind: "loading" })
    ;(async () => {
      try {
        const res = await fetch(viewUrl)
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          if (!cancelled) {
            setState({
              kind: "refused",
              message:
                typeof body?.error === "string" && body.error.trim() !== ""
                  ? body.error
                  : `This document cannot be displayed right now (HTTP ${res.status}).`,
            })
          }
          return
        }
        const blob = await res.blob()
        objectUrl = URL.createObjectURL(blob)
        if (cancelled) {
          URL.revokeObjectURL(objectUrl)
          return
        }
        setState({ kind: "ready", objectUrl })
      } catch {
        if (!cancelled) {
          setState({ kind: "refused", message: "Network error while loading the document. Please try again." })
        }
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [open, viewUrl])

  if (state.kind === "loading") {
    return (
      <div className="flex h-[65vh] items-center justify-center text-gray-400">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    )
  }
  if (state.kind === "refused") {
    return (
      <div className="flex h-[65vh] items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-amber-300 bg-amber-50 p-4 text-center">
          <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-amber-600" />
          <p className="text-sm font-semibold text-amber-800">Document cannot be displayed</p>
          <p className="mt-1 text-sm text-amber-700">{state.message}</p>
        </div>
      </div>
    )
  }
  return isImage ? (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={state.objectUrl}
      alt={doc.fileName}
      className="w-full h-auto rounded"
    />
  ) : (
    <iframe
      src={state.objectUrl}
      title={doc.fileName}
      className="w-full h-[65vh] rounded border"
    />
  )
}

export function DocumentPreviewDialog({ doc, open, onOpenChange }: Props) {
  const downloadUrl = `/api/documents/${doc.id}/view?download=1`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh]">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle>
              {DOC_TYPE_LABELS[doc.docType] || doc.docType} — {doc.fileName}
            </DialogTitle>
            <a href={downloadUrl}>
              <Button variant="outline" size="sm">
                <Download className="h-3 w-3 mr-1" />
                Download
              </Button>
            </a>
          </div>
        </DialogHeader>
        <div className="overflow-auto max-h-[70vh]">
          <DocumentPreviewBody doc={doc} open={open} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
